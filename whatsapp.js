import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Dossier où la session (auth) est persistée. Sur Render, pointez-le
// vers un disque attaché (ex. /auth) pour ne pas tout relier à chaque déploiement.
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth')
// Ton numéro (format international, chiffres uniquement)
const MY_PHONE = (process.env.MY_PHONE_NUMBER || '').replace(/[^0-9]/g, '')
// Optionnel : liste blanche de numéros autorisés à dialoguer avec le bot
const ALLOWED_FROM = (process.env.ALLOWED_FROM || '')
  .split(',')
  .map((s) => s.replace(/[^0-9]/g, ''))
  .filter(Boolean)
// Version de repli si la récupération en ligne échoue
const FALLBACK_VERSION = [2, 3000, 100]

let sock = null
let state = null
let stopping = false
let reconnectAttempts = 0
let pairingCode = null

const silent = pino({ level: 'silent' })

/** Le bot est-il lié au compte WhatsApp ? */
export const isLinked = () => Boolean(state?.creds?.registered)
/** Dernier code d'appairage généré (sinon null) */
export const getPairingCode = () => pairingCode
export const authDir = () => AUTH_DIR

const MIMES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
}

/**
 * Envoie un message texte.
 * @param {string} to JID (ex: 22901234567@s.whatsapp.net) ou numéro seul
 * @param {string} body contenu
 */
export async function sendMessage(to, body) {
  if (!sock || !isLinked()) throw new Error('Bot non lié — passez par /pair')
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  await sock.sendMessage(jid, { text: body })
}

/**
 * Envoie un fichier vidéo local comme média WhatsApp.
 * @param {string} to    JID destinataire
 * @param {string} filePath chemin local de la vidéo
 * @param {string} caption légende affichée
 */
export async function sendVideo(to, filePath, caption = '') {
  if (!sock || !isLinked()) throw new Error('Bot non lié — passez par /pair')
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  const ext = path.extname(filePath).slice(1).toLowerCase()
  await sock.sendMessage(jid, {
    url: filePath, // Baileys lit le fichier local
    caption,
    mimetype: MIMES[ext] || 'video/mp4',
    fileName: path.basename(filePath),
  })
}

/** Demande un nouveau code d'appairage au serveur WhatsApp. */
export async function requestNewPairingCode() {
  if (!sock) throw new Error('Socket non initialisé')
  if (!MY_PHONE) throw new Error('MY_PHONE_NUMBER non défini dans les variables d’environnement')
  pairingCode = await sock.requestPairingCode(MY_PHONE)
  return pairingCode
}

async function buildSocket() {
  const { state: st, saveCreds: sc } = await useMultiFileAuthState(AUTH_DIR)
  state = st

  let version
  try {
    ;({ version } = await fetchLatestBaileysVersion())
  } catch {
    version = FALLBACK_VERSION
  }

  const s = makeWASocket({
    version,
    logger: silent,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silent),
    },
  })

  // Persiste la session à chaque mise à jour (crucial après l'appairage)
  s.ev.on('creds.update', sc)

  s.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    const status = lastDisconnect?.error?.output?.statusCode

    if (connection === 'open') {
      reconnectAttempts = 0
      if (!state.creds.registered) {
        if (!MY_PHONE) {
          console.error('⚠️ Session non liée et MY_PHONE_NUMBER absent — impossible de demander un code.')
          return
        }
        try {
          pairingCode = await s.requestPairingCode(MY_PHONE)
          console.log('🔑 Code d’appairage généré (visitez /pair)')
        } catch (err) {
          console.error('❌ Erreur lors de la génération du code :', err.message)
        }
      } else {
        console.log('✅ Connecté et lié au compte WhatsApp')
      }
    } else if (connection === 'close') {
      if (status === DisconnectReason.loggedOut) {
        console.log('👋 Déconnexion (loggedOut) : réinitialisation de la session')
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        } catch {}
        state = null
        pairingCode = null
      }
      if (!stopping) {
        reconnectAttempts += 1
        const delay = Math.min(30_000, 2000 * reconnectAttempts)
        console.log(`⏳ Reconnexion dans ${Math.round(delay / 1000)} s (tentative ${reconnectAttempts})`)
        setTimeout(() => {
          if (stopping) return
          buildSocket()
            .then((s2) => {
              sock = s2
            })
            .catch((err) => console.error('❌ Échec de la reconnexion :', err.message))
        }, delay)
      }
    }
  })

  // 📨 Messages entrants
  s.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (!m || !m.key || m.key.fromMe) continue
        const jid = m.key.remoteJid
        if (!jid || jid === 'status@broadcast') continue

        const text = m.message?.conversation || m.message?.extendedTextMessage?.text
        if (!text) {
          try {
            await sendMessage(jid, "🤖 Pour l'instant je ne peux traiter que les messages texte.")
          } catch {}
          continue
        }

        // Liste blanche optionnelle
        const number = jid.split('@')[0]
        if (ALLOWED_FROM.length && !ALLOWED_FROM.includes(number)) continue

        const { handleMessage } = await import('./bot.js')
        await handleMessage(jid, text)
      } catch (err) {
        console.error('❌ Erreur de traitement du message :', err.message)
      }
    }
  })

  return s
}

/** Démarre la connexion (à l'initialisation du serveur). */
export async function init() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  sock = await buildSocket()
}

/** Arrête proprement la connexion. */
export async function stop() {
  stopping = true
  try {
    sock?.end()
  } catch {}
  sock = null
}

/** Redémarre la connexion (utilisé après /restore). */
export async function restart() {
  stopping = false
  try {
    sock?.end()
  } catch {}
  sock = null
  await init()
}

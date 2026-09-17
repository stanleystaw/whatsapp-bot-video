import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
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
// Sauvegarde "live" de la session saine (auto-restaure après coupure),
// sur le même disque mais en dehors du dossier de session.
const BACKUP_DIR = process.env.AUTH_BACKUP_DIR || path.join(path.dirname(AUTH_DIR), 'auth-backup')
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
let pairingCode = null
let latestQr = null // dernier payload QR émis par Baileys (rotation ~20 s)
let qrSeen = 0 // nombre de QR observés (diagnostic)
let connected = false // socket WebSocket ouvert ?
let rebuilding = false // watchdog : reconstruction en cours ?
let buildStartedAt = 0 // horodatage du build en cours (anti-blocage)
let lastCloseStatus = null // dernier status de fermeture (diagnostic)
const seenMsgs = new Map() // key.id -> ts (anti-doublon messages.upsert)

// 🩺 Auto-restaure : si la connexion revient en mode QR (session morte côté
// WhatsApp, timeout 408…) alors qu'une sauvegarde saine existe, on la
// restaure tout seul — sans intervention de l'utilisateur.
let qrSinceTs = 0 // depuis quand le socket est ouvert MAIS non lié (mode QR)
let lastAutoRestore = 0
let lastSnapshot = 0
let resetGuard = false // /reset demandé → pas d'auto-restaure tant que non relié

const hasBackup = () => {
  try { return fs.existsSync(path.join(BACKUP_DIR, 'creds.json')) } catch { return false }
}

// Copie la session courante (saine : lié + connecté) vers BACKUP_DIR.
function snapshotAuth() {
  if (!isLinked() || !connected) return
  if (Date.now() - lastSnapshot < 10 * 60 * 1000) return
  try {
    const tmp = BACKUP_DIR + '.tmp'
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.cpSync(AUTH_DIR, tmp, { recursive: true })
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
    fs.renameSync(tmp, BACKUP_DIR)
    lastSnapshot = Date.now()
    console.log('💾 Sauvegarde live de la session →', BACKUP_DIR)
  } catch (e) {
    console.warn('⚠️ Sauvegarde live impossible :', e.message)
  }
}

// Restaure BACKUP_DIR sur AUTH_DIR et relance le socket.
async function autoRestore() {
  if (Date.now() - lastAutoRestore < 5 * 60 * 1000) return false
  if (resetGuard || !hasBackup()) return false
  lastAutoRestore = Date.now()
  console.log('🩺 Auto-restaure : récupération de la session sauvegardée…')
  try {
    stopping = true
    try { sock?.end() } catch {}
    sock = null
    const tmp = AUTH_DIR + '.swp'
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.cpSync(BACKUP_DIR, tmp, { recursive: true })
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    fs.renameSync(tmp, AUTH_DIR)
    state = null
    pairingCode = null
    connected = false
    qrSinceTs = 0
    stopping = false
    await restart()
    console.log('✅ Auto-restaure terminée — reconnexion en cours')
    return true
  } catch (e) {
    console.error('❌ Auto-restaure échouée :', e.message)
    return false
  }
}

const silent = pino({ level: 'silent' })

/** Le bot est-il lié au compte WhatsApp ? */
export const isLinked = () => Boolean(state?.creds?.me || state?.creds?.registered)
/** Le socket est-il connecté (WebSocket ouvert) ? */
export const isConnected = () => connected
/** État RÉEL du WebSocket (ouvert même pendant la phase QR,
 * avant que l'événement 'open' de Baileys ne soit émis). */
export const isWsAlive = () => Boolean(sock?.ws?.isOpen)
/** Dernier code d'appairage généré (sinon null) */
export const getPairingCode = () => pairingCode
/** Dernier payload QR (pour l'afficher scannable) */
export const getLatestQr = () => latestQr
export const authDir = () => AUTH_DIR

/** État détaillé pour le diagnostic (endpoint /status). */
export function getDiagnostics() {
  return {
    time: new Date().toISOString(),
    linked: isLinked(),
    connected,
    wsState: sock?.ws
      ? sock.ws.isOpen
        ? 'open'
        : sock.ws.isConnecting
          ? 'connecting'
          : sock.ws.isClosing
            ? 'closing'
            : 'closed'
      : null,
    hasQr: Boolean(latestQr),
    qrSeen,
    hasMe: Boolean(state?.creds?.me),
    hasFfmpeg: (() => {
      try {
        const p = createRequire(import.meta.url)('ffmpeg-static')
        return typeof p === 'string' && fs.existsSync(p)
      } catch {
        return false
      }
    })(),
    diskFreeMB: (() => {
      try {
        const s = fs.statfsSync(AUTH_DIR)
        return Math.round((s.bavail * s.bsize) / 1048576)
      } catch {
        return null
      }
    })(),
    pairingCodeReady: Boolean(pairingCode),
    myPhoneSet: MY_PHONE.length > 0,
    myPhone: MY_PHONE ? MY_PHONE.replace(/^(\d{3})\d+(\d{3})$/, '$1 *** $2') : null,
    rebuilding,
    lastCloseStatus,
    authDir: AUTH_DIR,
    hasAuth: fs.existsSync(AUTH_DIR),
    uptimeSec: Math.round(process.uptime()),
    autoRestore: {
      backupExists: hasBackup(),
      lastSnapshot: lastSnapshot || null,
      lastAutoRestore: lastAutoRestore || null,
      qrModeSinceSec: qrSinceTs ? Math.round((Date.now() - qrSinceTs) / 1000) : null,
    },
  }
}

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
    video: { url: filePath }, // chemin local — Baileys stream depuis le disque
    caption,
    mimetype: MIMES[ext] || 'video/mp4',
  })
}

/**
 * Envoie un fichier (vidéo volumineuse) en DOCUMENT — WhatsApp accepte
 * jusqu'à ~2 Go. Le destinataire reçoit un fichier téléchargeable/lectible.
 */
export async function sendDocument(to, filePath, mimetype = 'video/mp4', caption = '') {
  if (!sock || !isLinked()) throw new Error('Bot non lié — passez par /pair')
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  await sock.sendMessage(jid, {
    document: { url: filePath }, // chemin local — stream disque (mémoire minime)
    mimetype,
    fileName: path.basename(filePath),
    caption,
  })
}

/**
 * Demande un code d'appairage au serveur WhatsApp.
 * Attend d'abord que le socket soit ouvert (après un réveil du service,
 * la reconnexion peut prendre quelques secondes).
 */
export async function requestNewPairingCode(timeoutMs = 20_000) {
  if (!MY_PHONE) throw new Error('MY_PHONE_NUMBER non défini dans les variables d’environnement')
  // Baileys v7 : sock.ws est un wrapper → properties isOpen/isConnecting/isClosed
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sock?.ws?.isOpen) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (!sock?.ws?.isOpen) {
    throw new Error('Service en reconnexion (réveil du serveur) — rechargez /pair dans 30 s')
  }
  pairingCode = await sock.requestPairingCode(MY_PHONE)
  return pairingCode
}

async function buildSocket() {
  const { state: st, saveCreds: sc } = await useMultiFileAuthState(AUTH_DIR)
  state = st

  let version
  try {
    ;({ version } = await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(10_000) }))
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

  s.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    const status = lastDisconnect?.error?.output?.statusCode

    // Baileys émet le QR automatiquement (rotation ~20 s) quand non lié
    if (qr) {
      latestQr = qr
      qrSeen++
      console.log('📷 QR émis (n°' + qrSeen + ') — scannable sur /qr')
    }

    if (connection === 'open') {
      connected = true
      if (!state.creds.registered) {
        console.log(' Connecté (non lié) — QR disponible sur /qr, code sur /pair')
        if (!MY_PHONE) {
          console.warn('⚠️ MY_PHONE_NUMBER absent : le mode « code d’appairage » (/pair) sera indisponible')
        }
      } else {
        console.log('✅ Connecté et lié au compte WhatsApp')
      }
    } else if (connection === 'close') {
      connected = false
      latestQr = null // un QR ne sert à rien si le socket est mort
      lastCloseStatus = status ?? 'inconnu'
      if (status === DisconnectReason.loggedOut) {
        console.log('👋 Déconnexion (loggedOut) : réinitialisation de la session')
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        } catch {}
        state = null
        pairingCode = null
      } else {
        console.log(`⚠️ Connexion fermée (status ${status ?? 'inconnu'}) — le watchdog relancera la reconnexion`)
      }
      // La reconnexion est gérée par le watchdog ci-dessous (une seule
      // mécanique, sans risque de double socket).
    }
  })

  // 📨 Messages entrants
  s.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (!m || !m.key || m.key.fromMe) continue
        // Anti-doublon : Baileys peut ré-émettre le même message (même key.id)
        const mid = m.key.id
        if (mid) {
          const seen = seenMsgs.get(mid)
          if (seen && Date.now() - seen < 120_000) continue
          seenMsgs.set(mid, Date.now())
          if (seenMsgs.size > 500) {
            for (const [k, t] of seenMsgs) if (Date.now() - t > 120_000) seenMsgs.delete(k)
          }
        }
        const jid = m.key.remoteJid
        if (!jid || jid === 'status@broadcast') continue

        // Déballage des messages éphémères / one-time (contenu imbriqué)
        let msg = m.message
        if (msg?.ephemeralMessage?.message) msg = msg.ephemeralMessage.message
        if (msg?.viewOnceMessage?.message) msg = msg.viewOnceMessage.message
        const text = msg?.conversation || msg?.extendedTextMessage?.text
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

/** Efface la session (appairage) et relance le socket — endpoint /reset. */
export async function resetAuth() {
  stopping = false
  try {
    sock?.end()
  } catch {}
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
  } catch {}
  // Garde-fou : pas d'auto-restaure tant qu'un nouvel appairage n'a pas abouti
  resetGuard = true
  qrSinceTs = 0
  state = null
  pairingCode = null
  connected = false
  sock = null
  await init()
}

// ---------------------------------------------------------------------
// 🩺 Watchdog : si le socket meurt (sommeil Render, coupure réseau,
// gel du process…), on reconstruit la connexion toutes les 10 s.
// ---------------------------------------------------------------------
setInterval(() => {
  if (stopping) return
  const ws = sock?.ws
  // Baileys v7 : wrapper avec isOpen / isConnecting / isClosed / isClosing
  const active = Boolean(ws && (ws.isOpen || ws.isConnecting))

  // 💾 Sauvegarde live de la session saine (pour l'auto-restaure)
  if (sock && active && isLinked()) {
    resetGuard = false // appairage abouti → on lève le garde-fou
    qrSinceTs = 0
    snapshotAuth()
    return
  }

  // 🩺 Socket ouvert mais NON lié (mode QR) depuis >90 s → la session du
  // disque est morte côté WhatsApp. On restaure la sauvegarde saine.
  if (sock && active && !isLinked()) {
    if (!qrSinceTs) qrSinceTs = Date.now()
    if (Date.now() - qrSinceTs > 90_000 && hasBackup()) {
      qrSinceTs = 0
      console.log('🩺 Watchdog : session morte (mode QR) — auto-restaure…')
      autoRestore().catch((e) => console.error('❌ Auto-restaure :', e.message))
    }
    return
  }

  if (sock && active) return // en cours ou ouvert → on n'y touche pas
  if (rebuilding) {
    // Build précédent bloqué depuis plus de 90 s (fetch version, réseau…)
    // → on le considère mort et on relance.
    if (Date.now() - buildStartedAt > 90_000) {
      console.log('⚠️ Watchdog : build précédent bloqué (>90 s) — forçage du retry')
      rebuilding = false
    } else {
      return
    }
  }
  rebuilding = true
  buildStartedAt = Date.now()
  console.log('🩺 Watchdog : socket absent ou fermé — reconstruction de la connexion…')
  try {
    sock?.end()
  } catch {}
  buildSocket()
    .then((s2) => {
      sock = s2
    })
    .catch((err) => console.error('❌ Watchdog : échec de reconstruction :', err.message))
    .finally(() => {
      rebuilding = false
    })
}, 10_000)

// Module de téléchargement vidéo via yt-dlp (binaire autonome, sans Python).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(__dirname, 'bin', 'yt-dlp')
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
// Dossier de travail temporaire (effacé à chaque redémarrage du service)
const DL_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'wabo-'))
// Limite réaliste pour un média vidéo WhatsApp (~16 Mo)
const MAX_SIZE = 15 * 1024 * 1024
// API de secours (testée ✅ YouTube vidéo/audio, Facebook) — servie par un tiers.
// Mettre vide pour la désactiver.
const FALLBACK_API = (process.env.DOWNLOAD_API || 'https://apischristus.vercel.app/api/auto').trim()

// Échelle de formats : on commence par du 480p mp4 (léger, lisible partout),
// puis on descend si le fichier dépasse la limite.
const FORMATS = [
  'b[ext=mp4][height<=480]',
  'b[ext=mp4][height<=360]',
  'b[height<=480]',
  'b',
]

let ensured = false

// ---------------------------------------------------------------------
// Cookies YouTube (optionnel) — contournement de la vérification anti-bot
// Variable d'environnement YOUTUBE_COOKIES : texte Netscape (cookies.txt)
// en clair OU en base64.
// ---------------------------------------------------------------------
const cookieFile = path.join(DL_DIR, 'yt-cookies.txt')

function writeCookieFile() {
  const v = (process.env.YOUTUBE_COOKIES || '').trim()
  if (!v) return null
  let content = v
  const compact = v.replace(/\s+/g, '')
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
    try {
      const dec = Buffer.from(compact, 'base64').toString('utf8')
      if (dec.includes('youtube.com') || dec.startsWith('#')) content = dec
    } catch {}
  }
  try {
    fs.writeFileSync(cookieFile, content)
    return cookieFile
  } catch (err) {
    console.warn('⚠️ Échec écriture cookies :', err.message)
    return null
  }
}

/** Arguments cookies pour les URLs YouTube uniquement. */
function ytCookiesArgs(url) {
  if (!/youtube\.com|youtu\.be/i.test(url)) return []
  const f = writeCookieFile()
  return f ? ['--cookies', f] : []
}

/** Installe yt-dlp si le binaire n'est pas présent (au build OU au runtime). */
export async function ensureYtDlp() {
  if (ensured && fs.existsSync(BIN)) return
  if (!fs.existsSync(BIN)) {
    console.log('⬇️ Téléchargement de yt-dlp (runtime)…')
    const res = await fetch(YTDLP_URL, { redirect: 'follow' })
    if (!res.ok) throw new Error(`Impossible de télécharger yt-dlp (HTTP ${res.status})`)
    fs.mkdirSync(path.dirname(BIN), { recursive: true })
    fs.writeFileSync(BIN, Buffer.from(await res.arrayBuffer()))
    fs.chmodSync(BIN, 0o755)
    console.log('✅ yt-dlp installé')
  }
  ensured = true
}

/** Lance yt-dlp avec une liste d'arguments (pas de shell → pas d'injection). */
function run(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('Téléchargement trop long (timeout)'))
    }, timeoutMs)
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error('yt-dlp introuvable — relancez le build (npm install)'))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ out, err })
      const m = err.match(/ERROR:\s*(.+?)(?:\n|$)/)
      let msg = m ? m[1].trim() : `yt-dlp a échoué (code ${code})`
      if (/Sign in to confirm/i.test(msg)) {
        msg =
          "YouTube bloque les téléchargements depuis le serveur (vérification anti-bot). " +
          "Solution : définir la variable YOUTUBE_COOKIES (voir README §6) ou utiliser un lien d'un autre réseau (TikTok, Facebook…)."
      }
      reject(new Error(msg))
    })
  })
}

/**
 * Recherche des vidéos (source : YouTube via ytsearch).
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<{id,title,duration,url}>>}
 */
export async function searchVideos(query, limit = 5) {
  await ensureYtDlp()
  const { out } = await run([
    `ytsearch${limit}:${query}`,
    '--flat-playlist',
    '--no-warnings',
    '--print', '%(id)s\t%(title)s\t%(duration)s\t%(url)s',
  ])
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((a) => a.length >= 4 && a[1] && a[3])
    .map(([id, title, dur, url]) => ({ id, title: title.trim(), duration: dur || '', url }))
}

/**
 * Télécharge une URL en streaming vers un fichier local.
 * Coupe le téléchargement si la taille dépasse maxBytes.
 * @returns {Promise<{path, size} | {tooBig: true}>}
 */
async function fetchToFile(url, dest, maxBytes) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} sur le lien média`)
  const out = fs.createWriteStream(dest)
  let total = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        out.destroy()
        return { tooBig: true }
      }
      if (!out.write(value)) await new Promise((r) => out.once('drain', r))
    }
  } finally {
    out.end()
  }
  await new Promise((resolve, reject) => {
    out.once('finish', resolve)
    out.once('error', reject)
  })
  return { path: dest, size: total }
}

/**
 * Tentative via l'API de secours (tiers) : /api/auto?url=...
 * Renvoie null si l'API échoue (le bot retombe sur l'erreur locale).
 */
async function tryFallbackApi(url) {
  if (!FALLBACK_API) return null
  try {
    const res = await fetch(`${FALLBACK_API}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(90_000),
    })
    const j = await res.json().catch(() => null)
    if (!j?.success) return null
    // L'API renvoie : { mp4 } OU { video } OU { medias: [{label, url}] }
    const video =
      j.mp4 ||
      j.video ||
      j.medias?.find((m) => m?.type === 'video')?.url ||
      j.medias?.find((m) => /video|mp4/i.test(`${m?.label || ''} ${m?.url || ''}`))?.url ||
      j.medias?.[0]?.url
    if (!video) return null
    const dest = path.join(DL_DIR, `api_${Date.now()}.mp4`)
    const r = await fetchToFile(video, dest, MAX_SIZE)
    if (r.tooBig) {
      fs.rmSync(dest, { force: true })
      return { tooBig: true, url }
    }
    return { path: r.path, title: j.title || '', size: r.size }
  } catch (err) {
    console.warn('⚠️ API de secours indisponible :', err.message)
    return null
  }
}

/**
 * Télécharge une vidéo depuis un lien direct (YouTube, TikTok, Facebook,
 * Instagram, X, Dailymotion, Vimeo… — tout ce que supporte yt-dlp).
 *
 * @returns {Promise<{path,title,size} | {tooBig:true,url}>}
 */
export async function downloadVideo(url) {
  await ensureYtDlp()
  let lastError = null
  let sawTooBig = false

  for (const fmt of FORMATS) {
    try {
      const { out } = await run([
        ...ytCookiesArgs(url),
        '-f', fmt,
        '--no-playlist',
        '--no-warnings',
        '--retries', '3',
        '--socket-timeout', '20',
        '-o', path.join(DL_DIR, '%(id)s.%(ext)s'),
        '--print', 'after_move:filepath',
        '--print', 'after_move:title',
        url,
      ])
      const lines = out.trim().split('\n')
      const filePath = lines[0].trim()
      const title = lines.slice(1).join('\n').trim()

      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('Fichier introuvable après téléchargement')
      }
      const size = fs.statSync(filePath).size
      if (size > MAX_SIZE) {
        fs.rmSync(filePath, { force: true })
        sawTooBig = true
        lastError = new Error('Vidéo trop volumineuse pour WhatsApp (max ~15 Mo)')
        continue // on tente un format plus petit
      }
      return { path: filePath, title, size }
    } catch (err) {
      const msg = String(err?.message || '')
      lastError = err
      // Erreur "réelle" (lien invalide, vidéo privée/indisponible, site non
      // supporté, blocage anti-bot…) → on stoppe l'échelle de formats
      if (/unsupported url|private video|is not a valid URL|Inappropriate|not exist|unavailable|removed|deleted|private|unable to extract|is an unsupported|timeout|Sign in to confirm|login (is )?(required|needed)|blocked by/i.test(msg)) {
        break
      }
    }
  }

  if (sawTooBig) return { tooBig: true, url }

  // Échelle locale épuisée (anti-bot, site bloqué…) → API de secours
  console.log('↪️  yt-dlp local en échec, tentative via l’API de secours…')
  const fb = await tryFallbackApi(url)
  if (fb) return fb

  throw lastError || new Error('Échec du téléchargement')
}

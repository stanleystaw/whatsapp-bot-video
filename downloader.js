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
// ≤ 15 Mo : envoyé comme VIDÉO (lecture directe) ;
// > 15 Mo : envoyé comme FICHIER (document) — épisode complet d'anime OK.
export const VIDEO_LIMIT = 15 * 1024 * 1024
// Plafond total en mode fichier (disque free Render = 512 Mo)
const DOC_LIMIT = (Number(process.env.DOC_LIMIT_MB) || 180) * 1024 * 1024
// API de secours (testée ✅ YouTube vidéo/audio, Facebook) — servie par un tiers.
// Mettre vide pour la désactiver.
const FALLBACK_API = (process.env.DOWNLOAD_API || 'https://apischristus.vercel.app/api/auto').trim()

let ensured = false

// ffmpeg statique (fusion des streams DASH — YouTube moderne) — optionnel.
let FFMPEG_PATH = null
try {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const p = req('ffmpeg-static')
  if (typeof p === 'string' && fs.existsSync(p)) FFMPEG_PATH = p
} catch {}

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

/** Arguments d'authentification : cookies YouTube + compte Crunchyroll.
 *  Crunchyroll (anime VF) : CRUNCHYROLL_EMAIL + CRUNCHYROLL_PASSWORD,
 *  OU CRUNCHYROLL_COOKIES (fichier Netscape en clair/base64 — plus sûr). */
function credArgs(url) {
  const args = []
  if (/youtube\.com|youtu\.be/i.test(url)) {
    const f = writeCookieFile()
    if (f) args.push('--cookies', f)
  }
  if (/crunchyroll/i.test(url)) {
    const raw = (process.env.CRUNCHYROLL_COOKIES || '').trim()
    if (raw) {
      let content = raw
      const compact = raw.replace(/\s+/g, '')
      if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
        try {
          const dec = Buffer.from(compact, 'base64').toString('utf8')
          if (dec.includes('crunchyroll') || dec.startsWith('#')) content = dec
        } catch {}
      }
      try {
        const f = path.join(DL_DIR, 'cr-cookies.txt')
        fs.writeFileSync(f, content)
        args.push('--cookies', f)
      } catch (err) {
        console.warn('⚠️ Cookies Crunchyroll :', err.message)
      }
    } else {
      const u = (process.env.CRUNCHYROLL_EMAIL || '').trim()
      const p = process.env.CRUNCHYROLL_PASSWORD || ''
      if (u && p) args.push('--username', u, '--password', p)
    }
  }
  return args
}

/** Installe yt-dlp si le binaire n'est pas présent (au build OU au runtime),
 *  et garantit toujours le bit d'exécution (le FS peut le perdre). */
export async function ensureYtDlp() {
  if (!fs.existsSync(BIN)) {
    console.log('⬇️ Téléchargement de yt-dlp (runtime)…')
    const res = await fetch(YTDLP_URL, { redirect: 'follow' })
    if (!res.ok) throw new Error(`Impossible de télécharger yt-dlp (HTTP ${res.status})`)
    fs.mkdirSync(path.dirname(BIN), { recursive: true })
    fs.writeFileSync(BIN, Buffer.from(await res.arrayBuffer()))
    console.log('✅ yt-dlp installé')
  }
  try {
    fs.chmodSync(BIN, 0o755)
  } catch {}
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
    const r = await fetchToFile(video, dest, DOC_LIMIT)
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

  // --- 1) Métadonnées (rapide) : erreur définitive immédiate + choix de format
  let meta = null
  try {
    const { out } = await run([...credArgs(url), '-J', '--no-playlist', '--no-warnings', url], 90_000)
    meta = JSON.parse(out.trim())
  } catch (err) {
    lastError = err
    console.log('ℹ️ Métadonnées en échec → tentative API…', err.message)
  }

  if (meta) {
    // Formats fusionnés vidéo+audio ; mp4 en priorité (lisible partout)
    const merged = (meta.formats || []).filter((f) => f.vcodec !== 'none' && f.acodec !== 'none')
    const mp4 = merged.filter((f) => f.ext === 'mp4')
    const pool = mp4.length ? mp4 : merged
    pool.sort(
      (a, b) =>
        (a.height || 0) - (b.height || 0) ||
        (a.filesize_approx || a.filesize || 0) - (b.filesize_approx || b.filesize || 0)
    )
    const sized = pool.filter((f) => (f.filesize_approx || f.filesize || 0) > 0)
    let pick = sized.find((f) => (f.filesize_approx || f.filesize || 0) <= DOC_LIMIT) || sized[0] || pool[0]

    // Source DASH uniquement (YouTube moderne : streams séparés vidéo+audio)
    // → on fusionne avec ffmpeg si dispo
    if (!pick && FFMPEG_PATH) {
      const vids = (meta.formats || [])
        .filter((f) => f.vcodec !== 'none' && f.ext === 'mp4' && (f.height || 0) <= 480)
        .sort((a, b) => (b.height || 0) - (a.height || 0))
      const auds = (meta.formats || [])
        .filter((f) => f.vcodec === 'none' && f.acodec !== 'none')
        .sort((a, b) => (a.filesize_approx || a.filesize || 0) - (b.filesize_approx || b.filesize || 0))
      if (vids.length && auds.length) {
        const a = auds[0] // audio le plus léger (généralement 128 kbps)
        const aSize = a.filesize_approx || a.filesize || 0
        const v =
          vids.find((f) => (f.filesize_approx || f.filesize || 0) + aSize <= DOC_LIMIT) ||
          vids[vids.length - 1]
        pick = {
          ...v,
          format_id: `${v.format_id}+${a.format_id}`,
          filesize_approx: (v.filesize_approx || v.filesize || 0) + aSize,
        }
      }
    }

    if (pick) {
      const approx = pick.filesize_approx || pick.filesize || 0
      if (approx > DOC_LIMIT) {
        console.log(`↩️ Vidéo ~${Math.round(approx / 1048576)} Mo > limite ${Math.round(DOC_LIMIT / 1048576)} Mo`)
        return { tooBig: true, url }
      }

      // --- 2) Espace disque (plan free Render : 512 Mo au total)
      if (typeof fs.statfsSync === 'function') {
        try {
          const s = fs.statfsSync(DL_DIR)
          const free = s.bavail * s.bsize
          const need = (approx || 50 * 1024 * 1024) * 1.4
          if (free < need) {
            throw new Error(
              `Pas assez de place libre sur le serveur (${Math.round(free / 1048576)} Mo libres, ~${Math.round(need / 1048576)} Mo requis) — essaie une vidéo plus courte.`
            )
          }
        } catch (err) {
          if (String(err.message).startsWith('Pas assez')) throw err
          // statfs indisponible → on tente quand même
        }
      }

      // --- 3) Téléchargement du format choisi (timeout adapté à la taille)
      try {
        const timeoutMs = 240_000 + Math.round((approx || 50 * 1024 * 1024) / 1024)
        const { out } = await run(
          [
            ...credArgs(url),
            ...(FFMPEG_PATH ? ['--ffmpeg-location', FFMPEG_PATH] : []),
            '-f', String(pick.format_id),
            '--no-playlist',
            '--no-warnings',
            '--retries', '3',
            '--socket-timeout', '20',
            '-o', path.join(DL_DIR, '%(id)s.%(ext)s'),
            '--print', 'after_move:filepath',
            '--print', 'after_move:title',
            url,
          ],
          timeoutMs
        )
        const lines = out.trim().split('\n')
        const filePath = lines[0].trim()
        const title = lines.slice(1).join('\n').trim()
        if (!filePath || !fs.existsSync(filePath)) throw new Error('Fichier introuvable après téléchargement')
        const size = fs.statSync(filePath).size
        if (size > DOC_LIMIT) {
          fs.rmSync(filePath, { force: true })
          return { tooBig: true, url }
        }
        console.log(`✅ Téléchargé : ${title || pick.format_id} (${Math.round(size / 1048576)} Mo)`)
        return { path: filePath, title, size }
      } catch (err) {
        lastError = err
        console.log('ℹ️ Téléchargement du format choisi en échec → tentative API…', err.message)
      }
    }
  }

  // --- 4) API de secours (FB, TikTok, liens que yt-dlp ne passe pas)
  console.log('↪️ yt-dlp local en échec, tentative via l’API de secours…')
  const fb = await tryFallbackApi(url)
  if (fb) return fb

  throw lastError || new Error('Échec du téléchargement')
}

/**
 * Télécharge un flux HLS (m3u8) résolu directement — ex. anime via AniPub
 * quand le CDN laisse passer.
 * @returns {Promise<{path,title,size} | {tooBig:true,url}>}
 */
export async function downloadHls(m3u8Url, title = '') {
  await ensureYtDlp()
  try {
    const { out } = await run(
      [
        ...(FFMPEG_PATH ? ['--ffmpeg-location', FFMPEG_PATH] : []),
        '-f', 'bv*+ba/b',
        '--no-playlist',
        '--no-warnings',
        '--retries', '3',
        '--socket-timeout', '30',
        '-o', path.join(DL_DIR, 'anipub_%(id)s.%(ext)s'),
        '--print', 'after_move:filepath',
        m3u8Url,
      ],
      600_000
    )
    const filePath = out.trim().split('\n')[0].trim()
    if (!filePath || !fs.existsSync(filePath)) throw new Error('Fichier introuvable après téléchargement')
    const size = fs.statSync(filePath).size
    if (size > DOC_LIMIT) {
      fs.rmSync(filePath, { force: true })
      return { tooBig: true, url: m3u8Url }
    }
    return { path: filePath, title, size }
  } catch (err) {
    throw new Error(String(err?.message || err))
  }
}

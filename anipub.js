// Support AniPub (anime) — API publique du site + résolution du flux vidéo.
// ⚠️ Le CDN final (megaplay/gogoanime) est protégé par Cloudflare et bloque
// les IP de datacenter : sans proxy (config.json), la résolution échouera.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ANIPUB = 'https://anipub.xyz'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Clé/IV du flux megaplay (extraites de leur client JS — AES-256-CBC,
// clé de 16 caractères complétée à 32 octets par des zéros)
const AES_KEY = Buffer.concat([Buffer.from('i?LMTAx0Q6,:}50U'), Buffer.alloc(16, 0)])
const AES_IV = Buffer.from("W0;27ToaUpl_P%'c")

// ---------------------------------------------------------------------
// Proxy (Cloudflare Worker) — configuration runtime (config.json)
// ---------------------------------------------------------------------
const CFG_PATH = path.join(__dirname, 'config.json')

export function getAnipubConfig() {
  try {
    return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

/** Version "proxifiée" d'une URL cible (null si pas de proxy configuré) */
export function proxied(target, referer) {
  const cfg = getAnipubConfig()
  if (!cfg.anipubProxy) return null
  try {
    const u = new URL(cfg.anipubProxy)
    u.searchParams.set('s', cfg.anipubSecret || '')
    u.searchParams.set('u', target)
    u.searchParams.set('r', referer || 'https://megaplay.buzz/')
    return u.toString()
  } catch {
    return null
  }
}

/** Fetch d'une URL cible, via le proxy si configuré */
async function fetchTarget(url, referer, timeoutMs = 30_000) {
  const p = proxied(url, referer)
  const headers = p
    ? {}
    : { 'User-Agent': UA, Referer: referer || 'https://megaplay.buzz/' }
  const res = await fetch(p || url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  })
  if (!res.ok) {
    res.body?.cancel()
    throw new Error(`HTTP ${res.status}`)
  }
  return res
}

async function getJson(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`)
  return res.json()
}

async function getHtml(url, ref) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': UA, ...(ref ? { Referer: ref } : {}) },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`)
  return res.text()
}

/** Recherche AniPub → [{name, id, finder, epCount, score}] */
export async function anipubSearch(query, limit = 5) {
  const arr = await getJson(`${ANIPUB}/api/search/${encodeURIComponent(query)}`)
  const top = (Array.isArray(arr) ? arr : []).slice(0, limit)
  // Compléter avec le nombre d'épisodes + note (parallèle)
  const withInfo = await Promise.all(
    top.map(async (a) => {
      let epCount = ''
      let score = ''
      try {
        const info = await getJson(`${ANIPUB}/api/info/${a.finder || a.Id}`)
        epCount = info.epCount || ''
        score = info.MALScore || ''
      } catch {}
      return {
        name: a.Name,
        id: a.Id,
        finder: a.finder,
        epCount,
        score,
        link: `${ANIPUB}/AniPlayer/${a.finder || a.Id}/0`,
      }
    })
  )
  return withInfo
}

/** Détails d'un anime → {name, finder, epCount, links par épisode} */
export async function anipubDetails(animeId) {
  const j = await getJson(`${ANIPUB}/v1/api/details/${animeId}`)
  const local = j.local || {}
  const eps = (local.ep || []).map((e) => {
    const m = /anipub\.xyz\/video\/(\d+)\/(sub|dub)/.exec(e.link || '')
    return m ? { gogoId: m[1], type: m[2] } : null
  }).filter(Boolean)
  return {
    name: local.Name || local.name || '',
    finder: local.finder || '',
    epCount: eps.length,
    eps,
  }
}

/** Récupère l'ID d'épisode (source de vérité : la page player) */
export async function anipubEpisodeId(finder, epIndex0) {
  const html = await getHtml(`${ANIPUB}/AniPlayer/${finder}/${epIndex0}`, 'https://anipub.xyz/')
  const m = /streaming\.php\?id=([^&"']+)(&amp;|&)ep=(\d+)/.exec(html)
  if (m) return { gogoId: m[3], type: 'sub' }
  const m2 = /anipub\.xyz\/video\/(\d+)\/(sub|dub)/.exec(html)
  if (m2) return { gogoId: m2[1], type: m2[2] }
  return null
}

/**
 * Résout le flux d'un épisode : getSources → décryptage AES → URL m3u8.
 * @returns {{ok:true, m3u8:string, tracks:Array} | {ok:false, blocked?:boolean, why:string}}
 */
export async function anipubResolveMedia(gogoId) {
  let src
  try {
    const res = await fetchTarget(`https://megaplay.buzz/stream/getSources?id=${gogoId}`, 'https://megaplay.buzz/')
    src = await res.json()
  } catch (err) {
    const msg = String(err.message || '')
    if (/HTTP (401|403|429|503)/.test(msg)) {
      return { ok: false, blocked: true, why: 'le CDN a refusé la demande (anti-bot)' }
    }
    return { ok: false, why: msg }
  }
  if (!src?.enc) return { ok: false, why: 'pas de flux vidéo' }
  let m3u8
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV)
    const plain = Buffer.concat([d.update(Buffer.from(src.enc, 'base64url')), d.final()])
    m3u8 = JSON.parse(plain.toString('utf8')).file
    if (!m3u8) throw new Error('aucune url')
  } catch {
    return { ok: false, why: 'décryptage du flux impossible' }
  }
  // Probe rapide : le CDN (ou le proxy) laisse-t-il passer ?
  try {
    const r = await fetchTarget(m3u8, 'https://megaplay.buzz/', 20_000)
    r.body?.cancel()
    return { ok: true, m3u8, tracks: src.tracks || [] }
  } catch (err) {
    return { ok: false, blocked: true, why: err.message }
  }
}

/** Décrypte un token /segment/<token> → URL réelle des segments */
function decryptSegmentToken(token) {
  const d = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV)
  const plain = Buffer.concat([d.update(Buffer.from(token, 'base64url')), d.final()])
  return plain.toString('utf8')
}

/**
 * Construit la playlist HLS complète et jouable :
 *  - télécharge master.m3u8 (+ sous-playlists, récursif)
 *  - décrypte chaque /segment/<token> → URL réelle
 *  - passe tout par le proxy s'il est configuré
 * @returns {Promise<string>} chemin local du m3u8 réécrit (prêt pour yt-dlp)
 */
export async function anipubBuildPlaylist(masterUrl, dlDir) {
  const REFERER = 'https://megaplay.buzz/'
  const dir = fs.mkdtempSync(path.join(dlDir, 'anipub-'))

  async function build(url, name) {
    const res = await fetchTarget(url, REFERER, 30_000)
    const text = await res.text()
    const lines = text.split(/\r?\n/)
    const out = []
    for (let line of lines) {
      const seg = line.match(/\/segment\/([A-Za-z0-9_-]+)/)
      if (seg) {
        let real
        try {
          real = decryptSegmentToken(seg[1])
        } catch {
          real = null
        }
        if (real) {
          const prox = proxied(real, REFERER)
          line = line.replace(`/segment/${seg[1]}`, prox || real)
        }
      } else if (/\.m3u8/i.test(line) && !line.startsWith('#')) {
        // sous-playlist → construire récursivement, référence relative
        const abs = new URL(line.trim(), url).toString()
        const subName = `${name.replace('.m3u8', '')}_s${out.length}.m3u8`
        await build(abs, subName)
        line = subName
      }
      out.push(line)
    }
    const file = path.join(dir, name)
    fs.writeFileSync(file, out.join('\n'))
    return file
  }

  return build(masterUrl, 'master.m3u8')
}

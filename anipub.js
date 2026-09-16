// Support AniPub (anime) — API publique du site + résolution du flux vidéo.
// ⚠️ Le CDN final (megaplay/gogoanime) est protégé par Cloudflare et bloque
// les IP de datacenter : la résolution échouera probablement depuis le serveur.
import crypto from 'node:crypto'

const ANIPUB = 'https://anipub.xyz'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Clé/IV du flux megaplay (extraites de leur client JS — AES-256-CBC,
// clé de 16 caractères complétée à 32 octets par des zéros)
const AES_KEY = Buffer.concat([Buffer.from('i?LMTAx0Q6,:}50U'), Buffer.alloc(16, 0)])
const AES_IV = Buffer.from("W0;27ToaUpl_P%'c")

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
    src = await getJson(`https://megaplay.buzz/stream/getSources?id=${gogoId}`)
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
  // Probe rapide : le CDN laisse-t-il passer ?
  try {
    const r = await fetch(m3u8, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': UA, Referer: 'https://megaplay.buzz/' },
    })
    if (!r.ok) {
      r.body?.cancel()
      return { ok: false, blocked: true, why: `HTTP ${r.status} (anti-bot CDN)` }
    }
    r.body?.cancel()
    return { ok: true, m3u8, tracks: src.tracks || [] }
  } catch (err) {
    return { ok: false, blocked: true, why: err.message }
  }
}

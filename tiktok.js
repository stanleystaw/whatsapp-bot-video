// tiktok.js — Recherche TikTok par mot-clé (API X69X, vidéos sans watermark) + téléchargement direct
const X69X = 'https://azadx69x-all-apis-top.vercel.app'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export async function tiktokSearch(query) {
  const url = `${X69X}/api/tiktok?query=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45_000) })
  if (!res.ok) throw new Error(`API TikTok HTTP ${res.status}`)
  const d = await res.json().catch(() => ({}))
  if (!d || !Array.isArray(d.data) || !d.data.length) throw new Error('aucun résultat TikTok')
  return d.data.map((v) => ({
    title: (v.title || '').slice(0, 150),
    author: v.author || '',
    thumbnail: v.thumbnail || '',
    videoUrl: v.video_url || '',
    stats: v.stats || {},
  }))
}

// Télécharge un mp4 direct (CDN TikTok) vers dest. Retourne la taille en octets.
export async function downloadTo(url, dest, maxBytes = 480 * 1024 * 1024) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`Téléchargement HTTP ${res.status}`)
  const fs = await import('node:fs')
  const out = fs.createWriteStream(dest)
  let size = 0
  try {
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > maxBytes) throw new Error('fichier trop volumineux')
      out.write(chunk)
    }
  } finally {
    out.end()
    await new Promise((r) => out.on('finish', r).on('close', r))
  }
  return size
}

// manga.js — Recherche & téléchargement de mangas (nyaa) : VF (FR) + EN
import { vfSearch, VF_MAX_MB } from './vf.js'

// Catégories nyaa concernées par les mangas :
const MANGA_CATS = ['3_2', '3_1', '2_1', '2_2', '2_3'] // FR, EN, Manga, Manhwa, Manhua

function langOf(title) {
  const t = title.toUpperCase()
  if (/\bVF\b|FRENCH|\[MANGA FR\]|MANGA FR/i.test(title)) return 'FR'
  if (/\bEN\b|ENGLISH/i.test(t)) return 'EN'
  if (/\bITA\b|ITALIAN/i.test(t)) return 'ITA'
  if (/\bES\b|SPANISH|ESPAÑOL/i.test(t)) return 'ES'
  if (/\bPT\b|PORTUGUESE|BRASIL/i.test(t)) return 'PT'
  if (/\bKR\b|KOREAN/i.test(t)) return 'KR'
  return ''
}

function fmtOf(title) {
  const t = title.toUpperCase()
  if (/\bPDF\b/.test(t)) return 'PDF'
  if (/\bCBZ\b/.test(t)) return 'CBZ'
  if (/\bEPUB\b/.test(t)) return 'EPUB'
  if (/DIGITAL|SCAN|IMG|JPG|PNG|C2|C3/.test(t)) return 'IMG'
  return ''
}

export async function mangaSearch(query, cats = MANGA_CATS) {
  // On interroge chaque catégorie puis on fusionne (nyaa limite à 75 par requête)
  let all = []
  for (const c of cats) {
    try {
      const items = await vfSearch(query, c)
      all = all.concat(items.map((it) => ({ ...it, cat: c })))
    } catch { /* ignore */ }
  }
  // dédoublonne par infoHash
  const seen = new Set()
  const uniq = all.filter((it) => {
    const k = it.hash || it.link
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return uniq
}

function mangaScore(it, maxMB) {
  const t = it.title
  let s = 0
  const lang = langOf(t)
  if (lang === 'FR') s += 100
  else if (lang === 'EN') s += 30
  else s += 10
  if (it.seeds > 0) s += 20; else s -= 80
  if (it.leech > 0 && it.seeds === 0) s += 8
  if (it.size > maxMB * 1024 * 1024) s -= 150
  // préférence scanlation récente / sérieuse
  if (/\b(Onii-ChanSub|PapriKa|ZinObitsu|MangaZone|FZ|TBC|Hatsukoi|MangasInfo)\b/i.test(t)) s += 6
  return s
}

export function mangaRank(items, maxMB = VF_MAX_MB) {
  const scored = items.map((it) => ({ it, s: mangaScore(it, maxMB), lang: langOf(it.title), fmt: fmtOf(it.title) }))
  scored.sort((a, b) => b.s - a.s)
  return scored
}

// Choisi pour téléchargement direct (m <query> sans choix) : meilleur score
export function mangaBest(items, maxMB = VF_MAX_MB) {
  const r = mangaRank(items, maxMB)
  return r.length ? r[0].it : null
}

export { langOf, fmtOf }

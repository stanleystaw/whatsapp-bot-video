// vf.js — Vraie VF via nyaa.si (torrents publics) + aria2c + ffmpeg
// Requête: "vf <anime> [sXXeYY ou NN]"  ex: vf demon slayer s04e11 | vf demon slayer 11
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'node:module'
import { DL_DIR } from './downloader.js'

const requireCjs = createRequire(import.meta.url)
const __root = path.dirname(new URL(import.meta.url).pathname)
function resolveAria2c() {
  for (const p of [path.join(__root, 'bin', 'aria2c'), path.join(__root, 'vendor', 'aria2c')]) {
    try {
      if (fs.existsSync(p)) {
        try { fs.chmodSync(p, 0o755) } catch {}
        return p
      }
    } catch {}
  }
  return null
}
const ARIA2C = resolveAria2c()
const FFMPEG = requireCjs('ffmpeg-static')
let FFPROBE = null
try { FFPROBE = requireCjs('ffprobe-static').path } catch {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Budget disque (instance Render gratuite ≈ 512 Mo au total) + confort WhatsApp mobile
export const VF_MAX_MB = 800
const VF_TIMEOUT_MS = 20 * 60 * 1000 // dur max par téléchargement

function decodeXml(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").trim()
}

function parseSize(s) {
  const m = String(s || '').match(/([\d.]+)\s*(TiB|GiB|MiB|TB|GB|MB|KiB|KB)?/i)
  if (!m) return 0
  const v = parseFloat(m[1])
  const u = (m[2] || 'MB').toUpperCase()
  const mult = { TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3, TIB: 1099511627776, GIB: 1073741824, MIB: 1048576, KIB: 1024 }[u]
  return Math.round(v * (mult || 1e6))
}

// --- Recherche nyaa (RSS, pas d'auth) -----------------------------------------
// cat: '1_3' anime, '2_1' manga, '2_2' manhwa, '2_3' manhua, '3_1' mangas EN, '3_2' mangas FR, '' = toutes
export async function vfSearch(query, cat = '') {
  const url = 'https://nyaa.si/?page=rss&q=' + encodeURIComponent(query) + (cat ? '&c=' + cat : '')
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`nyaa HTTP ${res.status}`)
  const xml = await res.text()
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(xml))) {
    const b = m[1]
    const pick = (tag) => { const r = b.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>')); return r ? decodeXml(r[1]) : '' }
    const title = pick('title')
    const link = pick('link')
    if (!title || !link) continue
    items.push({
      title,
      link,
      seeds: parseInt(pick('nyaa:seeders') || '0', 10) || 0,
      leech: parseInt(pick('nyaa:leechers') || '0', 10) || 0,
      size: parseSize(pick('nyaa:size')),
      hash: pick('nyaa:infoHash'),
    })
  }
  return items
}

// Score: vraie VF ("FRENCH"/"VF" sans VOSTFR) > multi VF/VOSTFR > VOSTFR
function vfScore(it, maxMB) {
  const t = it.title.toUpperCase()
  let s = 0
  const hasVF = /\b(FRENCH|VF)\b/.test(t)
  const hasVOSTFR = /VOSTFR/.test(t)
  if (hasVF && !hasVOSTFR) s += 100        // dublé (souvent piste unique)
  else if (hasVF && hasVOSTFR) s += 55      // multi VF/VOSTFR
  else if (hasVOSTFR) s += 15               // sous-titré (dépannage)
  else return -1                            // pas de français
  if (it.seeds > 0) s += 20; else s -= 80
  if (it.leech > 0 && it.seeds === 0) s += 10
  if (it.size > maxMB * 1024 * 1024) s -= 120
  if (/\b720p\b/i.test(it.title)) s += 15
  if (/\b1080p\b/i.test(it.title)) s -= 5
  if (/-Tsundere-Raws|\(CR\)|DSNP|\(ADN\)/i.test(it.title)) s += 5
  return s
}

export async function vfPick(rawQuery) {
  const q = rawQuery.trim().replace(/\s+/g, ' ')
  const isEp = /s\d{1,2}\s*e\d{1,3}/i.test(q)
  const queries = isEp ? [q] : []
  const epNum = (q.match(/(?:\s|^)(?:e\s*\.?\s*)?(\d{1,4})\s*$/) || [])[1]
  const base = q.replace(/\s+(?:e\s*\.?\s*)?\d{1,4}\s*$/i, '').trim()
  if (!isEp && epNum) {
    for (let s = 1; s <= 6; s++) queries.push(`${base} s${String(s).padStart(2, '0')}e${epNum}`)
  } else if (!isEp) {
    queries.push(base)
  }
  let items = []
  for (const query of queries) {
    try {
      items = await vfSearch(query)
      if (items.length) break
    } catch { /* requête suivante */ }
  }
  const scored = items.map((it) => ({ it, s: vfScore(it, VF_MAX_MB) })).filter((x) => x.s > 0)
  scored.sort((a, b) => b.s - a.s)
  return { best: scored.length ? scored[0].it : null, all: items }
}

// --- Téléchargement torrent (aria2c) -------------------------------------------
export function vfDownload(torrentUrl, onStatus, timeoutMs = VF_TIMEOUT_MS) {
  fs.mkdirSync(DL_DIR, { recursive: true })
  const logFile = path.join(DL_DIR, 'aria2-vf.log')
  const args = [
    '--dir', DL_DIR,
    '-x', '16', '-s', '16', '-k', '1M',
    '--timeout=60', '--retry-wait=5', '--max-tries=0',
    '--bt-max-peers=64',
    '--log=' + logFile, '--log-level=warn',
    '-c',
    torrentUrl,
  ]
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => finish(reject, new Error('timeout téléchargement (20 min)')), timeoutMs)
    function finish(cb, err, filePath) {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(check)
      try { proc.kill('SIGTERM') } catch {} // libère le slot, on a déjà le fichier
      if (err) { try { proc.kill('SIGKILL') } catch {} cb(err) } else cb(filePath)
    }
    const proc = spawn(ARIA2C, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let errTail = ''
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000) })
    proc.stdout.on('data', () => {})
    function filesNow() {
      try { return fs.readdirSync(DL_DIR).filter((f) => !f.startsWith('.') && !f.endsWith('.torrent') && f !== 'aria2-vf.log') } catch { return [] }
    }
    const check = setInterval(() => {
      if (done) return
      const files = filesNow()
      const ctrl = files.find((f) => f.endsWith('.aria2'))
      const data = files.find((f) => !f.endsWith('.aria2'))
      if (!ctrl && data) {
        // le fichier .aria2 (contrôle) est supprimé par aria2 à la fin → téléchargement terminé
        const p = path.join(DL_DIR, data)
        try { if (fs.statSync(p).size > 0) finish(resolve, null, p) } catch {}
      } else if (ctrl && onStatus) {
        try {
          const st = fs.statSync(path.join(DL_DIR, ctrl))
          const m = fs.readdirSync(DL_DIR).find((f) => f.endsWith('.aria2'))
          const part = path.join(DL_DIR, m.replace(/\.aria2$/, ''))
          let sz = 0
          try { sz = fs.statSync(part).size } catch {}
          onStatus(`téléchargement… ~${Math.round(sz / 1048576)} Mo`)
        } catch {}
      }
    }, 10000)
    proc.on('error', (e) => finish(reject, e))
    proc.on('close', (code) => {
      const files = filesNow()
      const ctrl = files.find((f) => f.endsWith('.aria2'))
      const data = files.find((f) => !f.endsWith('.aria2'))
      if (data && !ctrl) finish(resolve, null, path.join(DL_DIR, data))
      else finish(reject, new Error(`aria2c code ${code}${ctrl ? ' (fichier incomplet)' : ''}${errTail ? ' — ' + errTail.slice(-200) : ''}`))
    })
  })
}

// --- Extraction piste VF si multi-langue ---------------------------------------
function probeAudioStreams(file) {
  if (!FFPROBE) return null
  try {
    const out = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', file], { encoding: 'utf8', timeout: 90_000 })
    const parsed = JSON.parse(out.stdout || '{}')
    return (parsed.streams || []).filter((s) => s.codec_type === 'audio')
  } catch { return null }
}

export function vfMakeFrench(input, onStatus) {
  const streams = probeAudioStreams(input)
  if (!streams) return { file: input, note: '' }
  if (streams.length <= 1) {
    const t = (streams[0] || {}).tags || {}
    const isFr = String(t.language || '').toLowerCase().startsWith('fre') || /french|\bvf\b/i.test(`${t.title || ''} ${t.handler_name || ''}`)
    return { file: input, note: !isFr ? '⚠️ piste audio unique, non identifiée VF' : '' }
  }
  const fr = streams.find((s) => {
    const t = s.tags || {}
    return String(t.language || '').toLowerCase().startsWith('fre') || /french|\bvf\b/i.test(`${t.title || ''} ${t.handler_name || ''}`)
  })
  if (!fr) return { file: input, note: '⚠️ pistes multiples, aucune piste FR détectée' }
  if (onStatus) onStatus('extraction de la piste VF…')
  const idx = streams.indexOf(fr)
  const out = input.replace(/\.[^.]+$/, '') + '.vf.mkv'
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-map', '0:v:0', '-map', `0:a:${idx}`,
    '-c', 'copy', '-movflags', '+faststart',
    out,
  ], { encoding: 'utf8', timeout: 10 * 60 * 1000 })
  if (r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 10 * 1024 * 1024) {
    return { file: out, note: '🎧 piste VF extraite' }
  }
  return { file: input, note: '⚠️ extraction échouée — envoi du fichier original' }
}

export function vfClean(files) {
  for (const f of files || []) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f) } catch {}
  }
}

// Postinstall : s'assurer que les binaires (yt-dlp, aria2c) sont présents et exécutables.
// Le binaire aria2c est commité dans vendor/ (source principale) ; le téléchargement est un filet.
import fs from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const YTDLP = path.join(__dirname, 'bin', 'yt-dlp')
const ARIA2 = path.join(__dirname, 'vendor', 'aria2c')
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
const ARIA2_WHEEL_URL = 'https://files.pythonhosted.org/packages/24/61/0d0e41652ca687182f226bab80697e7b899330a00c56a3983d479818ad52/aria2-0.0.1b0-py3-none-manylinux_2_17_x86_64.whl'
const ARIA2_MEMBER = 'aria2c/bin/aria2c'

function ensureExec(p) {
  try { if (fs.existsSync(p)) fs.chmodSync(p, 0o755) } catch {}
}

function ok(p) { return fs.existsSync(p) && fs.statSync(p).size > 1_000_000 }

// Extraction d'un membre ZIP (déflation) sans dépendance — local file headers uniquement.
function extractZipMember(buf, name) {
  let i = 0
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue }
    const method = buf.readUInt16LE(i + 8)
    const csize = buf.readUInt32LE(i + 18)
    const nlen = buf.readUInt16LE(i + 26)
    const elen = buf.readUInt16LE(i + 28)
    const nm = buf.toString('utf8', i + 30, i + 30 + nlen)
    const dstart = i + 30 + nlen + elen
    if (nm === name) {
      const data = buf.subarray(dstart, dstart + csize)
      if (method === 0) return Buffer.from(data)
      if (method === 8) { try { return inflateRawSync(data) } catch { return null } }
      return null
    }
    i = dstart + csize
  }
  return null
}

async function main() {
  const force = process.argv.includes('--force')

  // --- yt-dlp ---
  ensureExec(YTDLP)
  if (fs.existsSync(YTDLP) && fs.statSync(YTDLP).size > 0 && !force) {
    console.log('✅ yt-dlp déjà présent :', YTDLP)
  } else {
    try {
      console.log('⬇️ Téléchargement de yt-dlp…')
      const res = await fetch(YTDLP_URL, { redirect: 'follow' })
      if (res.ok) {
        fs.mkdirSync(path.dirname(YTDLP), { recursive: true })
        fs.writeFileSync(YTDLP, Buffer.from(await res.arrayBuffer()))
        ensureExec(YTDLP)
        console.log('✅ yt-dlp installé dans', YTDLP)
      } else console.warn('⚠️ yt-dlp HTTP', res.status)
    } catch (e) { console.warn('⚠️ yt-dlp non téléchargé :', e.message) }
  }

  // --- aria2c ---
  ensureExec(ARIA2)
  if (ok(ARIA2) && !force) {
    console.log('✅ aria2c déjà présent :', ARIA2)
  } else {
    try {
      console.log('⬇️ Téléchargement de aria2c…')
      const res = await fetch(ARIA2_WHEEL_URL, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const extracted = extractZipMember(buf, ARIA2_MEMBER)
      if (!extracted) throw new Error('binaire aria2c introuvable dans le wheel')
      fs.mkdirSync(path.dirname(ARIA2), { recursive: true })
      fs.writeFileSync(ARIA2, extracted)
      ensureExec(ARIA2)
      console.log('✅ aria2c installé dans', ARIA2)
    } catch (e) {
      console.warn('⚠️ aria2c non téléchargé (le binaire commité dans vendor/ doit servir) :', e.message)
    }
  }
}

main().catch((err) => {
  console.warn('⚠️ setup binaires (ignoré) :', err.message)
  process.exit(0)
})

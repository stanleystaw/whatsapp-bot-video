// Télécharge le binaire autonome de yt-dlp dans ./bin (pas besoin de Python).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(__dirname, 'bin', 'yt-dlp')
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'

async function main() {
  const force = process.argv.includes('--force')
  if (fs.existsSync(BIN) && !force) {
    console.log('✅ yt-dlp déjà présent :', BIN)
    return
  }
  console.log('⬇️ Téléchargement de yt-dlp…')
  const res = await fetch(YTDLP_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Échec du téléchargement de yt-dlp (HTTP ${res.status})`)
  fs.mkdirSync(path.dirname(BIN), { recursive: true })
  fs.writeFileSync(BIN, Buffer.from(await res.arrayBuffer()))
  fs.chmodSync(BIN, 0o755)
  console.log('✅ yt-dlp installé dans', BIN)
}

main().catch((err) => {
  console.warn('⚠️ setup yt-dlp (ignoré, il sera retenté au runtime) :', err.message)
  process.exit(0) // ne jamais casser `npm install`
})

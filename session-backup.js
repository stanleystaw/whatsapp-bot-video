// session-backup.js — Sauvegarde/distanciation de la session WhatsApp vers le
// Worker Cloudflare (KV) : survit aux recréations d'instance Render qui
// effacent le disque. Le bot pousse sa session saine toutes les 10 min et se
// restaure tout seul quand la session locale est morte.
import fs from 'node:fs'
import path from 'node:path'

const REMOTE = 'https://anipub-proxy.mickeybot447.workers.dev'
const SECRET = '0017248a6987a119e9637faf'
const UA = 'whatsapp-bot-render/1.0'

function readAuthFiles(dir) {
  const files = {}
  function walk(d, rel) {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, r)
      else {
        try { files[r] = fs.readFileSync(p).toString('base64') } catch {}
      }
    }
  }
  walk(dir, '')
  return files
}

function writeAuthFiles(dir, filesObj) {
  for (const [rel, b64] of Object.entries(filesObj)) {
    if (rel.includes('..') || path.isAbsolute(rel)) continue
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.from(b64, 'base64'))
  }
}

// Pousse la session courante (dir = AUTH_DIR) vers le Worker.
export async function pushRemoteBackup(authDir) {
  const files = readAuthFiles(authDir)
  if (!Object.keys(files).length) return { ok: false, why: 'aucun fichier local' }
  try {
    const res = await fetch(`${REMOTE}/backup?key=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(60_000),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || !d.ok) return { ok: false, why: d.error || `HTTP ${res.status}` }
    return { ok: true, size: d.size }
  } catch (e) {
    return { ok: false, why: e.message }
  }
}

// Récupère la dernière session sauvegardée. Retourne null si indisponible.
export async function fetchRemoteBackup() {
  try {
    const res = await fetch(`${REMOTE}/backup?key=${SECRET}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(45_000),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || !d.ok || !d.files) return null
    return { files: d.files, generatedAt: d.generatedAt }
  } catch {
    return null
  }
}

export { writeAuthFiles, readAuthFiles }

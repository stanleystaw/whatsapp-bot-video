import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import QRCode from 'qrcode'
import {
  init,
  isLinked,
  isConnected,
  getPairingCode,
  getLatestQr,
  requestNewPairingCode,
  authDir,
  restart,
  resetAuth,
  getDiagnostics,
} from './whatsapp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 10000
const PAIR_SECRET = process.env.PAIR_SECRET || ''

// ---------------------------------------------------------------------
// Garde : protège /pair, /backup, /restore
// ---------------------------------------------------------------------
function guard(req, res, next) {
  if (!PAIR_SECRET) {
    console.warn('⚠️ PAIR_SECRET vide — /pair accessible sans clé (à définir en production)')
    return next()
  }
  if (req.query.key === PAIR_SECRET || req.get('x-pair-secret') === PAIR_SECRET) return next()
  res.status(403).send('Clé requise : /pair?key=' + PAIR_SECRET)
}

// ---------------------------------------------------------------------
// /status : diagnostic JSON (pour savoir exactement ce qui bloque)
// ---------------------------------------------------------------------
app.get('/status', guard, (req, res) => {
  res.json(getDiagnostics())
})

// ---------------------------------------------------------------------
// Page d'accueil (état du bot)
// ---------------------------------------------------------------------
app.get('/', (req, res) => {
  const linked = isLinked()
  const conn = isConnected()
  const code = getPairingCode()
  const rows = [
    ['Connexion WhatsApp', conn ? '✅ WebSocket ouvert' : '🔌 En reconnexion (auto, ~30 s)'],
    ['Liaison au compte', linked ? '✅ Lié au compte WhatsApp' : '🔴 Non lié'],
    [
      'Code d’appairage',
      linked ? '—' : code ? '✅ disponible ci-dessous' : '⏳ en attente de la connexion…',
    ],
  ]
  const table = rows
    .map(([k, v]) => `<tr><td style="color:#8696a0;padding:6px 16px 6px 0">${k}</td><td style="padding:6px 0">${v}</td></tr>`)
    .join('')
  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Bot WhatsApp</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b141a;color:#e9edef;
display:flex;justify-content:center;padding:40px 16px">
<div style="background:#111b21;border-radius:16px;padding:32px;max-width:520px;width:100%">
  <h1 style="margin-top:0">🤖 Bot WhatsApp</h1>
  <p style="color:#8696a0">Serveur en ligne — protocole multi-appareils (Baileys). Page auto-rechargée.</p>
  <table style="border-collapse:collapse;font-size:.95rem">${table}</table>
  <p style="margin-top:20px">
    ${
      linked
        ? '✅ Le bot est lié. Envoyez-lui un lien vidéo (ou « s mot-clé » pour chercher).'
        : 'Pour lier votre téléphone : <a href="/qr" style="color:#00a884;font-weight:600">scanner le QR code</a> ou <a href="/pair" style="color:#00a884;font-weight:600">code d’appairage</a>.'
    }
  </p>
  <p style="color:#8696a0;font-size:.85rem;margin-bottom:0">
    Utilitaires : <a href="/backup" style="color:#8696a0">/backup</a> (sauvegarde de la session) ·
    <a href="/restore" style="color:#8696a0">POST /restore</a> (restauration) ·
    <a href="/reset" style="color:#8696a0">/reset</a> (effacer la session → re-pairing)
  </p>
</div></body></html>`)
})

// ---------------------------------------------------------------------
// Page du code d'appairage
// ---------------------------------------------------------------------
function pairPage(code) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code d'appairage WhatsApp</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b141a;color:#e9edef;
       display:flex;justify-content:center;padding:32px 16px}
  .card{background:#111b21;border-radius:16px;padding:32px;max-width:480px;width:100%;
        box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:1.25rem;margin:0 0 8px}
  .sub{color:#8696a0;font-size:.9rem;margin-bottom:20px}
  .code{font-size:3rem;font-weight:700;letter-spacing:.35em;text-align:center;
        font-family:ui-monospace,Menlo,Consolas,monospace;background:#0b141a;
        border:1px solid #2a3942;border-radius:12px;padding:20px 0;margin:16px 0}
  .warn{background:#1f2c34;border:1px solid #2a3942;border-radius:10px;
        padding:10px 14px;font-size:.85rem;color:#ffd27d;margin-bottom:20px}
  ol{padding-left:20px;line-height:1.8;font-size:.95rem}
  button{background:#00a884;border:0;color:#fff;font-size:1rem;font-weight:600;
         padding:12px 22px;border-radius:10px;cursor:pointer;width:100%;margin-top:8px}
  .foot{margin-top:20px;font-size:.8rem;color:#8696a0;text-align:center}
</style></head>
<body><div class="card">
  <h1>🔗 Code d'appairage WhatsApp</h1>
  <div class="sub">Inscrivez ce code sur votre téléphone pour lier le bot à votre compte.</div>
  <div class="code">${code}</div>
  <div class="warn">⏱️ Saisissez le code rapidement (~1 minute). S'il n'est plus valide,
    générez-en un nouveau.</div>
  <ol>
    <li>Ouvrez <strong>WhatsApp</strong> sur votre téléphone</li>
    <li><strong>Paramètres</strong> → <strong>Appareils liés</strong></li>
    <li><strong>Lier un appareil</strong> → <strong>Lier avec un numéro de téléphone</strong></li>
    <li>Saisissez le code ci-dessus puis <strong>Terminé</strong></li>
  </ol>
  <button onclick="location.reload()">🔄 Générer un nouveau code</button>
  <div class="foot">Bot WhatsApp · protocole multi-appareils · hébergé sur Render</div>
</div></body></html>`
}

// ---------------------------------------------------------------------
// Page du QR code (alternative au code d'appairage)
// ---------------------------------------------------------------------
function qrPage(dataUrl) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>Lier WhatsApp par QR code</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b141a;color:#e9edef;
       display:flex;justify-content:center;padding:32px 16px}
  .card{background:#111b21;border-radius:16px;padding:32px;max-width:480px;width:100%;
        box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:1.25rem;margin:0 0 8px}
  .sub{color:#8696a0;font-size:.9rem;margin-bottom:16px}
  .qrbox{background:#fff;border-radius:16px;padding:18px;display:flex;
         justify-content:center;margin:12px 0}
  .qrbox img{width:300px;height:300px;display:block}
  .warn{background:#1f2c34;border:1px solid #2a3942;border-radius:10px;
        padding:10px 14px;font-size:.85rem;color:#ffd27d;margin-bottom:16px}
  ol{padding-left:20px;line-height:1.8;font-size:.95rem}
  .foot{margin-top:18px;font-size:.8rem;color:#8696a0;text-align:center}
  .alt{margin-top:14px;font-size:.9rem}
</style></head>
<body><div class="card">
  <h1>📷 Lier WhatsApp par QR code</h1>
  <div class="sub">Scanne ce QR avec ton téléphone. Il se renouvelle automatiquement
  (rechargement toutes les 20 s).</div>
  <div class="qrbox"><img src="${dataUrl}" alt="QR code"></div>
  <div class="warn">⏱️ Si le scan ne passe pas, attends le prochain QR (la page se
  recharge seule) et rescanne.</div>
  <ol>
    <li>Ouvrez <strong>WhatsApp</strong> sur votre téléphone</li>
    <li><strong>Paramètres</strong> → <strong>Appareils liés</strong></li>
    <li><strong>Lier un appareil</strong> (le QR classique, en premier choix)</li>
    <li>Scannez le QR ci-dessus → <strong>Terminé</strong></li>
  </ol>
  <div class="alt">Préfères-tu le code ? → <a href="/pair" style="color:#00a884;font-weight:600">/pair</a></div>
  <div class="foot">Bot WhatsApp · protocole multi-appareils · hébergé sur Render</div>
</div></body></html>`
}

app.get('/qr', guard, async (req, res) => {
  if (isLinked()) {
    return res.send(pairPage('DÉJÀ LIÉ ✅'))
  }
  // Attendre un QR valide (socket ouvert + QR frais)
  const deadline = Date.now() + 25_000
  while ((!getLatestQr() || !isConnected()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
  }
  const qr = getLatestQr()
  if (!qr || !isConnected()) {
    return res.status(503).send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="20">
<title>QR — en attente</title></head>
<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:flex;
justify-content:center;padding:40px 16px">
<div style="background:#111b21;border-radius:16px;padding:32px;max-width:480px;width:100%">
  <h1 style="margin-top:0">⏳ QR en attente…</h1>
  <p>Le bot se connecte ou le QR se régénère. Cette page se recharge toute seule
  (toutes les 20 s).</p>
</div></body></html>`)
  }
  try {
    const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 1, errorCorrectionLevel: 'M' })
    res.send(qrPage(dataUrl))
  } catch (err) {
    res.status(500).send(`Erreur QR : ${err.message}`)
  }
})

app.get('/pair', guard, async (req, res) => {
  if (isLinked()) {
    return res.send(pairPage('DÉJÀ LIÉ ✅'))
  }
  try {
    const code = await requestNewPairingCode()
    console.log('🔑 Nouveau code d’appairage généré via /pair')
    res.send(pairPage(code))
  } catch (err) {
    console.error('❌ /pair :', err.message)
    res
      .status(503)
      .send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Appairage — en reconnexion</title></head>
<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:flex;
justify-content:center;padding:40px 16px">
<div style="background:#111b21;border-radius:16px;padding:32px;max-width:480px;width:100%">
  <h1 style="margin-top:0">🔌 Le bot se reconnecte…</h1>
  <p>Le service vient peut-être de se réveiller (sommeil Render) — la connexion
  WhatsApp se relance automatiquement.</p>
  <p><strong>Détail :</strong> ${String(err.message).replace(/</g, '&lt;')}</p>
  <p>Cette page se recharge toute seule dans ~30 s.
  <button onclick="location.reload()" style="background:#00a884;border:0;color:#fff;
  font-weight:600;padding:10px 18px;border-radius:10px;cursor:pointer">Recharger maintenant</button>
  </p>
</div></body></html>`)
  }
})

// ---------------------------------------------------------------------
// /reset : efface la session sauvegardée et relance le socket.
// À utiliser quand la session est morte (appareil déconnecté, disque effacé,
// « lié » affiché mais plus d'appareil sur le téléphone).
// ---------------------------------------------------------------------
app.get('/reset', guard, async (req, res) => {
  try {
    await resetAuth()
    console.log('🧹 Session réinitialisée via /reset')
    res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="15">
<title>Session réinitialisée</title></head>
<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:flex;
justify-content:center;padding:40px 16px">
<div style="background:#111b21;border-radius:16px;padding:32px;max-width:480px;width:100%">
  <h1 style="margin-top:0">🧹 Session réinitialisée</h1>
  <p>La session précédente a été effacée et le bot se reconnecte.</p>
  <p>Rechargez <a href="/pair" style="color:#00a884;font-weight:600">/pair</a> dans quelques
  secondes (cette page se recharge toute seule) pour obtenir un nouveau code.</p>
</div></body></html>`)
  } catch (err) {
    res.status(500).send(`Erreur /reset : ${err.message}`)
  }
})

// ---------------------------------------------------------------------
// Sauvegarde / restauration de la session (utile quand le disque Render
// est effacé à chaque déploiement)
// ---------------------------------------------------------------------
function walkAuth(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkAuth(p, base, out)
    else out[path.relative(base, p)] = fs.readFileSync(p).toString('base64')
  }
  return out
}

app.get('/backup', guard, (req, res) => {
  const dir = authDir()
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Aucune session à sauvegarder' })
  }
  res.json({ generatedAt: new Date().toISOString(), files: walkAuth(dir) })
})

app.post('/restore', guard, async (req, res) => {
  try {
    const { files } = req.body || {}
    if (!files || typeof files !== 'object') {
      throw new Error('JSON invalide — attendu : { "files": { "fichier.json": "<base64>" } }')
    }
    const dir = authDir()
    for (const [rel, b64] of Object.entries(files)) {
      if (rel.includes('..') || path.isAbsolute(rel)) continue
      const p = path.join(dir, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, Buffer.from(b64, 'base64'))
    }
    await restart()
    res.json({ ok: true, linked: isLinked(), note: 'Session restaurée — le bot se reconnecte.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Bot WhatsApp démarré sur le port ${PORT}`)
  console.log(`   État        : http://localhost:${PORT}/`)
  console.log(`   Appairage   : http://localhost:${PORT}/pair`)
  console.log(`   Session     : ${authDir()}`)
  init().catch((err) => console.error('❌ Erreur au démarrage du socket :', err.message))
})

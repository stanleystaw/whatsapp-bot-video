import fs from 'node:fs'
import path from 'node:path'
import { sendMessage, sendVideo, sendDocument } from './whatsapp.js'
import { searchVideos, downloadVideo, VIDEO_LIMIT } from './downloader.js'

// Recherches en attente : jid -> { results, ts } (expirées après 10 min)
const pending = new Map()
const PENDING_TTL = 10 * 60 * 1000
const URL_RE = /https?:\/\/[^\s]+/i

function fmtDur(sec) {
  if (!sec || sec === 'NA') return ''
  const s = parseInt(sec, 10)
  if (Number.isNaN(s)) return ''
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`
}

function helpText() {
  return [
    '🎬 Bot Vidéo — télécharge et envoie tes vidéos',
    '',
    '• **Lien direct** : colle un lien et je télécharge la vidéo',
    '  (YouTube, TikTok, Facebook, Instagram, X, Dailymotion, Vimeo…)',
    '',
    '• **Anime VF** : `a nom` → je cherche les épisodes en VO/Français',
    '  Ex : `a one piece` puis `3`',
    '',
    '• **Recherche** : `s mot-clé` → je liste 5 résultats YouTube,',
    '  réponds avec le numéro (1-5) et je télécharge.',
    '',
    'Les petites vidéos arrivent en vidéo 🎬, les épisodes complets (>15 Mo)',
    'arrivent en fichier à télécharger 📎',
    '',
    'Exemples :',
    '  1. `a demon slayer`',
    '  2. `s chat drôle`',
    '  3. `https://www.tiktok.com/@user/video/123`',
  ].join('\n')
}

/**
 * ⚙️ LOGIQUE DU BOT — point d'entrée pour chaque message reçu.
 * @param {string} from JID de l'expéditeur (ex: 22901234567@s.whatsapp.net)
 * @param {string} text Contenu du message reçu
 */
export async function handleMessage(from, text) {
  const t = text.trim().toLowerCase()

  // --- Aide / salutations -------------------------------------------
  if (t === 'aide' || t === 'help' || t === 'menu') return sendMessage(from, helpText())
  if (t.startsWith('bonjour') || t.startsWith('salut') || t.startsWith('hello') || t.startsWith('hi')) {
    return sendMessage(from, 'Bonjour 👋 Colle un lien vidéo ou tape `s mot-clé` pour chercher.\nTape `aide` pour plus de détails.')
  }
  if (t === 'heure' || t === 'time') {
    const now = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Porto-Novo' })
    return sendMessage(from, `🕐 Il est ${now} (heure de Cotonou, Bénin).`)
  }

  // --- 1) Numéro de résultat (après une recherche) --------------------
  if (pending.has(from) && /^\d{1,2}$/.test(t)) {
    const p = pending.get(from)
    if (Date.now() - p.ts > PENDING_TTL) pending.delete(from)
    else {
      const r = p.results[parseInt(t, 10) - 1]
      if (r) return downloadAndSend(from, r.url, r.title)
      return sendMessage(from, `Choisis un numéro entre 1 et ${p.results.length}.`)
    }
  }

  // --- 2) Lien direct -------------------------------------------------
  const urlMatch = text.match(URL_RE)
  if (urlMatch) {
    const url = urlMatch[0].replace(/[).,;!?]+$/, '')
    return downloadAndSend(from, url)
  }

  // --- 3) Anime VF : "a nom" / "anime nom" (recherche YouTube avec VF) ----
  const animeMatch = text.match(/^(?:a|anime)\s+(.+)$/i)
  if (animeMatch) {
    const q = animeMatch[1].trim()
    if (!q) return sendMessage(from, 'Quel anime ? Exemple : `a one piece` ou `a demon slayer ep 1`')
    return doSearch(from, `${q} VF`, '🎌')
  }

  // --- 4) Recherche : "s mot-clé" / "recherche mot-clé" / "search ..."  ---
  const searchMatch = text.match(/^(?:s|recherche|rechercher|search)\s+(.+)$/i)
  if (searchMatch) {
    const q = searchMatch[1].trim()
    if (!q) return sendMessage(from, 'Que dois-je chercher ? Exemple : `s chat drôle`')
    return doSearch(from, q)
  }

  // --- 4) Réponse par défaut ------------------------------------------
  return sendMessage(from, '🤖 Je télécharge des vidéos !\n\n• Colle un **lien** (YouTube, TikTok, Facebook, Instagram, X…)\n• Ou tape `s mot-clé` pour chercher\n\n`aide` pour le menu complet.')
}

async function doSearch(from, q, emoji = '🔍') {
  try {
    const results = await searchVideos(q)
    if (!results.length) return sendMessage(from, `Aucun résultat pour « ${q} ».`)
    pending.set(from, { results, ts: Date.now() })
    const lines = results.map((r, i) => `${i + 1}. ${r.title} ${r.duration ? `(${fmtDur(r.duration)})` : ''}`)
    await sendMessage(
      from,
      `${emoji} Résultats pour « ${q} » :\n\n${lines.join('\n')}\n\nRéponds avec le numéro (1-${results.length}) pour télécharger. ⏱️ (valable 10 min)`
    )
  } catch (err) {
    await sendMessage(from, `⚠️ Recherche impossible : ${err.message}`)
  }
}

const MIME_BY_EXT = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v' }

async function downloadAndSend(from, url, titleHint) {
  try {
    await sendMessage(from, '⏳ Téléchargement en cours… (les épisodes complets peuvent prendre 1-2 min)')
  } catch {}
  try {
    const r = await downloadVideo(url)
    if (r.tooBig) {
      return sendMessage(
        from,
        `⚠️ Cette vidéo est trop volumineuse même en fichier (max ~180 Mo).\nTu peux l'ouvrir directement ici :\n${url}`
      )
    }
    const title = (titleHint || r.title || 'Voici ta vidéo 🎬').slice(0, 800)
    if (r.size <= VIDEO_LIMIT) {
      // Petite vidéo → lecture directe
      await sendVideo(from, r.path, title)
    } else {
      // Épisode complet → envoyé en FICHIER (téléchargeable/lectible)
      const ext = path.extname(r.path).slice(1).toLowerCase()
      const mo = Math.round(r.size / 1048576)
      await sendDocument(from, r.path, MIME_BY_EXT[ext] || 'video/mp4', `${title}\n\n📎 Fichier vidéo (${mo} Mo) — appuie dessus pour le télécharger et le lire.`)
    }
    fs.rmSync(r.path, { force: true })
  } catch (err) {
    await sendMessage(from, `⚠️ Impossible de télécharger cette vidéo.\nDétail : ${err.message}`)
  }
}

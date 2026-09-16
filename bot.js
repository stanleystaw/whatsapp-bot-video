import fs from 'node:fs'
import path from 'node:path'
import { sendMessage, sendVideo, sendDocument } from './whatsapp.js'
import { searchVideos, downloadVideo, downloadHls, VIDEO_LIMIT, DL_DIR } from './downloader.js'
import { anipubSearch, anipubEpisodeId, anipubResolveMedia, anipubBuildPlaylist } from './anipub.js'
import { vfPick, vfDownload, vfMakeFrench, vfClean, VF_MAX_MB } from './vf.js'

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
    '• **Anime (AniPub)** : envoie un lien anipub.xyz (recherche ou épisode)',
    '  Ex : le lien de recherche de ton anime, puis choisis le numéro',
    '',
    '• **Anime VRAIE VF** : `vf nom [sXXeYY]` → je télécharge l\'épisode dublé (nyaa)',
    '  Ex : `vf demon slayer s04e11` ou `vf demon slayer 11`',
    '',
    '• **Anime VF** : `a nom` → je cherche les épisodes sur YouTube',
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
  if (pending.has(from) && /^\d{1,3}$/.test(t)) {
    const p = pending.get(from)
    if (Date.now() - p.ts > PENDING_TTL) {
      pending.delete(from)
    } else if (p.kind === 'anipub-ep') {
      const n = parseInt(t, 10)
      if (n < 1 || n > p.epCount) return sendMessage(from, `Entre 1 et ${p.epCount}.`)
      pending.delete(from)
      return anipubTryDownload(from, p.finder, n, p.name)
    } else if (p.kind === 'anipub-search') {
      const r = p.results[parseInt(t, 10) - 1]
      if (!r) return sendMessage(from, `Choisis un numéro entre 1 et ${p.results.length}.`)
      pending.delete(from)
      if (!r.epCount || r.epCount <= 1) return anipubTryDownload(from, r.finder || String(r.id), 1, r.name)
      pending.set(from, { kind: 'anipub-ep', finder: r.finder, name: r.name, epCount: r.epCount, ts: Date.now() })
      return sendMessage(from, `🎌 ${r.name} — ${r.epCount} épisodes.\nQuel numéro d'épisode veux-tu ? (ex : 1)`)
    } else {
      const r = p.results[parseInt(t, 10) - 1]
      if (r) return downloadAndSend(from, r.url, r.title)
      return sendMessage(from, `Choisis un numéro entre 1 et ${p.results.length}.`)
    }
  }

  // --- 2) Lien direct -------------------------------------------------
  const urlMatch = text.match(URL_RE)
  if (urlMatch) {
    const url = urlMatch[0].replace(/[).,;!?]+$/, '')
    if (/anipub\.xyz/i.test(url)) return anipubUrl(from, url)
    return downloadAndSend(from, url)
  }

  // --- 2b) Anime VF réelle : "vf nom [saison/épisode]" (nyaa + torrent, vraie VF) ---
  const vfMatch = text.match(/^vf\s+(.+)$/i)
  if (vfMatch) {
    const q = vfMatch[1].trim()
    if (!q) return sendMessage(from, 'Quel anime ? Exemple : `vf demon slayer s04e11` ou `vf demon slayer 11`')
    return vfFlow(from, q)
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

// ---------------------------------------------------------------------
// AniPub (anime) — liens de recherche / épisodes
// ---------------------------------------------------------------------
async function anipubUrl(from, url) {
  try {
    const u = new URL(url)
    // 1) Page de recherche : /search/q?query=Naruto
    if (u.pathname.startsWith('/search/')) {
      const q = u.searchParams.get('query') || u.searchParams.get('q')
      if (!q) return sendMessage(from, 'Lien de recherche sans requête — tape plutôt `a <anime>` pour chercher.')
      return anipubSearchFlow(from, q)
    }
    // 2) Page player : /AniPlayer/<slug|id>/<episode>
    const m = u.pathname.match(/\/AniPlayer\/([^/]+)\/(\d+)/)
    if (m) return anipubTryDownload(from, m[1], parseInt(m[2], 10) + 1)
    // 3) Page vidéo directe : /video/<id>/<type>
    const m2 = u.pathname.match(/\/video\/(\d+)\/(sub|dub)/)
    if (m2) return anipubTryDownloadDirect(from, m2[1])
    return sendMessage(from, 'Je ne reconnais pas ce lien AniPub.\nEnvoie un lien de recherche (anipub.xyz/search/…) ou d\'épisode (anipub.xyz/AniPlayer/…), ou tape `a <anime>`.')
  } catch (err) {
    return sendMessage(from, `⚠️ Erreur AniPub : ${err.message}`)
  }
}

async function anipubSearchFlow(from, q) {
  try {
    const results = await anipubSearch(q)
    if (!results.length) return sendMessage(from, `Aucun anime trouvé pour « ${q} » sur AniPub.`)
    pending.set(from, { kind: 'anipub-search', results, ts: Date.now() })
    const lines = results.map(
      (r, i) => `${i + 1}. ${r.name}${r.epCount ? ` (${r.epCount} ép.)` : ''}${r.score ? ` ⭐ ${r.score}` : ''}`
    )
    await sendMessage(
      from,
      `🎌 AniPub — « ${q} » :\n\n${lines.join('\n')}\n\nRéponds avec le numéro (1-${results.length}). ⏱️ (10 min)`
    )
  } catch (err) {
    return sendMessage(from, `⚠️ Recherche AniPub impossible : ${err.message}`)
  }
}

async function anipubTryDownloadDirect(from, gogoId) {
  try {
    const media = await anipubResolveMedia(gogoId)
    if (!media.ok) {
      return sendMessage(
        from,
        `⚠️ Le CDN d'AniPub bloque les téléchargements depuis le serveur (${media.why}).\n` +
          `C'est leur anti-bot Cloudflare : il laisse passer les connexions "résidentielles" (ton téléphone) mais pas les serveurs.\n\n` +
          `Options :\n` +
          `• 📱 Regarder sur ton téléphone (le lien que tu m'as envoyé)\n` +
          `• 🎬 Chercher sur YouTube : a <nom de l'anime> ep <numéro>\n` +
          `• Crunchyroll si tu as un compte : envoie le lien crunchyroll.com`
      )
    }
    const playlist = await anipubBuildPlaylist(media.m3u8, DL_DIR)
    const dl = await downloadHls(playlist, 'Vidéo AniPub')
    if (dl.tooBig) return sendMessage(from, '⚠️ Trop volumineux même en fichier (max ~180 Mo).')
    const ext = path.extname(dl.path).slice(1).toLowerCase()
    const mime = MIME_BY_EXT[ext] || 'video/mp4'
    await sendDocument(from, dl.path, mime, `Vidéo AniPub (${Math.round(dl.size / 1048576)} Mo)`)
    fs.rmSync(dl.path, { force: true })
  } catch (err) {
    return sendMessage(from, `⚠️ Erreur AniPub : ${err.message}`)
  }
}

async function anipubTryDownload(from, finder, epNumber, name = '') {
  try {
    await sendMessage(from, '⏳ Je cherche le flux de l\u2019épisode…')
  } catch {}
  try {
    const ep = await anipubEpisodeId(finder, epNumber - 1)
    if (!ep) return sendMessage(from, `⚠️ Épisode ${epNumber} introuvable sur AniPub.`)
    const media = await anipubResolveMedia(ep.gogoId)
    if (!media.ok) {
      const watch = `https://anipub.xyz/AniPlayer/${finder}/${epNumber - 1}`
      return sendMessage(
        from,
        `⚠️ Le CDN d'AniPub bloque les téléchargements depuis le serveur (${media.why}).\n` +
          `C'est leur anti-bot Cloudflare : il laisse passer ton téléphone mais pas les serveurs — ce n'est pas un bug du bot.\n\n` +
          `${name ? name + ' — ' : ''}épisode ${epNumber} :\n` +
          `• 📱 Regarder/télécharger sur ton téléphone : ${watch}\n` +
          `• 🎬 Chercher sur YouTube : a ${name || 'cet anime'} ep ${epNumber}\n` +
          `• Crunchyroll si tu as un compte : envoie le lien crunchyroll.com`
      )
    }
    const playlist = await anipubBuildPlaylist(media.m3u8, DL_DIR)
    const dl = await downloadHls(playlist, `${name} — épisode ${epNumber}`.trim())
    if (dl.tooBig) return sendMessage(from, '⚠️ Trop volumineux même en fichier (max ~180 Mo).')
    const ext = path.extname(dl.path).slice(1).toLowerCase()
    const mime = MIME_BY_EXT[ext] || 'video/mp4'
    await sendDocument(from, dl.path, mime, `${name ? name + ' — ' : ''}épisode ${epNumber} (${Math.round(dl.size / 1048576)} Mo)`)
    fs.rmSync(dl.path, { force: true })
  } catch (err) {
    await sendMessage(from, `⚠️ Erreur AniPub : ${err.message}`)
  }
}

// --- Anime VF réelle (nyaa + aria2) ------------------------------------------
const VF_MIME = { mkv: 'video/x-matroska', mp4: 'video/mp4', avi: 'video/x-msvideo', webm: 'video/webm' }

async function vfFlow(from, q) {
  try {
    await sendMessage(from, `🎌 Recherche d'une vraie VF pour « ${q} » sur nyaa…`)
  } catch {}
  let best, all
  try {
    ;({ best, all } = await vfPick(q))
  } catch (e) {
    return sendMessage(from, `⚠️ Recherche impossible : ${e.message}`)
  }
  if (!best) {
    const fr = (all || []).filter((i) => /VF|VOSTFR|FRENCH/i.test(i.title)).slice(0, 3)
    const extra = fr.length
      ? `\n\nTrouvé mais indisponible (trop volumineux ou 0 seeders) :\n${fr.map((f) => `• ${f.title}`).join('\n')}`
      : `\n\nCe titre n'a pas de VF sur nyaa (Naruto, One Piece… sont dublés par TF1/ADN, pas Crunchyroll).\nAlternatives : \`a ${q}\` (YouTube) ou le site Crunchyroll.`
    return sendMessage(from, `❌ Pas d'épisode VF téléchargeable pour « ${q} » (limite ${VF_MAX_MB} Mo / seeders requis).${extra}`)
  }
  const mo = Math.round(best.size / 1048576)
  try {
    await sendMessage(
      from,
      `✅ ${best.title}\n📦 ${mo} Mo • 🔻 seeders : ${best.seeds}${best.leech ? ` (leechers : ${best.leech})` : ''}\n⏳ Téléchargement… (1-5 min, patience)`
    )
  } catch {}
  let file = null
  try {
    file = await vfDownload(best.link)
  } catch (e) {
    vfClean([file])
    return sendMessage(from, `⚠️ Téléchargement échoué : ${e.message}\nRetente dans quelques minutes (peu de seeders sur les épisodes très récents).`)
  }
  let finalFile = file
  let note = ''
  try {
    const r = vfMakeFrench(file)
    finalFile = r.file
    note = r.note
  } catch (e) {
    note = '⚠️ vérification audio impossible'
  }
  const sz = fs.statSync(finalFile).size
  if (sz > 480 * 1024 * 1024) {
    vfClean([file, finalFile === file ? null : file])
    return sendMessage(from, `⚠️ Le fichier fait ${Math.round(sz / 1048576)} Mo, trop gros pour WhatsApp.`)
  }
  const ext = path.extname(finalFile).slice(1).toLowerCase() || 'mkv'
  try {
    await sendDocument(from, finalFile, VF_MIME[ext] || 'video/x-matroska', `${best.title}\n\n📎 Fichier vidéo VF (${Math.round(sz / 1048576)} Mo)${note ? ' — ' + note : ''}\nAppuie dessus pour le télécharger et le lire.`)
  } catch (e) {
    vfClean([file, finalFile === file ? null : file])
    return sendMessage(from, `⚠️ Envoi impossible : ${e.message}`)
  }
  vfClean([file, finalFile === file ? null : file])
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

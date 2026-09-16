# 🎬 Bot WhatsApp Vidéo — recherche & téléchargement

Bot WhatsApp (Node.js + Baileys + **yt-dlp** + **API de secours**) qui
**recherche** et **télécharge des vidéos** depuis pratiquement tous les
réseaux — YouTube, TikTok, Facebook, Instagram, X, Dailymotion, Vimeo…
(+1000 sites) — et vous **renvoie la vidéo directement dans la conversation**.

- Connexion au compte : **code d'appairage** (pas de QR, **pas d'app Meta**, pas de webhook)
- Hébergement : **Render**
- Téléchargements : `yt-dlp` local (binaire autonome) **→** si échec (ex.
  anti-bot YouTube), bascule automatique sur une **API de secours** testée
  (voir §6)

```
whatsapp-bot/
├── server.js        # Serveur Express : état, /pair (code), /backup, /restore
├── whatsapp.js      # Connexion Baileys : socket, appairage, envoi texte/vidéo
├── bot.js           #  LOGIQUE DU BOT : liens, recherche, choix n°
├── downloader.js    # yt-dlp local + API de secours + gestion des tailles
├── setup.js         # Télécharge le binaire yt-dlp (au build, postinstall)
├── deobf/           # Code déobfusqué des plugins fournis + testeur d'APIs
│   ├── ytb.deobf.js / dl.deobf.js   (le « vrai code » des plugins obfusqués)
│   └── test_apis.mjs                (relance les tests des 5 endpoints)
├── package.json     # type: module (ESM)
├── Procfile / render.yaml
├── .env.example
└── README.md
```

## Comment l'utiliser (depuis WhatsApp)

| Vous envoyez | Le bot fait |
|---|---|
| Un **lien** (YouTube, TikTok, FB, Instagram, X…) | ⏳ Télécharge → 📹 envoie la vidéo |
| `s mot-clé` (ou `recherche mot-clé`) | 🔍 5 résultats YouTube (titre + durée) |
| `2` | Télécharge le résultat n° 2 (recherches valables 10 min) |
| `aide` | Le menu complet |

## 1. Déployer sur Render

1. Poussez ce dossier dans un dépôt **GitHub**.
2. [render.com](https://render.com) → **New** → **Web Service** → votre dépôt.
3. Configuration :
   - **Build command** : `npm install` *(le postinstall installe yt-dlp)*
   - **Start command** : `npm start`
   - **Runtime** : Node ≥ 18
4. Onglet **Environment** :

   | Variable | Valeur |
   |---|---|
   | `MY_PHONE_NUMBER` | votre numéro international **sans +** (ex. `22901234567`) |
   | `PAIR_SECRET` | chaîne secrète (protège `/pair`) |
   | `YOUTUBE_COOKIES` | *(optionnel, recommandé)* voir §7 |
   | `DOWNLOAD_API` | *(optionnel)* API de secours, vide pour désactiver |
   | `AUTH_DIR` | *(optionnel)* chemin d'un disque attaché, ex. `/auth` |
   | `ALLOWED_FROM` | *(optionnel)* numéros autorisés, virgules |

5. **Deploy**. Notez l'URL : `https://mon-bot.onrender.com`.

## 2. Lier votre téléphone (2 minutes)

1. Ouvrez **`https://mon-bot.onrender.com/pair?key=VOTRE_CLE`**
2. Un code de 8 caractères s'affiche — saisissez-le **rapidement** (~1 min).
3. Sur le téléphone : **WhatsApp → Paramètres → Appareils liés → Lier un
   appareil → « Lier avec un numéro de téléphone »** → code → Terminé.
4. `https://mon-bot.onrender.com/` affiche **✅ Lié au compte WhatsApp**.

## 3. Conserver la session entre les redémarrages (IMPORTANT)

**Le disque du free plan Render est éphémère** : il est effacé à chaque
déploiement **et à chaque recyclage d'instance** (Render recycle les
instances gratuites périodiquement, même sans déploiement). Conséquence :
l'appairage peut « disparaître » — la page passera de « ✅ Lié » à
« 🔴 Non lié » et l'appareil se déconnectera du téléphone. C'est normal,
ce n'est pas un bug du bot.

- **Option A (recommandée, ~1 $/mois) — fin des re-appairages** :
  Render → votre service → **Disks** → *Attach New Disk* → chemin
  **`/auth`** (1 Go suffit) → puis dans **Environment** ajouter
  `AUTH_DIR=/auth` → redeploy. La session survit alors à tous les
  redémarrages et déploiements.
- **Option B (gratuite)** : après l'appairage, `GET /backup?key=CLE` →
  gardez précieusement le JSON ; quand la session disparaît,
  `POST /restore?key=CLE` avec ce JSON (`curl -X POST … -d @backup.json`).
- **`/reset`** : si la session est morte/corrompue (ex. la page disait « lié »
  mais aucun appareil sur le téléphone), ouvrez `/reset?key=CLE` : la session
  est effacée, le bot se reconnecte, puis refaites `/pair` avec un nouveau code.

Le **watchdog** intégré (toutes les 10 s) reconstruit automatiquement la
connexion WebSocket après un sommeil/coupure ; `GET /` affiche l'état en
temps réel (connexion + liaison) et se recharge toute seule.

## 4. Personnaliser le bot

Toute la logique est dans **`bot.js`** ; les fonctions de téléchargement dans
**`downloader.js`** (`searchVideos(query, limit)`, `downloadVideo(url)`).

## 5. Chaîne de téléchargement, formats et taille

Pour chaque lien, le bot essaie dans l'ordre :

1. **yt-dlp local** — 480p MP4 → 360p MP4 → 480p autre → meilleur format
   (redescend si le fichier dépasse ~15 Mo, limite des médias WhatsApp)
2. **API de secours** (`DOWNLOAD_API`) — si yt-dlp échoue (anti-bot, site
   bloqué…) : voir §6
3. Sinon : message d'erreur clair ; si la vidéo est simplement **trop grosse**,
   le lien direct est renvoyé à la place

`--no-playlist` : sur un lien de playlist, seul le premier titre est pris.

## 6. 🔌 API de secours — résultats des tests (16/09/2026)

L'API `https://apischristus.vercel.app` (celle du plugin `ytb` déobfusqué
dans `deobf/ytb.deobf.js`) a été testée endpoint par endpoint avec de vrais
liens, **et les liens médias renvoyés ont été réellement téléchargés** :

| Endpoint | Résultat |
|---|---|
| `GET /api/search/youtube?q=&limit=` | ✅ 200 en 2 s — 6 résultats : `title, url, thumbnail, duration, seconds, views, author` |
| `GET /api/download/youtube?url=` | ✅ 200 en 2 s — `medias[]` : MP4 720p + MP3 128kbps |
| `GET /api/auto?url=` (YouTube) | ✅ 200 en 1 s — idem |
| `GET /api/auto?url=` (Facebook) | ✅ 200 en 1 s — MP4 |
| `GET /api/auto?url=` (TikTok) | ❌ 502 — « IP bloquée » (TikTok bloque les datacenters) |
| `GET /api/auto?url=` (Instagram) | ❌ 502 — « login required » |
| `GET /api/auto?url=` (Dailymotion) | ❌ 502 — « No video formats found » |

Vérifications fichier : le MP4 YouTube retourné est un **vrai MP4 de
11,3 Mo** (vidéo de 3:33 en 720p → passe sous la limite WhatsApp de 15 Mo),
le MP3 fait 3,3 Mo. `test_apis.mjs` (dossier `deobf/`) relance tous les tests.

L'API **`downloader-christus.onrender.com`** (plugin `dl` / `deobf/dl.deobf.js`)
a été testée aussi : `/api/supported` ✅ (41 domaines), Facebook ✅, YouTube
**audio** ✅ mais YouTube **vidéo** ❌ (proxy 502, anti-bot), TikTok ❌, et sa
réponse n'expose pas de champ `video`/`mp4` (le plugin `dl` tombe donc sur
l'audio pour YouTube — bug latent). C'est pourquoi le **fallback intégré au
bot utilise l'API Vercel**, la plus fiable au moment du test.

> ⚠️ Ce sont des **services tiers gratuits** (Vercel/Render free tier) :
> latence variable (1–35 s, froid au réveil), sans garantie de disponibilité.
> Le bot les utilise **uniquement en secours**, après le yt-dlp local, avec
> timeout (90 s) — ils ne sont jamais un point de défaillance unique.
> Les liens que vous envoyez au bot transitent par ce service en cas de secours.
> Mettez `DOWNLOAD_API=` (vide) pour désactiver le recours à ce tiers.

## 7. 🍪 Cookies YouTube (si l'anti-bot persiste)

Avec le fallback, YouTube fonctionne déjà dans la grande majorité des cas.
Si les deux échouent (le serveur est géo-bloqué, l'API de secours est en
panne), donner vos **cookies YouTube** au yt-dlp local :

1. Extension navigateur **« Get cookies.txt LOCALLY »**.
2. Sur `youtube.com` connecté → **Export**.
3. `base64 -w0 cookies.txt` (Linux/Mac) ou
   `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt"))` (Windows).
4. Collez dans **`YOUTUBE_COOKIES`** sur Render → redeploy.

(Le fichier n'est utilisé que pour les URLs YouTube ; ne partagez jamais cette variable.)

## 8. Limites et points de vigilance

- **Protocole non officiel** (Baileys) : stable en usage modéré ; risque de
  bannissement en cas de spam. `ALLOWED_FROM` pour restreindre l'accès.
- **Les réponses partent de votre numéro** : les contacts voient « vous ».
- **Free plan Render** : sommeil après ~15 min sans HTTP ; reconnexion
  automatique au réveil (messages pendant le sommeil perdus). 24/7 → plan payant
  ou ping toutes les 10 min.
- **TikTok / Instagram depuis un serveur** : quasi systématiquement bloqués
  (datacenter IP) — tant par yt-dlp local que par les APIs de secours. Un
  lien TikTok/IG ne fonctionnera que si l'IP du serveur n'est pas bloquée.
- **Un seul lien actif** : ne liez pas le même numéro à deux instances du bot.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `yt-dlp introuvable` | postinstall non exécuté → relancer le build |
| « Sign in to confirm you're not a bot » | anti-bot YouTube → le fallback tente l'API §6 ; sinon cookies §7 |
| « Vidéo trop volumineuse » | > 15 Mo même en petit format → lien renvoyé à la place |
| Échec TikTok / Instagram | IP du serveur bloquée par le réseau (voir §8) |
| Le bot ne répond pas | endormi (free plan), ou `ALLOWED_FROM` filtre l'expéditeur |
| Code d'appairage non lié | code expiré (~1 min) → recharger `/pair` ; vérifier `MY_PHONE_NUMBER` |
| La page affichait « lié » mais aucun appareil sur le téléphone | session effacée par Render (free tier) → `/reset` puis `/pair` ; prévoir le disque §3 |
| `/pair` : « Le bot se reconnecte… » | le service vient de se réveiller → la page se recharge seule (~30 s) |
| Fallback lent/absent | service tiers en panne ou endormi → le log montre « API de secours indisponible » |

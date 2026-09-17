// WORKER "anipub-proxy" → nouveau rôle : boîte de sauvegarde de la session WhatsApp du bot.
// À coller EN TOUT (remplace le code actuel) dans :
//   dash.cloudflare.com → Workers & Pages → anipub-proxy → Settings → Code → Edit code
// Puis lier le KV "botbackup" (voir instructions) dans Settings → Bindings.
const SECRET = '0017248a6987a119e9637faf';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || request.headers.get('x-backup-key') || '';

    if (url.pathname === '/' || url.pathname === '/ping') {
      return Response.json({ ok: true, service: 'bot-backup' });
    }

    if (key !== SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    if (url.pathname === '/backup') {
      if (request.method === 'GET') {
        if (!env.BACKUP) return Response.json({ ok: false, error: 'KV BACKUP non lié' });
        const v = await env.BACKUP.get('session', 'json');
        if (!v || !v.files) return Response.json({ ok: false, error: 'aucune sauvegarde' });
        return Response.json({ ok: true, generatedAt: v.generatedAt, files: v.files });
      }
      if (request.method === 'POST') {
        if (!env.BACKUP) return Response.json({ ok: false, error: 'KV BACKUP non lié' });
        const body = await request.json();
        if (!body || typeof body.files !== 'object') {
          return new Response('payload invalide : { files: {...} } attendu', { status: 400 });
        }
        const payload = JSON.stringify({ generatedAt: new Date().toISOString(), files: body.files });
        await env.BACKUP.put('session', payload);
        return Response.json({ ok: true, size: payload.length });
      }
      return new Response('méthode non supportée', { status: 405 });
    }

    return new Response('not found', { status: 404 });
  },
};

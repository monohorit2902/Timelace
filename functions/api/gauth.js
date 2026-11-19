/* Timelace · Google sign-in helper (Cloudflare Pages Function, served at /api/gauth)
   Keeps the app connected to Google Drive without asking again every hour.
   - The long-lasting Google "refresh token" is encrypted and kept ONLY in a cookie on the person's own device.
     Nothing is stored on any server; this function just swaps it for a fresh 1-hour pass.
   - Needs three variables in Cloudflare (Pages project -> Settings -> Variables and Secrets):
       GOOGLE_CLIENT_ID      ...apps.googleusercontent.com   (plain text is fine)
       GOOGLE_CLIENT_SECRET  from the same Google OAuth client (type: Secret)
       SESSION_SECRET        any long random text            (type: Secret)
   Routes (all POST, same-site only):  ?a=config | ?a=exchange | ?a=token | ?a=logout          */

const COOKIE = 'tl_rt';
const MAX_AGE = 60 * 60 * 24 * 400; // ~13 months
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function key(secret) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(String(secret || '')));
  return crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(text, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), enc.encode(text));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return b64u(out);
}
async function open(sealed, secret) {
  try {
    const b = unb64u(sealed);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await key(secret), b.slice(12));
    return dec.decode(pt);
  } catch { return ''; }
}
const getCookie = req => {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? m[1] : '';
};
const setCookie = v => `${COOKIE}=${v}; Path=/api/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
const clearCookie = () => `${COOKIE}=; Path=/api/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/* only this site may call it */
function sameSite(req) {
  const o = req.headers.get('origin') || '';
  if (!o) return false;
  try { return new URL(o).host === new URL(req.url).host; } catch { return false; }
}

async function google(env, params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params })
  });
  let j = {}; try { j = await r.json(); } catch {}
  return { ok: r.ok, j };
}

export async function onRequest({ request: req, env }) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!sameSite(req)) return json({ error: 'origin' }, 403);
  const a = new URL(req.url).searchParams.get('a');
  const ready = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);

  if (a === 'config') return json({ clientId: env.GOOGLE_CLIENT_ID || '', server: ready });
  if (!ready) return json({ error: 'not_configured' }, 503);

  if (a === 'exchange') {               // first connect: one-time code -> tokens
    let code = '';
    try { code = String((await req.json()).code || ''); } catch {}
    if (!code) return json({ error: 'code' }, 400);
    const { ok, j } = await google(env, { code, grant_type: 'authorization_code', redirect_uri: 'postmessage' });
    if (!ok || !j.access_token) return json({ error: j.error || 'exchange' }, 400);
    const headers = j.refresh_token ? { 'Set-Cookie': setCookie(await seal(j.refresh_token, env.SESSION_SECRET)) } : {};
    return json({ access_token: j.access_token, expires_in: j.expires_in || 3600, long: !!j.refresh_token }, 200, headers);
  }

  if (a === 'token') {                  // every hour or so: silent new pass
    const rt = await open(getCookie(req), env.SESSION_SECRET);
    if (!rt) return json({ error: 'signed_out' }, 401, { 'Set-Cookie': clearCookie() });
    const { ok, j } = await google(env, { refresh_token: rt, grant_type: 'refresh_token' });
    if (!ok || !j.access_token) {
      const gone = j.error === 'invalid_grant';
      return json({ error: j.error || 'refresh' }, gone ? 401 : 502, gone ? { 'Set-Cookie': clearCookie() } : {});
    }
    return json({ access_token: j.access_token, expires_in: j.expires_in || 3600 });
  }

  if (a === 'logout') {                 // disconnect: tell Google, forget the cookie
    const rt = await open(getCookie(req), env.SESSION_SECRET);
    if (rt) { try { await fetch(REVOKE_URL + '?token=' + encodeURIComponent(rt), { method: 'POST' }); } catch {} }
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  return json({ error: 'route' }, 404);
}

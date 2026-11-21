/* Timelace · reminders when the app is closed (Cloudflare Pages Function, served at /api/push)
   Stores, per device, ONLY: the browser's push address and the times a reminder is due (numbers).
   No plan names, no text, no account. The reminder text stays on the person's phone.
   A small companion Worker (push-worker.js) wakes every minute and sends an empty "wake up" push
   to each device that has a reminder due; the phone then shows its own reminder.
   Needs in Cloudflare (Pages project -> Settings):
     - Bindings: D1 database, variable name  DB
     - Variables: VAPID_PUBLIC   (from the Worker's /new-keys page; plain text is fine)
   Routes (POST, same-site only):  ?a=key | ?a=sync | ?a=off | ?a=test | ?a=stat                                   */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function sameSite(req) {
  const o = req.headers.get('origin') || '';
  if (!o) return false;
  try { return new URL(o).host === new URL(req.url).host; } catch { return false; }
}
/* only real browser push services may be stored (never an arbitrary web address) */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
function okEndpoint(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.some(r => r.test(x.hostname)); } catch { return false; }
}
async function ensure(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, sub TEXT NOT NULL, upd INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS due (sid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (sid, at))'),
    db.prepare('CREATE INDEX IF NOT EXISTS due_at ON due (at)')
  ]);
}

export async function onRequestPost({ request: req, env }) {
  if (!sameSite(req)) return json({ error: 'origin' }, 403);
  const a = new URL(req.url).searchParams.get('a');
  if (a === 'key') return env.VAPID_PUBLIC && env.DB ? json({ key: env.VAPID_PUBLIC }) : json({ error: 'not_set_up' }, 503);
  if (!env.DB) return json({ error: 'not_set_up' }, 503);
  let b = {}; try { b = await req.json(); } catch {}
  const id = String(b.id || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return json({ error: 'id' }, 400);
  await ensure(env.DB);

  /* a test: wake this device on the sender's next run (within about a minute) */
  if (a === 'test') {
    await env.DB.prepare('INSERT OR IGNORE INTO due (sid, at) VALUES (?, ?)').bind(id, Date.now()).run();
    return json({ ok: true });
  }
  /* what happened: is the sender running, and what did the push service answer last time for this device */
  if (a === 'stat') {
    let cron = 0, last = null, next = 0, has = false;
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS log (sid TEXT PRIMARY KEY, at INTEGER NOT NULL, st INTEGER NOT NULL)').run();
      const c = await env.DB.prepare('SELECT at FROM log WHERE sid=?').bind('~cron').first(); cron = c ? c.at : 0;
      last = (await env.DB.prepare('SELECT at, st FROM log WHERE sid=?').bind(id).first()) || null;
      const n = await env.DB.prepare('SELECT MIN(at) AS m FROM due WHERE sid=?').bind(id).first(); next = (n && n.m) || 0;
      has = !!(await env.DB.prepare('SELECT 1 FROM subs WHERE id=?').bind(id).first());
    } catch {}
    return json({ ok: true, now: Date.now(), cron, last, next, has });
  }
  if (a === 'off') {
    await env.DB.batch([env.DB.prepare('DELETE FROM due WHERE sid=?').bind(id), env.DB.prepare('DELETE FROM subs WHERE id=?').bind(id)]);
    return json({ ok: true });
  }
  if (a === 'sync') {
    const sub = b.sub || {};
    if (!okEndpoint(sub.endpoint)) return json({ error: 'endpoint' }, 400);
    const now = Date.now(), max = now + 15 * 864e5;
    const times = [...new Set((Array.isArray(b.times) ? b.times : []).map(Number).filter(t => Number.isFinite(t) && t > now - 60000 && t < max).map(t => Math.floor(t / 60000) * 60000))].slice(0, 300);
    const st = [
      env.DB.prepare('INSERT INTO subs (id, sub, upd) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET sub=excluded.sub, upd=excluded.upd').bind(id, JSON.stringify({ endpoint: sub.endpoint }), now),
      env.DB.prepare('DELETE FROM due WHERE sid=?').bind(id)
    ];
    times.forEach(t => st.push(env.DB.prepare('INSERT OR IGNORE INTO due (sid, at) VALUES (?, ?)').bind(id, t)));
    await env.DB.batch(st);
    return json({ ok: true, n: times.length });
  }
  return json({ error: 'route' }, 404);
}

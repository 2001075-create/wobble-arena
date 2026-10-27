'use strict';
/*
  Wobble Arena accounts: sign up, log in, log out and cloud saves.

  Where the data lives:
    - if UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set (a free Upstash database): there. It survives restarts and redeploys.
    - otherwise in a file (./data/db.json, or DATA_DIR). Fine on your own computer. On Render's free plan that file is wiped every redeploy.

  Passwords are never stored: only a salted scrypt hash. Logging in gives a random token that the game keeps in the browser.
*/
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ---------------- storage ---------------- */
function upstashStore(url, token) {
  url = url.replace(/\/+$/, '');
  const cmd = async arr => {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(arr) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('store: ' + (j.error || r.status));
    return j.result;
  };
  return {
    kind: 'upstash',
    async get(k) { const v = await cmd(['GET', k]); return v === undefined ? null : v; },
    async set(k, v, o) { o = o || {}; const a = ['SET', k, v]; if (o.nx) a.push('NX'); if (o.ex) a.push('EX', String(o.ex)); return (await cmd(a)) === 'OK'; },
    async del(k) { await cmd(['DEL', k]); },
  };
}
function fileStore(dir) {
  const file = path.join(dir, 'db.json'); let db = {}, timer = null;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { db = {}; }
  const flush = () => {
    timer = null;
    try { fs.mkdirSync(dir, { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, file); } catch (e) { console.error('could not write the accounts file:', e.message); }
  };
  const later = () => { if (!timer) timer = setTimeout(flush, 400); if (timer.unref) timer.unref(); };
  const live = k => { const e = db[k]; if (!e) return null; if (e.e && e.e < Date.now()) { delete db[k]; return null; } return e; };
  return {
    kind: 'file',
    flush,
    async get(k) { const e = live(k); return e ? e.v : null; },
    async set(k, v, o) { o = o || {}; if (o.nx && live(k)) return false; db[k] = { v, e: o.ex ? Date.now() + o.ex * 1000 : 0 }; later(); return true; },
    async del(k) { delete db[k]; later(); },
  };
}
function makeStore() {
  const u = process.env.UPSTASH_REDIS_REST_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (u && t) return upstashStore(u, t);
  return fileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
}

/* ---------------- helpers ---------------- */
const TOKEN_DAYS = 365, SAVE_MAX = 250 * 1024;
const RESERVED = new Set(['admin', 'administrator', 'mod', 'moderator', 'owner', 'staff', 'support', 'guest', 'system', 'server', 'wobble', 'wobblearena', 'root', 'null', 'undefined']);
const USER_RE = /^[A-Za-z0-9_]{3,16}$/, EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPw(pw) { const salt = crypto.randomBytes(16); return 's1$' + salt.toString('hex') + '$' + (await scrypt(pw, salt)).toString('hex'); }
async function checkPw(pw, stored) {
  const [v, s, h] = String(stored || '').split('$'); if (v !== 's1' || !s || !h) return false;
  const k = await scrypt(pw, Buffer.from(s, 'hex')), b = Buffer.from(h, 'hex');
  return k.length === b.length && crypto.timingSafeEqual(k, b);
}
const RC_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRecovery = () => { const b = crypto.randomBytes(16); let o = ''; for (let i = 0; i < 16; i++) { o += RC_CHARS[b[i] % RC_CHARS.length]; if (i % 4 === 3 && i < 15) o += '-'; } return o; };       // 16 letters and numbers, shown as XXXX-XXXX-XXXX-XXXX
const cleanRecovery = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const newToken = () => crypto.randomBytes(32).toString('hex');
const lname = u => String(u).toLowerCase();

class Fail extends Error { constructor(status, err, msg) { super(msg); this.status = status; this.err = err; } }

function create(store) {
  store = store || makeStore();
  const fails = new Map();                                            // ip or account -> {n, t}: failed log-ins in the last 10 minutes
  const WINDOW = 10 * 60 * 1000;
  const failCount = k => { const f = fails.get(k); if (!f) return 0; if (Date.now() - f.t > WINDOW) { fails.delete(k); return 0; } return f.n; };
  const addFail = k => { const f = fails.get(k); if (f && Date.now() - f.t <= WINDOW) f.n++; else fails.set(k, { n: 1, t: Date.now() }); };
  const signups = new Map();                                          // ip -> {n, t}: sign-ups in the last hour
  const lastSave = new Map();                                         // account -> time of the last save (one a second at most)

  const getUser = async l => { const v = await store.get('user:' + l); try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  const putUser = (l, u) => store.set('user:' + l, JSON.stringify(u));
  async function issue(l) { const t = newToken(); await store.set('tok:' + t, l, { ex: TOKEN_DAYS * 86400 }); return t; }
  async function who(token) {                                          // token -> account record, or null
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const l = await store.get('tok:' + token); if (!l) return null;
    const u = await getUser(l); return u ? { l, u } : null;
  }
  const pub = u => ({ username: u.u, email: u.e, created: u.c });
  async function loadData(l) { const v = await store.get('data:' + l); try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  const routes = {
    async signup(b, ctx) {
      const un = String(b.username || '').trim(), em = String(b.email || '').trim(), pw = String(b.password || '');
      if (!USER_RE.test(un)) throw new Fail(400, 'username', 'Usernames are 3 to 16 letters, numbers or underscores.');
      if (RESERVED.has(lname(un))) throw new Fail(400, 'username', 'That username is not allowed. Pick another one.');
      if (em.length > 100 || !EMAIL_RE.test(em)) throw new Fail(400, 'email', 'That email does not look right.');
      if (pw.length < 6 || pw.length > 72) throw new Fail(400, 'password', 'Passwords are 6 to 72 characters.');
      const s = signups.get(ctx.ip); if (s && Date.now() - s.t < 3600000 && s.n >= 40) throw new Fail(429, 'slow', 'Too many new accounts from this network. Try again in a while.');
      const l = lname(un), le = lname(em);
      if (await store.get('user:' + l)) throw new Fail(409, 'username', 'That username is taken.');
      const rc = newRecovery();
      const user = { u: un, e: em, p: await hashPw(pw), r: await hashPw(cleanRecovery(rc)), c: Date.now(), l: Date.now() };
      if (!(await store.set('user:' + l, JSON.stringify(user), { nx: true }))) throw new Fail(409, 'username', 'That username is taken.');
      if (!(await store.set('email:' + le, l, { nx: true }))) { await store.del('user:' + l); throw new Fail(409, 'email', 'That email already has an account. Try logging in.'); }
      let t = 0;
      if (b.data && typeof b.data === 'object') { const j = JSON.stringify(b.data); if (j.length <= SAVE_MAX) { t = Date.now(); await store.set('data:' + l, JSON.stringify({ t, d: b.data })); } }
      if (s && Date.now() - s.t < 3600000) s.n++; else signups.set(ctx.ip, { n: 1, t: Date.now() });
      return { ok: true, token: await issue(l), user: pub(user), data: t ? b.data : null, t, recovery: rc };
    },
    async login(b, ctx) {
      const id = String(b.id || '').trim(), pw = String(b.password || '');
      if (!id || !pw) throw new Fail(400, 'missing', 'Type your username (or email) and password.');
      const l0 = id.includes('@') ? await store.get('email:' + lname(id)) : lname(id);
      if (failCount('ip:' + ctx.ip) >= 40 || failCount('acc:' + l0) >= 8) throw new Fail(429, 'slow', 'Too many wrong tries. Wait 10 minutes and try again.');
      const u = l0 ? await getUser(l0) : null;
      if (!u || !(await checkPw(pw, u.p))) { addFail('ip:' + ctx.ip); if (l0) addFail('acc:' + l0); throw new Fail(401, 'wrong', 'Wrong username or password.'); }
      fails.delete('acc:' + l0); u.l = Date.now(); await putUser(l0, u);
      const d = await loadData(l0);
      return { ok: true, token: await issue(l0), user: pub(u), data: d ? d.d : null, t: d ? d.t : 0 };
    },
    async me(b, ctx) {
      const a = await who(ctx.token); if (!a) throw new Fail(401, 'auth', 'Please log in again.');
      const d = await loadData(a.l);
      await store.set('tok:' + ctx.token, a.l, { ex: TOKEN_DAYS * 86400 });                // every visit renews the login, so people who keep playing stay logged in
      return { ok: true, user: pub(a.u), data: d ? d.d : null, t: d ? d.t : 0, hasRecovery: !!a.u.r };
    },
    async save(b, ctx) {
      const a = await who(ctx.token); if (!a) throw new Fail(401, 'auth', 'Please log in again.');
      if (!b.data || typeof b.data !== 'object') throw new Fail(400, 'data', 'Nothing to save.');
      const j = JSON.stringify(b.data); if (j.length > SAVE_MAX) throw new Fail(413, 'big', 'That save is too big.');
      const now = Date.now(), last = lastSave.get(a.l) || 0; if (now - last < 800) throw new Fail(429, 'fast', 'Saving too fast.');
      const cur = await loadData(a.l);
      if (cur && b.base !== undefined && (b.base | 0) < (cur.t | 0) && !b.force) return { ok: false, err: 'stale', msg: 'This account was saved on another device.', data: cur.d, t: cur.t };
      lastSave.set(a.l, now);
      await store.set('data:' + a.l, JSON.stringify({ t: now, d: b.data }));
      return { ok: true, t: now };
    },
    async logout(b, ctx) { if (ctx.token && /^[0-9a-f]{64}$/.test(ctx.token)) await store.del('tok:' + ctx.token); return { ok: true }; },
    async password(b, ctx) {
      const a = await who(ctx.token); if (!a) throw new Fail(401, 'auth', 'Please log in again.');
      const np = String(b.next || '');
      if (np.length < 6 || np.length > 72) throw new Fail(400, 'password', 'New passwords are 6 to 72 characters.');
      if (failCount('acc:' + a.l) >= 8) throw new Fail(429, 'slow', 'Too many wrong tries. Wait 10 minutes and try again.');
      if (!(await checkPw(String(b.old || ''), a.u.p))) { addFail('acc:' + a.l); throw new Fail(401, 'wrong', 'Your current password is wrong.'); }
      a.u.p = await hashPw(np); await putUser(a.l, a.u); return { ok: true };
    },
    async recovery(b, ctx) {                                              // make a new recovery code (needs the password); the old one stops working
      const a = await who(ctx.token); if (!a) throw new Fail(401, 'auth', 'Please log in again.');
      if (failCount('acc:' + a.l) >= 8) throw new Fail(429, 'slow', 'Too many wrong tries. Wait 10 minutes and try again.');
      if (!(await checkPw(String(b.password || ''), a.u.p))) { addFail('acc:' + a.l); throw new Fail(401, 'wrong', 'That password is wrong.'); }
      const rc = newRecovery(); a.u.r = await hashPw(cleanRecovery(rc)); await putUser(a.l, a.u);
      return { ok: true, recovery: rc };
    },
    async reset(b, ctx) {                                                 // forgot the password: username or email + recovery code + a new password
      const id = String(b.id || '').trim(), code = cleanRecovery(b.code), np = String(b.password || '');
      if (!id || !code) throw new Fail(400, 'missing', 'Type your username (or email) and your recovery code.');
      if (np.length < 6 || np.length > 72) throw new Fail(400, 'password', 'New passwords are 6 to 72 characters.');
      const l0 = id.includes('@') ? await store.get('email:' + lname(id)) : lname(id);
      if (failCount('ip:' + ctx.ip) >= 20 || failCount('acc:' + l0) >= 6) throw new Fail(429, 'slow', 'Too many wrong tries. Wait 10 minutes and try again.');
      const u = l0 ? await getUser(l0) : null;
      if (!u || !u.r || !(await checkPw(code, u.r))) { addFail('ip:' + ctx.ip); if (l0) addFail('acc:' + l0); throw new Fail(401, 'wrong', 'That username and recovery code do not match. Check the code (letters and numbers, no mix-ups between O and 0).'); }
      fails.delete('acc:' + l0);
      const rc = newRecovery(); u.p = await hashPw(np); u.r = await hashPw(cleanRecovery(rc)); u.l = Date.now(); await putUser(l0, u);
      const d = await loadData(l0);
      return { ok: true, token: await issue(l0), user: pub(u), data: d ? d.d : null, t: d ? d.t : 0, recovery: rc };
    },
    async remove(b, ctx) {
      const a = await who(ctx.token); if (!a) throw new Fail(401, 'auth', 'Please log in again.');
      if (failCount('acc:' + a.l) >= 8) throw new Fail(429, 'slow', 'Too many wrong tries. Wait 10 minutes and try again.');
      if (!(await checkPw(String(b.password || ''), a.u.p))) { addFail('acc:' + a.l); throw new Fail(401, 'wrong', 'That password is wrong.'); }
      await store.del('user:' + a.l); await store.del('email:' + lname(a.u.e)); await store.del('data:' + a.l); await store.del('tok:' + ctx.token);
      return { ok: true };
    },
  };
  const map = { '/api/signup': ['POST', 'signup'], '/api/login': ['POST', 'login'], '/api/me': ['GET', 'me'], '/api/save': ['PUT', 'save'], '/api/logout': ['POST', 'logout'], '/api/password': ['POST', 'password'], '/api/recovery': ['POST', 'recovery'], '/api/reset': ['POST', 'reset'], '/api/delete': ['POST', 'remove'] };

  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-max-age': '86400' };
  const reply = (res, status, obj) => { res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS)); res.end(JSON.stringify(obj)); };
  function readBody(req) {
    return new Promise((res, rej) => {
      let n = 0, over = false; const parts = [];
      req.on('data', c => { n += c.length; if (n > 5 * 1024 * 1024) { req.destroy(); return; } if (n > SAVE_MAX + 4096) { over = true; parts.length = 0; return; } if (!over) parts.push(c); });
      req.on('end', () => { if (over) { rej(new Fail(413, 'big', 'That save is too big.')); return; } try { res(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { rej(new Fail(400, 'json', 'Bad request.')); } });
      req.on('error', () => rej(new Fail(400, 'io', 'Bad request.')));
    });
  }
  // returns true when it handled the request
  function handle(req, res, ip) {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/api/')) return false;
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
    const r = map[url];
    if (!r || r[0] !== req.method) { reply(res, 404, { ok: false, err: 'none', msg: 'Not found.' }); return true; }
    const auth = String(req.headers.authorization || ''), token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    (async () => {
      try { const b = req.method === 'GET' ? {} : await readBody(req); const out = await routes[r[1]](b, { ip, token }); reply(res, out.ok === false ? 409 : 200, out); }
      catch (e) {
        if (e instanceof Fail) reply(res, e.status, { ok: false, err: e.err, msg: e.message });
        else { console.error('accounts error:', e && e.message); reply(res, 500, { ok: false, err: 'server', msg: 'The server had a problem. Try again in a moment.' }); }
      }
    })();
    return true;
  }
  return { handle, who, store, kind: store.kind, routes };
}

module.exports = { create, makeStore, fileStore, upstashStore };

'use strict';
/*
  Wobble Arena server
  - serves the game page (put the game file in ./public as index.html)
  - keeps the list of rooms and passes messages between the players of a room
  - the game itself still runs in the players' browsers: the room's host runs the bots, this server is the post office

  Run:   npm install && npm start        (PORT env var changes the port, default 3000)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const LIMITS = {
  rooms: 300,              // rooms at the same time
  conns: 3000,             // connections at the same time
  perRoom: 8,              // players in one room
  payload: 32 * 1024,      // biggest single message (bytes)
  rate: 400,               // messages per second a player may send (short bursts are fine)
  perIp: 40,               // connections from one address
};
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();   // id -> room
let roomCounter = 0, totalConns = 0;
const perIp = new Map();

/* ---------------- web page ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
function findIndex() {
  try {
    if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) return 'index.html';
    const f = fs.readdirSync(PUBLIC_DIR).find(n => /\.html?$/i.test(n));
    return f || null;
  } catch (e) { return null; }
}
const server = http.createServer((req, res) => {
  let url = '/';
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); res.end('bad request'); return; }
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: totalConns }));
    return;
  }
  let file = url === '/' ? findIndex() : url.replace(/^\/+/, '');
  if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('No game file found. Put the game file in the public folder as index.html'); return; }
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(path.normalize(PUBLIC_DIR + path.sep)) && full !== path.normalize(PUBLIC_DIR)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
});

/* ---------------- rooms ---------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.payload, perMessageDeflate: false });

const str = (v, n) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);
function cleanInfo(i, old) {
  i = i && typeof i === 'object' ? i : {};
  const o = Object.assign({ name: 'Room', host: '?', mode: 'classic', modeName: 'Classic', map: '', max: 4, started: false, build: '' }, old || {});
  if (i.name !== undefined) o.name = str(i.name, 24) || 'Room';
  if (i.host !== undefined) o.host = str(i.host, 12) || '?';
  if (i.mode !== undefined) o.mode = str(i.mode, 16);
  if (i.modeName !== undefined) o.modeName = str(i.modeName, 24);
  if (i.map !== undefined) o.map = str(i.map, 24);
  if (i.max !== undefined) o.max = Math.max(2, Math.min(LIMITS.perRoom, i.max | 0 || 4));
  if (i.started !== undefined) o.started = !!i.started;
  if (i.build !== undefined) o.build = str(i.build, 16);
  return o;
}
const humans = r => 1 + r.clients.size;
const publicView = r => ({ id: r.id, name: r.info.name, host: r.info.host, mode: r.info.mode, modeName: r.info.modeName, map: r.info.map, n: humans(r), max: r.info.max, started: r.info.started, build: r.info.build, pub: true });
function newCode() { for (let t = 0; t < 50; t++) { const c = Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join(''); if (!rooms.has(c)) return c; } return null; }
function findRoom(id) { id = str(id, 16); return rooms.get(id) || rooms.get(id.toUpperCase()) || rooms.get(id.toLowerCase()) || null; }

function send(ws, obj) {
  if (ws.readyState !== 1) return false;
  if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.terminate(); return false; }         // far behind: drop them
  if (ws.bufferedAmount > 1024 * 1024) return false;                                  // behind: skip this one, they will catch up
  try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (e) { return false; }
}
function leaveRoom(ws) {
  const r = ws.room; if (!r) return;
  if (ws.role === 'host') {                                          // the host left: the room closes for everyone
    rooms.delete(r.id);
    for (const [, c] of r.clients) { c.room = null; c.role = null; c.cid = 0; send(c, { op: 'hostgone' }); }
    r.clients.clear();
  } else if (ws.role === 'client') {
    r.clients.delete(ws.cid); send(r.host, { op: 'peer', cid: ws.cid, ev: 'close' });
  }
  ws.room = null; ws.role = null; ws.cid = 0;
}
function joinRoom(ws, r, build) {
  if (build && r.info.build && build !== r.info.build) { send(ws, { op: 'nojoin', reason: 'build' }); return false; }
  if (humans(r) >= r.info.max) { send(ws, { op: 'nojoin', reason: 'full' }); return false; }
  const cid = r.nextCid++; ws.room = r; ws.role = 'client'; ws.cid = cid; r.clients.set(cid, ws);
  send(ws, { op: 'joined', cid, id: r.id, pub: r.pub });
  send(r.host, { op: 'peer', cid, ev: 'open' });
  return true;
}

const handlers = {
  ping(ws, m) { send(ws, { op: 'pong', ts: m.ts }); },
  list(ws) { send(ws, { op: 'rooms', rooms: [...rooms.values()].filter(r => r.pub).map(publicView).sort((a, b) => b.n - a.n), online: totalConns }); },
  create(ws, m) {
    if (ws.room) { send(ws, { op: 'nocreate', reason: 'inroom' }); return; }
    if (rooms.size >= LIMITS.rooms) { send(ws, { op: 'nocreate', reason: 'busy' }); return; }
    const pub = !!m.pub; let id;
    if (pub) id = 'r' + (++roomCounter).toString(36); else { id = newCode(); if (!id) { send(ws, { op: 'nocreate', reason: 'busy' }); return; } }
    const r = { id, pub, host: ws, clients: new Map(), nextCid: 1, info: cleanInfo(m.info), created: Date.now() };
    rooms.set(id, r); ws.room = r; ws.role = 'host'; ws.cid = 0;
    send(ws, { op: 'created', id, pub });
  },
  update(ws, m) { if (ws.role === 'host' && ws.room) ws.room.info = cleanInfo(m.info, ws.room.info); },
  join(ws, m) {
    if (ws.room) { send(ws, { op: 'nojoin', reason: 'inroom' }); return; }
    const r = findRoom(m.id); if (!r) { send(ws, { op: 'nojoin', reason: 'none' }); return; }
    joinRoom(ws, r, str(m.build, 16));
  },
  quick(ws, m) {
    if (ws.room) { send(ws, { op: 'nomatch' }); return; }
    const mode = str(m.mode, 16), build = str(m.build, 16);
    const best = [...rooms.values()].filter(r => r.pub && r.info.mode === mode && (!build || !r.info.build || r.info.build === build) && humans(r) < r.info.max).sort((a, b) => humans(b) - humans(a))[0];
    if (!best) { send(ws, { op: 'nomatch' }); return; }
    joinRoom(ws, best, build);
  },
  tohost(ws, m) {
    if (ws.role !== 'client' || !ws.room || !m.m || typeof m.m !== 'object') return;
    send(ws.room.host, { op: 'msg', from: ws.cid, m: m.m });
  },
  to(ws, m) {
    if (ws.role !== 'host' || !ws.room || !m.m || typeof m.m !== 'object') return;
    const c = ws.room.clients.get(m.cid | 0); if (c) send(c, { op: 'msg', m: m.m });
  },
  all(ws, m) {
    if (ws.role !== 'host' || !ws.room || !m.m || typeof m.m !== 'object') return;
    const s = JSON.stringify({ op: 'msg', m: m.m }), ex = m.except | 0;
    for (const [cid, c] of ws.room.clients) if (cid !== ex) send(c, s);
  },
  close(ws, m) {                                                      // the host removes somebody from the room
    if (ws.role !== 'host' || !ws.room) return;
    const c = ws.room.clients.get(m.cid | 0); if (!c) return;
    ws.room.clients.delete(c.cid); c.room = null; c.role = null; c.cid = 0; send(c, { op: 'kicked' });
  },
  leave(ws) { leaveRoom(ws); send(ws, { op: 'left' }); },
};

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString().split(',')[0].trim();
  if (totalConns >= LIMITS.conns || (perIp.get(ip) || 0) >= LIMITS.perIp) { ws.close(1013, 'busy'); return; }
  totalConns++; perIp.set(ip, (perIp.get(ip) || 0) + 1);
  ws.room = null; ws.role = null; ws.cid = 0; ws.alive = true; ws.ip = ip; ws.tokens = LIMITS.rate; ws.tokT = Date.now(); ws.bad = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now(); ws.tokens = Math.min(LIMITS.rate * 1.5, ws.tokens + (now - ws.tokT) / 1000 * LIMITS.rate); ws.tokT = now;
    if (ws.tokens < 1) { if (++ws.bad > 200) ws.close(1008, 'too fast'); return; }
    ws.tokens--;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.op !== 'string') return;
    const h = Object.prototype.hasOwnProperty.call(handlers, m.op) ? handlers[m.op] : null;
    if (h) { try { h(ws, m); } catch (e) { console.error('handler error', m.op, e && e.message); } }
  });
  ws.on('close', () => {
    leaveRoom(ws); totalConns--;
    const n = (perIp.get(ws.ip) || 1) - 1; if (n <= 0) perIp.delete(ws.ip); else perIp.set(ws.ip, n);
  });
  ws.on('error', () => { /* the close handler tidies up */ });
  send(ws, { op: 'hi', online: totalConns });
});

const beat = setInterval(() => {                                      // drop connections that went silent
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) { /* gone */ } }
}, 20000);
const sweep = setInterval(() => { for (const [id, r] of rooms) if (r.host.readyState > 1) { leaveRoom(r.host); rooms.delete(id); } }, 30000);

function start(port) {
  return new Promise(res => server.listen(port === undefined ? PORT : port, () => { console.log('Wobble Arena server on port ' + server.address().port + ' (game files: ' + PUBLIC_DIR + ')'); res(server); }));
}
function stop() { clearInterval(beat); clearInterval(sweep); for (const ws of wss.clients) ws.terminate(); return new Promise(res => server.close(() => res())); }
if (require.main === module) { start(); process.on('SIGTERM', () => stop().then(() => process.exit(0))); }
module.exports = { start, stop, rooms, LIMITS, server };

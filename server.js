// Burger Bandit Island multiplayer server.
// Plain Node.js (18 or newer), no packages to install. Players connect over a WebSocket,
// join a room with a 4-letter code, and the server passes positions between them about 15 times a second.
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const PROTOCOL = 1;                                   // bump when the game and server must update together
const SERVER_CAP = +process.env.MAX_PLAYERS || 200;   // everyone on this server, all rooms together
const ROOM_MIN = 2, ROOM_MAX = 32, ROOM_DEFAULT = 12;
const TICK_MS = 66;                                   // ~15 snapshots a second
const NEAR = 700;                                     // metres: players closer than this are sent every tick
const FAR_EVERY = 15;                                 // further players are sent once a second (for the map)
const MAX_FRAME = 4096;                               // bytes; anything bigger is not from our game
const MSG_PER_SEC = 45, CHAT_GAP_MS = 700, CHAT_LEN = 120, NAME_LEN = 16;

// ---------------------------------------------------------------- word filter (names and chat)
const BAD = ['fuck', 'shit', 'cunt', 'bitch', 'nigg', 'fag', 'retard', 'whore', 'slut', 'dick', 'cock', 'pussy', 'rape', 'nazi', 'hitler', 'kike', 'spic', 'chink', 'twat', 'wank'];
const squash = s => s.toLowerCase().replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!|]/g, 'i').replace(/0/g, 'o').replace(/[5$]/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '');
const isBad = s => { const q = squash(s); return BAD.some(w => q.includes(w)); };
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
function cleanName(s, id) { const n = clean(s, NAME_LEN); return !n || isBad(n) ? 'Player' + (1000 + id % 9000) : n; }
function cleanChat(s) {
  let m = clean(s, CHAT_LEN);
  return m.split(' ').map(w => isBad(w) ? '*'.repeat(Math.min(6, w.length)) : w).join(' ');
}

// ---------------------------------------------------------------- tiny WebSocket (RFC 6455) layer
function wsAccept(key) { return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); }
function frame(op, payload) {
  const len = payload.length; let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op; return Buffer.concat([head, payload]);
}
class Conn {
  constructor(sock, onText, onClose) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.parts = []; this.open = true; this.onText = onText; this.onClose = onClose; this.last = Date.now();
    sock.setNoDelay(true);
    sock.on('data', d => this.data(d));
    sock.on('close', () => this.closed());
    sock.on('error', () => this.closed());
  }
  data(d) {
    this.last = Date.now(); this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.open) {
      const b = this.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
      if (!masked) return this.kill(1002);                       // browsers always mask
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return this.kill(1009); len = Number(big); off = 10; }
      if (len > MAX_FRAME) return this.kill(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), p = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) return this.kill(1000);
      if (op === 0x9) { this.raw(0xA, p); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.parts.push(p); const total = this.parts.reduce((a, x) => a + x.length, 0);
        if (total > MAX_FRAME) return this.kill(1009);
        if (fin) { const msg = Buffer.concat(this.parts).toString('utf8'); this.parts = []; try { this.onText(msg); } catch (e) { console.error('message error', e); } }
      }
    }
  }
  raw(op, p) { if (this.open && this.sock.writable) this.sock.write(frame(op, p)); }
  send(obj) { this.raw(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  ping() { this.raw(0x9, Buffer.alloc(0)); }
  kill(code) { if (!this.open) return; const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000); this.raw(0x8, p); this.sock.end(); this.closed(); }
  closed() { if (!this.open) return; this.open = false; try { this.sock.destroy(); } catch (e) { } this.onClose(); }
}

// ---------------------------------------------------------------- rooms and players
const rooms = new Map();      // code -> room
const players = new Set();
let nextId = 1, tickNo = 0;
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CH[crypto.randomInt(CODE_CH.length)]; if (!rooms.has(c) && !isBad(c)) return c; } }
const cleanLook = s => String(s == null ? '' : s).replace(/[^0-9a-z]/g, '').slice(0, 24);
const pub = p => ({ id: p.id, name: p.name, car: p.car, col: p.col, look: p.look || '' });
function roomMsg(r, p) { return { t: 'room', code: r.code, priv: r.priv, max: r.max, host: r.host, you: p.id, players: [...r.players.values()].map(pub), time: r.time }; }
function toRoom(r, obj, except) { const s = JSON.stringify(obj); for (const q of r.players.values()) if (q !== except) q.c.send(s); }

function createRoom(p, priv, max) {
  max = Math.round(+max); if (!(max >= ROOM_MIN)) max = ROOM_DEFAULT; max = Math.min(ROOM_MAX, max);
  const r = { code: newCode(), priv: !!priv, max, host: p.id, players: new Map(), time: null, made: Date.now() };
  rooms.set(r.code, r); joinRoom(p, r); return r;
}
function joinRoom(p, r) {
  if (p.room) leaveRoom(p, true);
  if (r.players.size >= r.max) return p.c.send({ t: 'err', m: 'Room ' + r.code + ' is full (' + r.max + ' players).' });
  if (r.banned && r.banned.has(p.ip)) return p.c.send({ t: 'err', m: 'You were removed from that room.' });
  r.players.set(p.id, p); p.room = r; p.state = null;
  p.c.send(roomMsg(r, p));
  toRoom(r, { t: 'pj', p: pub(p) }, p);
  log('join', r.code, p.name, r.players.size + '/' + r.max);
}
function leaveRoom(p, quiet) {
  const r = p.room; if (!r) return; r.players.delete(p.id); p.room = null; p.state = null;
  toRoom(r, { t: 'pl', id: p.id });
  if (!r.players.size) { rooms.delete(r.code); log('room closed', r.code); return; }
  if (r.host === p.id) { r.host = r.players.keys().next().value; toRoom(r, { t: 'host', id: r.host }); }
  if (!quiet) p.c.send({ t: 'left' });
}
function publicRooms() { return [...rooms.values()].filter(r => !r.priv && r.players.size < r.max).map(r => ({ code: r.code, n: r.players.size, max: r.max, host: (r.players.get(r.host) || {}).name || '' })).sort((a, b) => b.n - a.n).slice(0, 30); }

// state from a player: [mode, x, y, z, yaw, pitch, roll, speed, steer, flags]
function validState(d) {
  if (!Array.isArray(d) || d.length < 5 || d.length > 12) return null;
  for (let i = 0; i < d.length; i++) { const v = d[i]; if (typeof v !== 'number' || !isFinite(v)) return null; }
  if (Math.abs(d[1]) > 4000 || Math.abs(d[3]) > 4000 || d[2] < -200 || d[2] > 3000) return null;
  return d;
}

function handle(p, txt) {
  // simple flood guard
  const now = Date.now(); if (now - p.win > 1000) { p.win = now; p.n = 0; } if (++p.n > MSG_PER_SEC) return;
  let m; try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (!p.hello && m.t !== 'hello') return;
  switch (m.t) {
    case 'hello':
      if (m.v !== PROTOCOL) { p.c.send({ t: 'err', fatal: true, m: 'The game and the server are different versions. Refresh the page to update.' }); return p.c.kill(1000); }
      p.hello = true; p.name = cleanName(m.name, p.id); p.car = clean(m.car, 24) || 'stadium'; p.col = clean(m.col, 8); p.look = cleanLook(m.look);
      return p.c.send({ t: 'hi', id: p.id, name: p.name, v: PROTOCOL, online: players.size });
    case 'name': p.name = cleanName(m.name, p.id); if (p.room) toRoom(p.room, { t: 'pi', id: p.id, name: p.name, car: p.car, col: p.col, look: p.look || '' }); return;
    case 'list': return p.c.send({ t: 'rooms', rooms: publicRooms(), online: players.size });
    case 'create': return createRoom(p, m.priv, m.max);
    case 'quick': { const r = publicRooms()[0]; return r ? joinRoom(p, rooms.get(r.code)) : createRoom(p, false, ROOM_DEFAULT); }
    case 'join': { const code = clean(m.code, 8).toUpperCase(); const r = rooms.get(code); return r ? joinRoom(p, r) : p.c.send({ t: 'err', m: 'No room with the code ' + (code || '(blank)') + '. Check the code and try again.' }); }
    case 'leave': return leaveRoom(p);
    case 's': { if (!p.room) return; const d = validState(m.d); if (d) { p.state = d; p.moved = now; } return; }
    case 'info': if (!p.room) return; p.car = clean(m.car, 24) || p.car; p.col = clean(m.col, 8); if (m.look !== undefined) p.look = cleanLook(m.look); return toRoom(p.room, { t: 'pi', id: p.id, name: p.name, car: p.car, col: p.col, look: p.look || '' }, p);
    case 'chat': { if (!p.room || now - p.chatT < CHAT_GAP_MS) return; const t = cleanChat(m.m); if (!t) return; p.chatT = now; return toRoom(p.room, { t: 'chat', id: p.id, name: p.name, m: t }); }
    case 'time': if (p.room && p.room.host === p.id && typeof m.h === 'number' && isFinite(m.h)) { p.room.time = { h: m.h % 24, w: m.w | 0 }; toRoom(p.room, { t: 'time', h: p.room.time.h, w: p.room.time.w }, p); } return;
    case 'x': {
      // game events (shared ball, races, dogfights) passed to the others in the room; 'to' sends to one player
      if (!p.room || typeof m.k !== 'string' || !/^[a-zA-Z]{1,12}$/.test(m.k)) return;
      const out = JSON.stringify({ t: 'x', from: p.id, k: m.k, d: m.d === undefined ? null : m.d });
      if (m.to !== undefined) { const q = p.room.players.get(m.to | 0); if (q && q !== p) q.c.send(out); return; }
      for (const q of p.room.players.values()) if (q !== p) q.c.send(out);
      return;
    }
    case 'kick': {
      const r = p.room; if (!r || r.host !== p.id) return; const q = r.players.get(m.id | 0); if (!q || q === p) return;
      (r.banned = r.banned || new Set()).add(q.ip); q.c.send({ t: 'kicked', m: 'The host removed you from room ' + r.code + '.' }); leaveRoom(q, true);
      toRoom(r, { t: 'sys', m: q.name + ' was removed by the host.' }); return;
    }
  }
}

// ---------------------------------------------------------------- snapshots
setInterval(() => {
  tickNo++; const farTick = tickNo % FAR_EVERY === 0;
  for (const r of rooms.values()) {
    const list = [...r.players.values()].filter(q => q.state);
    if (!list.length) continue;
    for (const p of r.players.values()) {
      const me = p.state, out = [];
      for (const q of list) {
        if (q === p) continue;
        const near = !me || Math.hypot(q.state[1] - me[1], q.state[3] - me[3]) < NEAR;
        if (near || farTick) out.push([q.id, ...q.state]);
      }
      if (out.length) p.c.send({ t: 'snap', s: out });
    }
  }
}, TICK_MS);

// keep connections honest: ping every 15 s, drop anyone silent for 45 s
setInterval(() => { const now = Date.now(); for (const p of players) { if (now - p.c.last > 45000) p.c.kill(1001); else p.c.ping(); } }, 15000);

// ---------------------------------------------------------------- HTTP + upgrade
const started = Date.now();
function log(...a) { if (!process.env.QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); }
const server = http.createServer((req, res) => {
  const h = { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (req.url === '/health') { res.writeHead(200, h); return res.end('ok'); }
  if (req.url === '/status') { res.writeHead(200, Object.assign(h, { 'content-type': 'application/json' })); return res.end(JSON.stringify({ players: players.size, rooms: rooms.size, upMinutes: Math.round((Date.now() - started) / 60000) })); }
  res.writeHead(200, h); res.end('Burger Bandit Island multiplayer server is running. Players online: ' + players.size + ', rooms: ' + rooms.size + '\n');
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  if (players.size >= SERVER_CAP) { sock.end('HTTP/1.1 503 Server Full\r\n\r\n'); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  const p = { id: nextId++, name: '', car: 'stadium', col: '', room: null, state: null, hello: false, win: 0, n: 0, chatT: 0,
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() };
  p.c = new Conn(sock, t => handle(p, t), () => { players.delete(p); leaveRoom(p, true); log('disconnect', p.name || p.id, 'online', players.size); });
  players.add(p); log('connect', p.id, 'online', players.size);
});
server.listen(PORT, () => log('Burger Bandit Island server listening on port', PORT));
module.exports = { server };

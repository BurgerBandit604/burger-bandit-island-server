// Burger Bandit Championship Racing: online lobby and race relay.
// Shares the island server's HTTP port; the game connects to  wss://<server>/racing
// Rooms have a 4-letter code. The host picks the track, laps and conditions, everyone readies up,
// the host starts, and the server relays car positions about 15 times a second until everyone finishes.
'use strict';
const crypto = require('crypto');

const PROTOCOL = 1;
const CAP = +process.env.RACING_MAX_PLAYERS || 120;   // racing players on this server, all rooms together
const ROOM_MIN = 2, ROOM_MAX = 12, ROOM_DEFAULT = 8;
const TICK_MS = 66, MSG_PER_SEC = 40;
const TRACKS = 'ABCDEFGHIJ', CONDS = ['day', 'dusk', 'night', 'rain'], LAPS = [1, 2, 3, 5, 8, 10];
const CARS = ['cup', 'stock', 'f1', 'lm', 'baja', 'drift', 'strake', 'jacket', 'arrow', 'rod'];
const FINISH_GRACE_MS = 45000;                        // after the first finisher, others get this long
const COUNTDOWN_MS = 4500;

module.exports = function attach({ Conn, wsAccept, clean, cleanName, log }) {
  const rooms = new Map(), players = new Set();
  let nextId = 1;
  const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const newCode = () => { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CH[crypto.randomInt(CODE_CH.length)]; if (!rooms.has(c)) return c; } };
  const pub = p => ({ id: p.id, name: p.name, car: p.car, liv: p.liv, ready: p.ready });
  const roomMsg = (r, p) => ({ t: 'room', code: r.code, priv: r.priv, max: r.max, host: r.host, you: p.id, state: r.state, track: r.track, laps: r.laps, cond: r.cond, players: [...r.players.values()].map(pub) });
  const toRoom = (r, obj, except) => { const s = JSON.stringify(obj); for (const q of r.players.values()) if (q !== except) q.c.send(s); };
  const pickCar = c => CARS.includes(c) ? c : 'cup';

  function createRoom(p, m) {
    let max = Math.round(+m.max); if (!(max >= ROOM_MIN)) max = ROOM_DEFAULT; max = Math.min(ROOM_MAX, max);
    const r = { code: newCode(), priv: !!m.priv, max, host: p.id, players: new Map(), state: 'lobby', track: 'H', laps: 3, cond: 'day', race: null };
    rooms.set(r.code, r); joinRoom(p, r);
  }
  function joinRoom(p, r) {
    if (p.room) leaveRoom(p, true);
    if (r.players.size >= r.max) return p.c.send({ t: 'err', m: 'Room ' + r.code + ' is full.' });
    if (r.state !== 'lobby') return p.c.send({ t: 'err', m: 'Room ' + r.code + ' is racing right now. Try again when the race ends.' });
    p.ready = false; r.players.set(p.id, p); p.room = r; p.state = null;
    p.c.send(roomMsg(r, p)); toRoom(r, { t: 'pj', p: pub(p) }, p);
    log('racing join', r.code, p.name, r.players.size + '/' + r.max);
  }
  function leaveRoom(p, quiet) {
    const r = p.room; if (!r) return;
    r.players.delete(p.id); p.room = null; p.state = null;
    toRoom(r, { t: 'pl', id: p.id });
    if (!r.players.size) { rooms.delete(r.code); return; }
    if (r.host === p.id) { r.host = r.players.keys().next().value; toRoom(r, { t: 'host', id: r.host }); }
    if (r.race) { r.race.grid = r.race.grid.filter(id => id !== p.id); checkRaceOver(r); }
    if (!quiet) p.c.send({ t: 'left' });
  }
  const publicRooms = () => [...rooms.values()].filter(r => !r.priv && r.players.size < r.max)
    .map(r => ({ code: r.code, n: r.players.size, max: r.max, host: (r.players.get(r.host) || {}).name || '', track: r.track, state: r.state }))
    .sort((a, b) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1) || b.n - a.n).slice(0, 30);

  function startRace(r) {
    if (r.state !== 'lobby' || r.players.size < 1) return;
    const ids = [...r.players.keys()];
    for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }   // random grid
    r.state = 'race'; r.race = { grid: ids, fin: new Map(), firstFin: 0, started: Date.now() + COUNTDOWN_MS };
    for (const q of r.players.values()) { q.state = null; q.ready = false; }
    toRoom(r, { t: 'start', track: r.track, laps: r.laps, cond: r.cond, grid: ids, cars: [...r.players.values()].map(pub), countdown: COUNTDOWN_MS });
    log('racing start', r.code, r.track, r.laps + ' laps', ids.length + ' cars');
  }
  function checkRaceOver(r, force) {
    const R = r.race; if (!R) return;
    const allDone = R.grid.every(id => R.fin.has(id));
    if (!allDone && !force) return;
    const order = R.grid.map(id => ({ id, name: (r.players.get(id) || {}).name || '', time: R.fin.has(id) ? R.fin.get(id) : null }))
      .sort((a, b) => (a.time == null) - (b.time == null) || (a.time || 0) - (b.time || 0));
    toRoom(r, { t: 'results', order });
    r.state = 'lobby'; r.race = null;
    for (const q of r.players.values()) { q.state = null; q.ready = false; }
    for (const q of r.players.values()) q.c.send(roomMsg(r, q));
  }

  // state during a race: [dist, lateral, speed, latV, steer, flags, airY, spin]
  function validState(d) {
    if (!Array.isArray(d) || d.length < 5 || d.length > 10) return null;
    for (const v of d) if (typeof v !== 'number' || !isFinite(v) || Math.abs(v) > 1e6) return null;
    return d;
  }

  function handle(p, txt) {
    const now = Date.now(); if (now - p.win > 1000) { p.win = now; p.n = 0; } if (++p.n > MSG_PER_SEC) return;
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!p.hello && m.t !== 'hello') return;
    const r = p.room, host = r && r.host === p.id;
    switch (m.t) {
      case 'hello':
        if (m.v !== PROTOCOL) { p.c.send({ t: 'err', fatal: true, m: 'The game and the server are different versions. Refresh the page to update.' }); return p.c.kill(1000); }
        p.hello = true; p.name = cleanName(m.name, p.id); p.car = pickCar(m.car); p.liv = Math.max(0, Math.min(40, m.liv | 0));
        return p.c.send({ t: 'hi', id: p.id, name: p.name, v: PROTOCOL, online: players.size });
      case 'name': p.name = cleanName(m.name, p.id); if (r) toRoom(r, { t: 'pi', p: pub(p) }); return;
      case 'list': return p.c.send({ t: 'rooms', rooms: publicRooms(), online: players.size });
      case 'create': return createRoom(p, m);
      case 'quick': { const q = publicRooms().find(x => x.state === 'lobby'); return q ? joinRoom(p, rooms.get(q.code)) : createRoom(p, {}); }
      case 'join': { const code = clean(m.code, 8).toUpperCase(), q = rooms.get(code); return q ? joinRoom(p, q) : p.c.send({ t: 'err', m: 'No room with the code ' + (code || '(blank)') + '.' }); }
      case 'leave': return leaveRoom(p);
      case 'car': p.car = pickCar(m.car); p.liv = Math.max(0, Math.min(40, m.liv | 0)); if (r) toRoom(r, { t: 'pi', p: pub(p) }); return;
      case 'ready': if (!r || r.state !== 'lobby') return; p.ready = !!m.r; return toRoom(r, { t: 'pi', p: pub(p) });
      case 'set':
        if (!host || r.state !== 'lobby') return;
        if (typeof m.track === 'string' && m.track.length === 1 && TRACKS.includes(m.track)) r.track = m.track;
        if (LAPS.includes(m.laps)) r.laps = m.laps;
        if (CONDS.includes(m.cond)) r.cond = m.cond;
        if (m.priv !== undefined) r.priv = !!m.priv;
        return toRoom(r, { t: 'set', track: r.track, laps: r.laps, cond: r.cond, priv: r.priv });
      case 'start': if (host) startRace(r); return;
      case 's': { if (!r || r.state !== 'race') return; const d = validState(m.d); if (d) p.state = d; return; }
      case 'fin': {
        if (!r || !r.race || r.race.fin.has(p.id)) return;
        const t = +m.time; if (!(t > 5 && t < 7200)) return;
        r.race.fin.set(p.id, t); toRoom(r, { t: 'fin', id: p.id, time: t });
        if (!r.race.firstFin) { r.race.firstFin = now; const R = r.race; setTimeout(() => { if (r.race === R) checkRaceOver(r, true); }, FINISH_GRACE_MS); }
        return checkRaceOver(r);
      }
      case 'kick': {
        if (!host) return; const q = r.players.get(m.id | 0); if (!q || q === p) return;
        q.c.send({ t: 'kicked', m: 'The host removed you from room ' + r.code + '.' }); leaveRoom(q, true); return;
      }
    }
  }

  setInterval(() => {
    for (const r of rooms.values()) {
      if (r.state !== 'race') continue;
      const list = [...r.players.values()].filter(q => q.state);
      if (!list.length) continue;
      const now = Date.now();
      for (const p of r.players.values()) {
        const out = []; for (const q of list) if (q !== p) out.push([q.id, ...q.state]);
        if (out.length) p.c.send({ t: 'snap', at: now, s: out });
      }
    }
  }, TICK_MS);
  setInterval(() => { const now = Date.now(); for (const p of players) { if (now - p.c.last > 45000) p.c.kill(1001); else p.c.ping(); } }, 15000);

  return {
    upgrade(req, sock) {
      const key = req.headers['sec-websocket-key'];
      if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      if (players.size >= CAP) { sock.end('HTTP/1.1 503 Server Full\r\n\r\n'); return; }
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
      const p = { id: nextId++, name: '', car: 'cup', liv: 0, ready: false, room: null, state: null, hello: false, win: 0, n: 0 };
      p.c = new Conn(sock, t => handle(p, t), () => { players.delete(p); leaveRoom(p, true); });
      players.add(p);
    },
    status: () => ({ players: players.size, rooms: rooms.size, racing: [...rooms.values()].filter(r => r.state === 'race').length })
  };
};

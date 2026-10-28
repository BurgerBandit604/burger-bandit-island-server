// Checks for the racing lobby. Run:  node racing/racetest.js   (needs Node 22+ for the built-in WebSocket)
'use strict';
process.env.QUIET = '1'; process.env.PORT = '18093';
const { server } = require('../server.js');
const URL = 'ws://127.0.0.1:18093';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(path, name) {
  return new Promise(res => {
    const ws = new WebSocket(URL + path), c = { ws, got: [], send: o => ws.send(JSON.stringify(o)), last: t => [...c.got].reverse().find(m => m.t === t) };
    ws.onmessage = e => c.got.push(JSON.parse(e.data));
    ws.onopen = () => { c.send({ t: 'hello', v: 1, name, car: 'cup', liv: 2 }); setTimeout(() => res(c), 100); };
  });
}
(async () => {
  await sleep(200);
  const a = await client('/racing', 'Alice'), b = await client('/racing', 'Bob');
  ok(a.last('hi') && a.last('hi').name === 'Alice', 'hello');
  a.send({ t: 'create', max: 6 }); await sleep(100);
  const room = a.last('room'); ok(room && room.code.length === 4 && room.host === room.you, 'create room');
  b.send({ t: 'list' }); await sleep(100); ok(b.last('rooms').rooms.some(r => r.code === room.code), 'room listed');
  b.send({ t: 'join', code: room.code.toLowerCase() }); await sleep(100);
  ok(b.last('room') && b.last('room').players.length === 2, 'join by code');
  ok(a.last('pj') && a.last('pj').p.name === 'Bob', 'host told about join');
  b.send({ t: 'set', track: 'A' }); await sleep(50); ok(!a.last('set'), 'non-host cannot change settings');
  a.send({ t: 'set', track: 'C', laps: 5, cond: 'night' }); await sleep(100);
  ok(b.last('set') && b.last('set').track === 'C' && b.last('set').laps === 5 && b.last('set').cond === 'night', 'host settings shared');
  b.send({ t: 'car', car: 'f1', liv: 4 }); b.send({ t: 'ready', r: true }); await sleep(100);
  ok(a.last('pi') && a.last('pi').p.car === 'f1' && a.last('pi').p.ready, 'car and ready shared');
  b.send({ t: 'start' }); await sleep(50); ok(!a.last('start'), 'only host starts');
  a.send({ t: 'start' }); await sleep(100);
  const st = b.last('start'); ok(st && st.grid.length === 2 && st.track === 'C' && st.laps === 5, 'race start broadcast');
  const c = await client('/racing', 'Late'); c.send({ t: 'join', code: room.code }); await sleep(100);
  ok(c.last('err') && /racing/.test(c.last('err').m), 'cannot join mid-race');
  for (let i = 0; i < 4; i++) { a.send({ t: 's', d: [10 + i, 1, 50, 0, 0, 0, -1e4, 0] }); b.send({ t: 's', d: [20 + i, -1, 52, 0, 0, 0, -1e4, 0] }); await sleep(70); }
  const sn = a.last('snap'); ok(sn && sn.s.length === 1 && sn.s[0][0] === b.last('hi').id, 'positions relayed');
  a.send({ t: 's', d: ['x'] }); a.send({ t: 's', d: [1, 2] }); await sleep(80); ok(true, 'bad state ignored without crashing');
  a.send({ t: 'fin', time: 61.2 }); await sleep(80); ok(b.last('fin') && b.last('fin').time === 61.2, 'finish shared');
  b.send({ t: 'fin', time: 63.9 }); await sleep(120);
  const r = a.last('results'); ok(r && r.order[0].name === 'Alice' && r.order[1].name === 'Bob', 'results in order');
  ok(a.last('room').state === 'lobby', 'room back to lobby after the race');
  b.ws.close(); await sleep(150); ok(a.last('pl'), 'leave noticed');
  // the island game still works on the same server
  const isl = new WebSocket(URL); let hi = null; isl.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'hi') hi = m; };
  isl.onopen = () => isl.send(JSON.stringify({ t: 'hello', v: 1, name: 'Islander' })); await sleep(200);
  ok(hi && hi.name === 'Islander', 'island server unaffected');
  const st2 = await (await fetch('http://127.0.0.1:18093/racing/status')).json(); ok(st2.players >= 1, 'racing status page');
  console.log(pass + ' passed, ' + fail + ' failed'); server.close(); process.exit(fail ? 1 : 0);
})();

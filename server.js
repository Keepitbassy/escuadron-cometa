// Escuadrón Cometa — servidor multijugador (sin dependencias, solo Node.js)
// Uso:  node server.js        (puerto 8080; otro: PORT=3000 node server.js)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = Number(process.env.PORT) || 8080;
const MAX = 8, ROUND_SECS = 180, WIN_KILLS = 15, PAUSE_SECS = 8, MAP_COUNT = 4;
// Mapas: 0 Mar helado, 1 Ruinas orbitales, 2 Cinturón de asteroides, 3 Nebulosa carmesí.
// Por defecto: 2. Con ROTAR_MAPAS=1 cambia en cada ronda.
const ROTATE = !!process.env.ROTAR_MAPAS;
let mapIdx = ROTATE ? 0 : 2, played = false;
// Modo: MODO=equipos para 4 vs 4 (Azul contra Rojo); por defecto todos contra todos.
const MODE = /^equip|^team/i.test(process.env.MODO || '') ? 'teams' : 'ffa';
const TEAM_WIN = 25;
const PAD_RESPAWN = 25000, ROCK_RESPAWN = 45000;
let padsOff = {}, rocksOff = {}; // índice -> momento en que reaparece

// ---------- HTTP: sirve el juego ----------
const page = () => fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('<!--NET-->', '<script>window.NET=1</script>');
const srv = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page());
  } else if (url === '/salud') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  } else { res.writeHead(404); res.end('No encontrado'); }
});

// ---------- WebSocket mínimo (RFC 6455) ----------
srv.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), id: -1, name: '', k: 0, d: 0, send: o => frame(sock, JSON.stringify(o)) };
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  sock.on('close', () => leave(c));
  sock.on('error', () => sock.destroy());
});
function frame(sock, str, op = 1) {
  if (sock.destroyed) return;
  const p = Buffer.from(str); let h;
  if (p.length < 126) h = Buffer.from([0x80 | op, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  sock.write(Buffer.concat([h, p]));
}
function parse(c) {
  while (c.buf.length >= 2) {
    const op = c.buf[0] & 15, masked = c.buf[1] & 128; let len = c.buf[1] & 127, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 1e6) { c.sock.destroy(); return; }
    const mk = masked ? 4 : 0;
    if (c.buf.length < off + mk + len) return;
    let p = Buffer.from(c.buf.subarray(off + mk, off + mk + len));
    if (masked) { const m = c.buf.subarray(off, off + 4); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
    c.buf = c.buf.subarray(off + mk + len);
    if (op === 8) { c.sock.end(); return; }
    if (op === 9) { frame(c.sock, p.toString(), 10); continue; }
    if (op === 1) { let m; try { m = JSON.parse(p.toString()); } catch (e) { continue; } onMsg(c, m); }
  }
}

// ---------- Lógica de la sala ----------
// Cada lugar es un humano (con socket) o un bot. Los bots los simula el navegador del
// "anfitrión" (el humano conectado con el número más bajo) y el servidor los reparte.
const slots = new Array(MAX).fill(null);
let round = { state: 'wait', time: ROUND_SECS };
let host = null;
const FILL = MODE === 'teams' ? MAX : Math.min(MAX, Math.max(0, Number(process.env.RELLENO ?? 4)));
const BOT_NAMES = ['Vega', 'Orión', 'Kira', 'Nova', 'Rix', 'Lumen', 'Sable', 'Atlas'];
const all = () => slots.filter(Boolean);
const humans = () => all().filter(c => !c.bot);
const plist = () => all().map(c => ({ id: c.id, name: c.name, k: c.k, d: c.d, team: c.team, bot: !!c.bot }));
const teamKills = t => all().reduce((a, c) => a + (c.team === t ? c.k : 0), 0);
const teamSize = t => all().filter(c => c.team === t).length;
function bcast(o, except) { const s = JSON.stringify(o); for (const c of humans()) if (c !== except) frame(c.sock, s); }
function removeSlot(c) { slots[c.id] = null; bcast({ t: 'left', id: c.id }); }

function fillBots() {
  if (!humans().length) { for (const b of all()) if (b.bot) slots[b.id] = null; return; }
  while (all().length > FILL) {                       // sobran bots: quitar del equipo más grande
    const bots = all().filter(c => c.bot); if (!bots.length) break;
    let b = bots[bots.length - 1];
    if (MODE === 'teams') { const big = teamSize(0) >= teamSize(1) ? 0 : 1; b = bots.filter(x => x.team === big).pop() || b; }
    removeSlot(b);
  }
  while (all().length < FILL) {                       // faltan: agregar al equipo más chico
    const id = slots.indexOf(null); if (id < 0) break;
    const used = new Set(all().map(c => c.name));
    const name = (BOT_NAMES.find(n => !used.has(n + ' (bot)')) || 'Bot ' + id) + ' (bot)';
    slots[id] = { id, name, k: 0, d: 0, bot: true, team: MODE === 'teams' ? (teamSize(0) <= teamSize(1) ? 0 : 1) : id };
  }
}
function updateHost() {
  const h = humans().sort((a, b) => a.id - b.id)[0] || null;
  if (h && h !== host) log('Anfitrión de bots: ' + h.name);
  host = h;
  if (host) host.send({ t: 'host', bots: all().filter(c => c.bot).map(c => c.id) });
}
function rosterChanged() { fillBots(); updateHost(); bcast({ t: 'players', list: plist() }); checkRound(); }

function onMsg(c, m) {
  if (m.t === 'join') {
    if (c.id >= 0) return;
    let team = 0;
    if (MODE === 'teams') { const h0 = humans().filter(p => p.team === 0).length, h1 = humans().filter(p => p.team === 1).length; team = h0 <= h1 ? 0 : 1; }
    let id = slots.indexOf(null);
    if (id < 0) {                                     // lleno: un humano reemplaza a un bot
      const bots = all().filter(p => p.bot);
      const b = bots.filter(p => MODE !== 'teams' || p.team === team).pop() || bots.pop();
      if (!b) { c.send({ t: 'full' }); c.sock.end(); return; }
      removeSlot(b); id = b.id; if (MODE === 'teams') team = b.team;
    }
    c.id = id; c.team = MODE === 'teams' ? team : id; c.k = 0; c.d = 0;
    c.name = String(m.name || 'Piloto').replace(/[<>&"']/g, '').slice(0, 12) || 'Piloto';
    slots[id] = c;
    c.send({ t: 'welcome', id, mode: MODE, team: c.team, round: { ...round, map: mapIdx }, padsOff: Object.keys(padsOff).map(Number), rocksOff: Object.keys(rocksOff).map(Number) });
    bcast({ t: 'joined', id, name: c.name }, c);
    log(`${c.name} entró (${humans().length} humanos, ${all().length}/${MAX} pilotos)`);
    rosterChanged();
    return;
  }
  if (c.id < 0) return;
  // El anfitrión habla en nombre de sus bots con "bid".
  let actor = c;
  if (m.bid != null) { const b = slots[m.bid | 0]; if (c !== host || !b || !b.bot) return; actor = b; }
  if (m.t === 'st' || m.t === 'fire' || m.t === 'mis' || m.t === 'mine' || m.t === 'minex' || m.t === 'mark') { delete m.bid; m.id = actor.id; bcast(m, c); }
  else if (m.t === 'pick') {
    const i = m.i | 0; if (i < 0 || i > 15 || padsOff[i]) return;   // el primero que llega se lo queda
    padsOff[i] = Date.now() + PAD_RESPAWN; bcast({ t: 'pick', i, id: actor.id });
  }
  else if (m.t === 'rockx') {
    const i = m.i | 0; if (i < 0 || i > 300 || rocksOff[i]) return;
    rocksOff[i] = Date.now() + ROCK_RESPAWN; bcast({ t: 'rockx', i }, c);
  }
  else if (m.t === 'dead') {
    actor.d++;
    const by = slots[m.by];
    const valid = by && by !== actor && (MODE !== 'teams' || by.team !== actor.team);
    if (valid && round.state === 'play') by.k++;
    bcast({ t: 'kill', v: actor.id, by: valid ? by.id : -1 });
    bcast({ t: 'players', list: plist() });
    if (valid && round.state === 'play' && (MODE === 'teams' ? teamKills(by.team) >= TEAM_WIN : by.k >= WIN_KILLS)) endRound();
  }
}
function leave(c) {
  if (c.id < 0 || slots[c.id] !== c) return;
  removeSlot(c);
  log(`${c.name} salió (${humans().length} humanos)`);
  rosterChanged();
}
function checkRound() {
  const n = all().length, h = humans().length;
  if (round.state === 'wait' && h >= 1 && n >= 2) startRound();
  else if (round.state !== 'wait' && (h < 1 || n < 2)) { round = { state: 'wait', time: ROUND_SECS }; bcast({ t: 'round', map: mapIdx, ...round }); }
}
function startRound() {
  if (played && ROTATE) mapIdx = (mapIdx + 1) % MAP_COUNT;
  played = true;
  padsOff = {}; rocksOff = {};
  for (const c of all()) { c.k = 0; c.d = 0; }
  round = { state: 'play', time: ROUND_SECS };
  bcast({ t: 'round', map: mapIdx, ...round, fresh: true });
  bcast({ t: 'players', list: plist() });
  log('Nueva ronda en el mapa ' + mapIdx);
}
function endRound() {
  const results = plist().sort((a, b) => b.k - a.k || a.d - b.d);
  round = { state: 'over', time: PAUSE_SECS };
  bcast({ t: 'round', map: mapIdx, ...round, results });
  log('Ronda terminada: gana ' + (results[0] ? results[0].name : '-'));
}
setInterval(() => {
  const now = Date.now();
  for (const i in padsOff) if (padsOff[i] <= now) { delete padsOff[i]; bcast({ t: 'pad', i: +i }); }
  for (const i in rocksOff) if (rocksOff[i] <= now) { delete rocksOff[i]; bcast({ t: 'rockon', i: +i }); }
  if (round.state === 'wait') return;
  round.time--;
  if (round.state === 'play' && round.time <= 0) endRound();
  else if (round.state === 'over' && round.time <= 0) { if (humans().length >= 1 && all().length >= 2) startRound(); else { round = { state: 'wait', time: ROUND_SECS }; bcast({ t: 'round', map: mapIdx, ...round }); } }
  else bcast({ t: 'round', map: mapIdx, state: round.state, time: round.time });
}, 1000);

function log(s) { console.log(new Date().toLocaleTimeString() + '  ' + s); }
srv.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Escuadrón Cometa — servidor listo (' + (MODE === 'teams' ? 'equipos 4 vs 4' : 'todos contra todos') + ', hasta ' + MAX + ' pilotos)\n');
  console.log('  En esta Mac:        http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log('  En tu red (Wi-Fi):  http://' + a.address + ':' + PORT);
  console.log('\n  Ctrl+C para apagarlo.\n');
});

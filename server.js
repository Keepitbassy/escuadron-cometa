// Escuadrón Cometa — servidor multijugador (sin dependencias, solo Node.js)
// Uso:  node server.js        (puerto 8080; otro: PORT=3000 node server.js)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = Number(process.env.PORT) || 8080;
const MAX = 4, ROUND_SECS = 180, WIN_KILLS = 10, PAUSE_SECS = 8;

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
const slots = [null, null, null, null];
let round = { state: 'wait', time: ROUND_SECS };
const players = () => slots.filter(Boolean);
const plist = () => players().map(c => ({ id: c.id, name: c.name, k: c.k, d: c.d }));
function bcast(o, except) { const s = JSON.stringify(o); for (const c of players()) if (c !== except) frame(c.sock, s); }

function onMsg(c, m) {
  if (m.t === 'join') {
    if (c.id >= 0) return;
    const id = slots.indexOf(null);
    if (id < 0) { c.send({ t: 'full' }); c.sock.end(); return; }
    c.id = id; c.name = String(m.name || 'Piloto').replace(/[<>&"']/g, '').slice(0, 12) || 'Piloto';
    slots[id] = c;
    c.send({ t: 'welcome', id, round });
    bcast({ t: 'joined', id, name: c.name }, c);
    bcast({ t: 'players', list: plist() });
    log(`${c.name} entró (${players().length}/${MAX})`);
    checkRound();
    return;
  }
  if (c.id < 0) return;
  if (m.t === 'st' || m.t === 'fire') { m.id = c.id; bcast(m, c); }
  else if (m.t === 'dead') {
    c.d++;
    const by = slots[m.by];
    const valid = by && by !== c;
    if (valid && round.state === 'play') by.k++;
    bcast({ t: 'kill', v: c.id, by: valid ? by.id : -1 });
    bcast({ t: 'players', list: plist() });
    if (valid && by.k >= WIN_KILLS && round.state === 'play') endRound();
  }
}
function leave(c) {
  if (c.id < 0 || slots[c.id] !== c) return;
  slots[c.id] = null;
  bcast({ t: 'left', id: c.id });
  bcast({ t: 'players', list: plist() });
  log(`${c.name} salió (${players().length}/${MAX})`);
  checkRound();
}
function checkRound() {
  const n = players().length;
  if (round.state === 'wait' && n >= 2) startRound();
  else if (round.state !== 'wait' && n < 2) { round = { state: 'wait', time: ROUND_SECS }; bcast({ t: 'round', ...round }); }
}
function startRound() {
  for (const c of players()) { c.k = 0; c.d = 0; }
  round = { state: 'play', time: ROUND_SECS };
  bcast({ t: 'round', ...round, fresh: true });
  bcast({ t: 'players', list: plist() });
  log('Nueva ronda');
}
function endRound() {
  const results = plist().sort((a, b) => b.k - a.k || a.d - b.d);
  round = { state: 'over', time: PAUSE_SECS };
  bcast({ t: 'round', ...round, results });
  log('Ronda terminada: gana ' + (results[0] ? results[0].name : '-'));
}
setInterval(() => {
  if (round.state === 'wait') return;
  round.time--;
  if (round.state === 'play' && round.time <= 0) endRound();
  else if (round.state === 'over' && round.time <= 0) { if (players().length >= 2) startRound(); else { round = { state: 'wait', time: ROUND_SECS }; bcast({ t: 'round', ...round }); } }
  else bcast({ t: 'round', state: round.state, time: round.time });
}, 1000);

function log(s) { console.log(new Date().toLocaleTimeString() + '  ' + s); }
srv.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Escuadrón Cometa — servidor listo\n');
  console.log('  En esta Mac:        http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log('  En tu red (Wi-Fi):  http://' + a.address + ':' + PORT);
  console.log('\n  Ctrl+C para apagarlo.\n');
});

/* © 2026 Habibur Rahaman Tanim. All rights reserved. */
/* CALL MASTER — authoritative multiplayer server.
   The server deals, validates every action, scores, and sends each player ONLY their own hand. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const CM = require('./engine.js');

const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ROOT = __dirname;
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/engine.js': 'engine.js', '/config.js': 'config.js', '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg',
  '/favicon.ico': 'favicon.ico', '/favicon-16.png': 'favicon-16.png', '/favicon-32.png': 'favicon-32.png',
  '/apple-touch-icon.png': 'apple-touch-icon.png', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png' };
const MIME = { html: 'text/html', js: 'text/javascript', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' };
const TIMING = { bidDone: 1500, autoAct: 12000, roundAuto: 25000, callMs: 40000, ...(global.__CM_TIMING || {}) };   // 40 s to call, then auto-call 15
const MAX_ROUNDS = 20;
/* Empty seats are filled with expert AI players when the host starts a match with 2 or 3 humans. They act after a human-like pause. */
const BOT = { bid: [1200, 2200], play: [900, 1700], shuffle: 1300, trickGap: 1500, ...(global.__CM_BOT || {}) };
const BOT_PERS = ['aggressive', 'defensive', 'balanced'];
const pause = ([a, b]) => a + Math.random() * (b - a);
/* Accounts live in Supabase. The browser sends its login token; the server asks Supabase who it belongs to
   and uses the NAME and PHOTO from that player's profile — a client can never claim someone else's name. */
const SB_URL = (process.env.SUPABASE_URL || 'https://elxgisccmwxiyrhkqfwe.supabase.co').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_mhW3GutHNcst5lbp8eCv_g_CxKpsSBD';
const idCache = new Map();

const rooms = new Map();
const crng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;      // secure shuffling

/* ---------- helpers ---------- */
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const err = (ws, msg) => send(ws, { t: 'error', msg });
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) { let c = ''; for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c; }
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
function checkPw(r, pw) { return crypto.timingSafeEqual(hashPw(pw, r.salt), r.hash); }
const cleanAv = a => (typeof a === 'string' && a.length <= 14000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(a)) ? a : '';
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

/* returns {uid,name,av} | null (bad token) | undefined (Supabase unreachable) */
async function identify(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
  const hit = idCache.get(token); if (hit && Date.now() - hit.t < 60000) return hit.id;
  try {
    const H = { apikey: SB_KEY, Authorization: 'Bearer ' + token }, sig = () => AbortSignal.timeout(8000);
    const ur = await fetch(SB_URL + '/auth/v1/user', { headers: H, signal: sig() });
    if (ur.status === 401 || ur.status === 403) return null; if (!ur.ok) return undefined;
    const u = await ur.json(); if (!u || !u.id) return null;
    const pr = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=username,avatar`, { headers: H, signal: sig() });
    if (!pr.ok) return undefined;
    const rows = await pr.json(); if (!Array.isArray(rows) || !rows[0]) return null;
    const id = { uid: String(u.id), name: clean(rows[0].username, 20), av: cleanAv(rows[0].avatar || '') };
    if (!id.name) return null;
    if (idCache.size > 500) idCache.clear(); idCache.set(token, { id, t: Date.now() }); return id;
  } catch { return undefined; }
}

/* rate limiting: attempts per IP */
const attempts = new Map();
function limited(ip, max = 12, windowMs = 60000) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < windowMs);
  a.push(now); attempts.set(ip, a); return a.length > max;
}

/* ---------- room state views ---------- */
function stateFor(r, s) {
  const st = r.st, b = r.b;
  return {
    code: r.code, name: r.name, matchName: r.matchName, phase: r.phase, rounds: r.rounds, round: r.round, dealer: r.dealer,
    scores: r.scores, me: s, hostSeat: r.hostSeat,
    seats: r.seats.map((x, i) => x ? { name: x.name, av: x.av, ready: x.ready, connected: x.connected, bot: !!x.bot,
      handSize: r.hands ? r.hands[i].length : 0, cap: st ? st.cap[i] : 0, tricks: st ? st.tricks[i] : 0 } : null),
    hand: r.hands ? r.hands[s] : [],                                  // ONLY the receiver's own cards
    bidding: b ? { turn: b.turn, calls: b.calls, history: b.history, done: b.done, legal: b.done ? [] : CM.legalBids() } : null,
    turn: r.phase === 'playing' ? st.turn : null,
    trick: st ? st.trick : [], calls: st ? st.calls : (b ? b.calls : null),
    last: r.last, rows: r.rows, final: !!r.final, history: r.hist,
    callMs: r.phase === 'bidding' ? Math.max(0, TIMING.callMs - (Date.now() - r.callStart)) : null
  };
}
function broadcast(r) {
  r.touched = Date.now();
  if (r.phase === 'bidding' && (r.callFor !== r.b.turn || r.callRound !== r.round)) { r.callFor = r.b.turn; r.callRound = r.round; r.callStart = Date.now(); }
  r.seats.forEach((x, i) => x && x.ws && send(x.ws, { t: 'state', state: stateFor(r, i) }));
}

/* ---------- AI helpers ---------- */
const humanSeats = r => r.seats.map((x, i) => x && !x.bot ? i : -1).filter(i => i >= 0);
const botCtx = r => ({ totals: r.scores.slice(), humans: humanSeats(r), pers: r.seats.map(x => (x && x.pers) || ''), round: r.round, rounds: r.rounds });
/* one place that plays a card, so a finished trick is always recorded for the clients (human, bot or auto-play) */
function doPlay(r, s, cardId) {
  const res = CM.playCard(r.st, s, String(cardId));
  if (res.completed) r.last = { n: ++r.trickN, cards: res.completed.map(t => ({ p: t.p, card: t.card })), winner: res.winner, points: res.points };
  return res;
}
function fillBots(r) {
  const taken = new Set(r.seats.filter(Boolean).map(x => x.name.toLowerCase()));
  const first = r.seats.find(x => x && !x.bot);
  const pool = CM.aiNames(first ? first.name : '').filter(n => !taken.has(n.toLowerCase()));
  let k = 0;
  for (let i = 0; i < 4; i++) if (!r.seats[i]) {
    let name = pool[k] || ('AI ' + (k + 1)); k++;
    while (taken.has(name.toLowerCase())) name += '2';
    taken.add(name.toLowerCase());
    r.seats[i] = { name, uid: null, av: '', token: crypto.randomBytes(16).toString('hex'), ready: true, ws: null, connected: true, bot: true, pers: BOT_PERS[(k - 1) % 3] };
  }
}
function dropBots(r) { r.seats = r.seats.map(x => x && x.bot ? null : x); }
function botAct(r, s) {
  const seat = r.seats[s]; if (!seat || !seat.bot) return;
  try {
    if (r.phase === 'shuffle' && r.dealer === s) return dealNow(r);
    if (r.phase === 'bidding' && r.b.turn === s) { CM.placeBid(r.b, s, CM.aiBid(r.hands[s], r.b, 'expert', seat.pers, crng, botCtx(r)).value); return afterAction(r); }
    if (r.phase === 'playing' && r.st.turn === s) { doPlay(r, s, CM.aiPlay(CM.view(r.st, s), 'expert', seat.pers, crng, botCtx(r)).id); return afterAction(r); }
  } catch (e) { if (process.env.CM_DEBUG) console.error('bot error', e.message); }
}

/* ---------- game flow ---------- */
/* Each round a different player is the dealer (seat 0, 1, 2, 3, 0 …). The dealer taps "Shuffle";
   only then does the server shuffle and deal. The player after the dealer calls first and leads first. */
function startRound(r) {
  clearTimeout(r.timer);
  r.round++; r.dealer = (r.round - 1) % 4; r.hands = null; r.b = null;
  r.st = null; r.last = null; r.rows = null; r.final = false; r.acks = new Set(); r.trickN = 0; r.phase = 'shuffle';
  broadcast(r); schedule(r);
}
function dealNow(r) {
  r.hands = CM.deal(crng); r.b = CM.newBidding((r.dealer + 1) % 4); r.phase = 'bidding'; broadcast(r); schedule(r);
}
function startPlay(r) {
  r.st = CM.newPlayState(r.hands, r.b.calls, (r.dealer + 1) % 4);     // the player after the dealer leads
  r.phase = 'playing'; broadcast(r); schedule(r);
}
function afterAction(r) {
  if (r.phase === 'bidding' && r.b.done) {
    r.phase = 'bidDone'; broadcast(r); clearTimeout(r.timer); r.timer = setTimeout(() => startPlay(r), TIMING.bidDone); return;
  }
  if (r.phase === 'playing' && CM.isOver(r.st)) {
    r.rows = CM.scoreRound(r.st);
    r.rows.forEach(x => r.scores[x.p] += x.delta);                    // server-side scoring only
    r.hist.push(r.rows.map(x => x.delta));
    r.final = r.round >= r.rounds; r.phase = 'roundEnd'; r.acks = new Set();
    broadcast(r); clearTimeout(r.timer); r.timer = setTimeout(() => advance(r), TIMING.roundAuto); return;
  }
  broadcast(r); schedule(r);
}
function advance(r) {
  if (r.phase !== 'roundEnd') return;
  clearTimeout(r.timer);
  if (r.final) { r.phase = 'matchEnd'; broadcast(r); } else startRound(r);
}
/* Timers: a connected player has 40 s to call, then the server calls 15 for them.
   A disconnected player's turn is played for them after a short delay so the table never stalls. */
function schedule(r) {
  clearTimeout(r.auto);
  let s = null;
  if (r.phase === 'shuffle') s = r.dealer; else if (r.phase === 'bidding') s = r.b.turn; else if (r.phase === 'playing') s = r.st.turn;
  if (s === null || !r.seats[s]) return;
  const seat = r.seats[s]; let wait;
  if (seat.bot) {                                                    // computer player: think for a moment, then act
    wait = r.phase === 'bidding' ? pause(BOT.bid) : r.phase === 'shuffle' ? BOT.shuffle
         : pause(BOT.play) + (r.st && r.st.trick.length === 0 && r.trickN > 0 ? BOT.trickGap : 0);
    r.auto = setTimeout(() => botAct(r, s), wait); return;
  }
  if (r.phase === 'bidding') {
    const left = Math.max(0, TIMING.callMs - (Date.now() - r.callStart));
    wait = seat.connected ? left : Math.min(left, TIMING.autoAct);
  } else if (seat.connected) return; else wait = TIMING.autoAct;
  r.auto = setTimeout(() => {
    const seat = r.seats[s]; if (!seat) return;
    try {
      if (r.phase === 'bidding' && r.b.turn === s) CM.placeBid(r.b, s, CM.RULES.minCall);
      else if (seat.connected) return;
      else if (r.phase === 'shuffle' && r.dealer === s) return dealNow(r);
      else if (r.phase === 'playing' && r.st.turn === s) doPlay(r, s, CM.aiPlay(CM.view(r.st, s), 'hard', 'balanced', crng, botCtx(r)).id);
      else return;
      afterAction(r);
    } catch (e) { /* ignore */ }
  }, wait);
}
function maybeAdvanceAcks(r) {
  const need = r.seats.map((x, i) => x && x.connected && !x.bot ? i : -1).filter(i => i >= 0);
  if (need.every(i => r.acks.has(i))) advance(r);
}

/* ---------- connection handling ---------- */
function seatOf(r, ws) { return r.seats.findIndex(x => x && x.ws === ws); }
function removeSeat(r, i) {
  r.seats[i] = null;
  if (r.seats.every(x => !x || x.bot)) { clearTimeout(r.timer); clearTimeout(r.auto); rooms.delete(r.code); return; }
  if (r.hostSeat === i) r.hostSeat = r.seats.findIndex(x => x && !x.bot);
  broadcast(r);
}
function attach(r, i, ws) {
  const seat = r.seats[i];
  if (seat.ws && seat.ws !== ws) { seat.ws.ctx = null; send(seat.ws, { t: 'error', msg: 'Signed in from another device.' }); try { seat.ws.close(); } catch {} }
  seat.ws = ws; seat.connected = true; ws.ctx = { room: r, ip: ws.ip };
  send(ws, { t: 'joined', code: r.code, token: seat.token, seat: i });
}

async function onMessage(ws, raw) {
  let m; try { m = JSON.parse(raw); } catch { return err(ws, 'Bad message'); }
  if (!m || typeof m.t !== 'string') return err(ws, 'Bad message');

  if (m.t === 'create') {
    if (limited(ws.ip, 6)) return err(ws, 'Too many attempts. Wait a minute.');
    const roomName = clean(m.roomName, 30), pw = String(m.password || '');
    const rounds = Math.min(MAX_ROUNDS, Math.max(1, parseInt(m.rounds, 10) || 3));
    const who = await identify(m.token);
    if (who === undefined) return err(ws, 'Account service is not reachable. Try again in a moment.');
    if (!who) return err(ws, 'Please log in again.');
    const name = who.name;
    if (!roomName) return err(ws, 'Enter a room name.');
    if (pw.length < 4 || pw.length > 40) return err(ws, 'Password must be 4–40 characters.');
    const salt = crypto.randomBytes(16);
    const r = { code: newCode(), name: roomName, matchName: clean(m.matchName, 30), salt, hash: hashPw(pw, salt), rounds,
      seats: [null, null, null, null], hostSeat: 0, phase: 'lobby', round: 0, scores: [0, 0, 0, 0], hist: [], hands: null, b: null, st: null,
      last: null, rows: null, final: false, acks: new Set(), touched: Date.now(), failed: 0 };
    r.seats[0] = { name, uid: who.uid, av: who.av, token: crypto.randomBytes(16).toString('hex'), ready: false, ws: null, connected: false };
    rooms.set(r.code, r); attach(r, 0, ws); return broadcast(r);
  }

  if (m.t === 'join') {
    if (limited(ws.ip)) return err(ws, 'Too many attempts. Wait a minute.');
    const pwIn = String(m.password || '');
    let r = null;
    if (m.code) {
      r = rooms.get(clean(m.code, 8).toUpperCase());
      if (!r) return err(ws, 'Invalid room link, or the room has expired.');
      if (r.failed >= 30) return err(ws, 'Room is temporarily locked after too many wrong passwords.');
      if (!checkPw(r, pwIn)) { r.failed++; return err(ws, 'Incorrect password.'); }
    } else {
      const nm = clean(m.roomName, 30).toLowerCase();
      if (!nm) return err(ws, 'Enter the room name.');
      const same = [...rooms.values()].filter(x => x.name.toLowerCase() === nm);
      if (!same.length) return err(ws, 'No room found with that name.');
      const open = same.filter(x => x.failed < 30);
      if (!open.length) return err(ws, 'Room is temporarily locked after too many wrong passwords.');
      r = open.find(x => checkPw(x, pwIn));
      if (!r) { open.forEach(x => x.failed++); return err(ws, 'Incorrect password.'); }
    }
    const who = await identify(m.token);
    if (who === undefined) return err(ws, 'Account service is not reachable. Try again in a moment.');
    if (!who) return err(ws, 'Please log in again.');
    const name = who.name;
    const again = r.seats.findIndex(x => x && x.uid === who.uid);          // same account: take over its own seat
    if (again >= 0) { attach(r, again, ws); return broadcast(r); }
    if (r.phase !== 'lobby') return err(ws, 'Match already started.');
    if (r.seats.some(x => x && x.name.toLowerCase() === name.toLowerCase())) return err(ws, 'That name is taken in this room.');
    const i = r.seats.findIndex(x => !x); if (i < 0) return err(ws, 'Room is full.');
    r.seats[i] = { name, uid: who.uid, av: who.av, token: crypto.randomBytes(16).toString('hex'), ready: false, ws: null, connected: false };
    attach(r, i, ws); return broadcast(r);
  }

  if (m.t === 'resume') {
    if (limited(ws.ip, 30)) return err(ws, 'Too many attempts. Wait a minute.');
    const r = rooms.get(clean(m.code, 8).toUpperCase()); const tok = String(m.token || '');
    const i = r ? r.seats.findIndex(x => x && x.token.length === tok.length && crypto.timingSafeEqual(Buffer.from(x.token), Buffer.from(tok))) : -1;
    if (!r || i < 0) return send(ws, { t: 'resumeFailed' });
    attach(r, i, ws); broadcast(r); schedule(r); return;
  }

  const r = ws.ctx && ws.ctx.room; if (!r) return err(ws, 'Join a room first.');
  const s = seatOf(r, ws); if (s < 0) return err(ws, 'Not seated.');
  try {
    switch (m.t) {
      case 'ready':
        if (r.phase !== 'lobby') return; r.seats[s].ready = !!m.ready; return broadcast(r);
      case 'settings':
        if (r.phase !== 'lobby' || s !== r.hostSeat) return err(ws, 'Only the host can change settings in the lobby.');
        r.rounds = Math.min(MAX_ROUNDS, Math.max(1, parseInt(m.rounds, 10) || r.rounds)); return broadcast(r);
      case 'kick': {
        if (r.phase !== 'lobby' || s !== r.hostSeat) return err(ws, 'Only the host can remove players in the lobby.');
        const k = parseInt(m.seat, 10); if (!(k >= 0 && k < 4) || k === s || !r.seats[k]) return;
        const w = r.seats[k].ws; if (w) { w.ctx = null; send(w, { t: 'kicked' }); }
        return removeSeat(r, k);
      }
      case 'start':
        if (r.phase !== 'lobby' || s !== r.hostSeat) return err(ws, 'Only the host can start.');
        { const hs = r.seats.filter(Boolean);
          if (hs.length < 2) return err(ws, 'Need at least 2 players to start.');
          if (!hs.every(x => x.connected)) return err(ws, 'Every player must be connected.');
          if (!hs.every(x => x.ready)) return err(ws, 'Everyone must be ready.');
          fillBots(r); }                                                  // empty seats become expert AI players
        r.scores = [0, 0, 0, 0]; r.hist = []; r.round = 0; return startRound(r);
      case 'shuffle':
        if (r.phase !== 'shuffle') return err(ws, 'Not shuffling now.');
        if (s !== r.dealer) return err(ws, 'Only the dealer can shuffle.');
        return dealNow(r);
      case 'bid':
        if (r.phase !== 'bidding') return err(ws, 'Not bidding now.');
        CM.placeBid(r.b, s, parseInt(m.value, 10)); return afterAction(r);   // everyone calls once; equal calls are fine
      case 'play': {
        if (r.phase !== 'playing') return err(ws, 'Not playing now.');
        doPlay(r, s, m.cardId);
        return afterAction(r);
      }
      case 'next':
        if (r.phase !== 'roundEnd') return; r.acks.add(s); return maybeAdvanceAcks(r);
      case 'rematch':
        if (r.phase !== 'matchEnd' || s !== r.hostSeat) return;
        dropBots(r); r.phase = 'lobby'; r.hands = null; r.b = null; r.st = null; r.last = null; r.rows = null; r.round = 0; r.scores = [0, 0, 0, 0]; r.hist = [];
        r.seats.forEach(x => x && (x.ready = false)); return broadcast(r);
      case 'leave':
        ws.ctx = null; if (r.phase === 'lobby') return removeSeat(r, s);
        r.seats[s].connected = false; r.seats[s].ws = null; broadcast(r); return schedule(r);
      default: return err(ws, 'Unknown action.');
    }
  } catch (e) { err(ws, e.message === 'out of turn' ? 'Not your turn.' : e.message === 'card not in hand' ? 'That card is not in your hand.' : 'Illegal move.'); }
}

function onClose(ws) {
  const r = ws.ctx && ws.ctx.room; if (!r) return;
  const s = seatOf(r, ws); if (s < 0) return;
  r.seats[s].connected = false; r.seats[s].ws = null;
  if (r.seats.every(x => !x || !x.connected) && r.phase === 'lobby') { /* keep until cleanup so players can resume */ }
  broadcast(r); schedule(r);
  if (r.phase === 'roundEnd') maybeAdvanceAcks(r);
}

/* ---------- HTTP + WS ---------- */
const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  const f = STATIC[p];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(ROOT, f), (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': (MIME[f.split('.').pop()] || 'text/plain') + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 32768,
  verifyClient: ({ origin }) => !ORIGINS.length || !origin || ORIGINS.includes(origin) });
wss.on('connection', (ws, req) => {
  ws.ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.alive = true; ws.on('pong', () => ws.alive = true);
  ws.on('message', d => { onMessage(ws, d.toString()).catch(() => {}); });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});
const hb = setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 25000);
const gc = setInterval(() => { const now = Date.now(); for (const [c, r] of rooms) if (now - r.touched > 3 * 3600e3) { clearTimeout(r.timer); clearTimeout(r.auto); rooms.delete(c); } }, 600000);
hb.unref(); gc.unref();

if (require.main === module) server.listen(PORT, () => console.log('CALL MASTER server on :' + PORT));
module.exports = { server, rooms };

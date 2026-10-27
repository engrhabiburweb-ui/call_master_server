/* © 2026 Habibur Rahaman Tanim. All rights reserved. */
/* CALL MASTER — game engine + offline AI. No DOM access. Works in browser (window.CM) and Node.

   Card model
     value : the card's STRENGTH when played (A black 10 … 9 black 90, red = +5, red 10 = 100)
     pts   : what the card is worth when CAPTURED in a trick = its rank (A=1 … 9=9, red 10 = 10, 0 = 0)
   A deal always totals 100 capturable points, so calls of 15–100 are measured against 100. */
(function (root) {
'use strict';

/* ================= RULES (everything unresolved lives here) ================= */
const RULES = {
  minCall: 15, maxCall: 100, step: 5,
  red10Value: 100,                 // strength of the red 10
  red10Points: 10,                 // capture worth of the red 10 (keeps a round at exactly 100 points)
  minTopStrength: 65,              // every dealt hand must contain a card at least this strong (red 6)
  zeroStrength: 'lowest',          // 'lowest' | 'highest' — trick strength of the 0 card (UNCONFIRMED)
  firstLeader: 'afterDealer',      // 'afterDealer' | 'caller' — who leads the first trick (the next seat after the dealer)
  // Trick strength: PROVISIONAL = strength value (red beats black of the same rank)
  strength(card) {
    if (card.id === '0') return this.zeroStrength === 'highest' ? 1e6 : -1;
    return card.value;
  },
  // Per-player round score: captured >= own call -> +call, otherwise Kabu -> -call
  fulfilledScore(call, captured) { return call; },
  kabuPenalty(call, captured) { return -call; }
};

/* ================= RNG ================= */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ================= DECK ================= */
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9'];
function buildDeck() {
  const d = [];
  RANKS.forEach((r, i) => {
    const n = i + 1;
    d.push({ id: r + 'B', label: r, color: 'B', value: n * 10, pts: n });
    d.push({ id: r + 'R', label: r, color: 'R', value: n * 10 + 5, pts: n });
  });
  d.push({ id: '10R', label: '10', color: 'R', value: RULES.red10Value, pts: RULES.red10Points, special: true });
  d.push({ id: '0', label: '0', color: 'N', value: 0, pts: 0, special: true });
  validateDeck(d);
  return d;
}
function validateDeck(d) {
  if (d.length !== 20) throw new Error('Deck must have 20 cards, has ' + d.length);
  if (new Set(d.map(c => c.id)).size !== 20) throw new Error('Duplicate card ids');
  const z = d.filter(c => c.id === '0');
  if (z.length !== 1 || z[0].value !== 0 || z[0].pts !== 0) throw new Error('Bad 0 card');
}
const byValue = (a, b) => a.value - b.value;
/* Deal 5 each. Rules kept: every hand holds at least one card >= minTopStrength (red 6).
   Fair shuffle: many valid random deals are drawn, and the one that keeps all four players' hand strength
   closest to equal (also counting how lucky / unlucky each seat has been in the earlier rounds of the match)
   is chosen from the best few. So nobody gets weak hands again and again, and nobody gets strong ones again and again.
   `luck` is an array of 4 numbers kept by the caller for the whole match; it is updated here. */
function deal(rng, luck) {
  const cands = [];
  for (let tries = 0; tries < 10000 && cands.length < 24; tries++) {
    const d = shuffle(buildDeck(), rng);
    validateDeck(d);
    const hands = [0, 1, 2, 3].map(p => d.slice(p * 5, p * 5 + 5));
    if (!hands.every(h => h.some(c => RULES.strength(c) >= RULES.minTopStrength))) continue;
    const pw = hands.map(predictCapture), mean = (pw[0] + pw[1] + pw[2] + pw[3]) / 4;
    let cost = 0;
    for (let p = 0; p < 4; p++) { const x = (pw[p] - mean) + (luck ? luck[p] : 0); cost += x * x; }
    const sp = Math.max(...pw) - Math.min(...pw); cost += 0.4 * sp * sp;
    cands.push({ hands, pw, mean, cost });
    if (!luck && cands.length >= 12) break;
  }
  if (!cands.length) throw new Error('Could not deal a valid hand');
  cands.sort((a, b) => a.cost - b.cost);
  const pick = cands[Math.floor(rng() * Math.min(4, cands.length))];
  if (luck) for (let p = 0; p < 4; p++) luck[p] = (luck[p] || 0) * 0.9 + (pick.pw[p] - pick.mean);
  return pick.hands.map(h => h.sort(byValue));
}

/* ================= CALL ENGINE (every player makes one call) ================= */
function legalBids() {
  const out = [];
  for (let v = RULES.minCall; v <= RULES.maxCall; v += RULES.step) out.push(v);
  return out;
}
function newBidding(start) { return { calls: [null, null, null, null], turn: start, start, history: [], done: false }; }
function placeBid(b, p, value) {
  if (b.done) throw new Error('calls finished');
  if (b.turn !== p) throw new Error('out of turn');
  if (!legalBids().includes(value)) throw new Error('illegal call ' + value);
  b.calls[p] = value; b.history.push({ p, value });
  if (b.history.length === 4) b.done = true; else b.turn = (p + 1) % 4;
}

/* ================= TRICK ENGINE ================= */
function newPlayState(hands, calls, leader) {
  return { hands, trick: [], cap: [0, 0, 0, 0], capCards: [[], [], [], []], tricks: [0, 0, 0, 0],
           leader, turn: leader, calls: calls.slice(), played: [], log: [] };
}
function trickWinner(trick) {
  let best = trick[0];
  for (const t of trick) if (RULES.strength(t.card) > RULES.strength(best.card)) best = t;
  return best.p;
}
function playCard(st, p, id) {
  if (st.turn !== p) throw new Error('out of turn');
  const i = st.hands[p].findIndex(c => c.id === id);
  if (i < 0) throw new Error('card not in hand');
  const card = st.hands[p].splice(i, 1)[0];
  st.trick.push({ p, card }); st.played.push(card.id); if (st.log) st.log.push({ p, id: card.id });
  if (st.trick.length < 4) { st.turn = (p + 1) % 4; return { completed: null }; }
  const completed = st.trick, w = trickWinner(completed);
  const pts = completed.reduce((s, t) => s + t.card.pts, 0);      // captured value = rank points
  st.cap[w] += pts; st.tricks[w]++;
  if (st.capCards) st.capCards[w].push(...completed.map(t => t.card));
  st.trick = []; st.leader = w; st.turn = w;
  return { completed, winner: w, points: pts };
}
const isOver = st => st.hands.every(h => h.length === 0);

/* ================= SCORING ENGINE ================= */
function scoreRound(st) {
  return [0, 1, 2, 3].map(p => {
    const captured = st.cap[p], call = st.calls[p], ok = captured >= call;
    return { p, captured, tricks: st.tricks[p], call, ok, kabu: !ok,
             delta: ok ? RULES.fulfilledScore(call, captured) : RULES.kabuPenalty(call, captured) };
  });
}

/* ================= AI ================= */
// Public view: the ONLY thing AI functions receive. No other player's hand is ever included.
function view(st, p) {
  return { me: p, hand: st.hands[p].slice(), trick: st.trick.slice(), played: st.played.slice(),
           sizes: st.hands.map(h => h.length), calls: st.calls.slice(), cap: st.cap.slice(), leader: st.leader, log: (st.log || []).slice() };
}
const PERS = ['aggressive', 'defensive', 'balanced'];
/* Computer players (same order as AI_BASE below): all three play like experts and go for the kill. */
const AI_PERS = ['aggressive', 'aggressive', 'aggressive'], AI_LEVEL = ['expert', 'expert', 'expert'];
/* Computer players are Tanim, Rakib and Saidy. If the human is called one of those, that computer player
   is renamed (Limon, then Rimon) so two people never share a name. */
const AI_BASE = ['Tanim', 'Rakib', 'Saidy'], AI_SUBS = ['Limon', 'Rimon'];
function aiNames(human) {
  const h = String(human || '').trim().toLowerCase(), used = new Set([h]);
  return AI_BASE.map(n => {
    if (n.toLowerCase() !== h) { used.add(n.toLowerCase()); return n; }
    const s = AI_SUBS.find(x => !used.has(x.toLowerCase())); used.add(s.toLowerCase()); return s;
  });
}

/* Expected points a hand will capture (fitted on simulated play, see tune.js). */
function predictCapture(hand) {
  const sum = hand.reduce((s, c) => s + c.value, 0);
  const high = hand.filter(c => RULES.strength(c) >= 80).length;
  return Math.max(5, 0.1133 * sum + 10.97 * high - 18.3);
}
const CALL_SCALE = { easy: 1.0, normal: 0.8, hard: 0.72, expert: 0.72 };
/* quick rule-of-thumb call (used for opponents we cannot see, and as the starting point of the call search) */
function heurBid(hand, pers, level, rng) {
  let e = predictCapture(hand) * CALL_SCALE[level || 'hard'];
  e += pers === 'aggressive' ? 6 : pers === 'defensive' ? -4 : 0;
  if (level === 'easy' && rng) e += (rng() - 0.5) * 24;
  return Math.min(RULES.maxCall, Math.max(RULES.minCall, Math.round(e / 5) * 5));
}

let DECK_KEY = '', DECK = null;
function allCards() { const k = RULES.red10Value + ':' + RULES.red10Points; if (k !== DECK_KEY) { DECK = buildDeck(); DECK_KEY = k; } return DECK; }
function unseenCards(v) {
  const mine = new Set(v.hand.map(c => c.id)), seen = new Set(v.played);
  return allCards().filter(c => !mine.has(c.id) && !seen.has(c.id));
}
function curWinner(trick) { let b = trick[0]; for (const t of trick) if (RULES.strength(t.card) > RULES.strength(b.card)) b = t; return b; }

function basicPlay(v, level, pers) {
  const S = RULES.strength.bind(RULES);
  const hand = v.hand.slice().sort((a, b) => S(a) - S(b));
  const need = v.calls[v.me] - v.cap[v.me];
  const needy = p => v.cap[p] < v.calls[p];
  const anyOtherNeedy = [0, 1, 2, 3].some(p => p !== v.me && needy(p));
  const k = pers === 'aggressive' ? 0.45 : pers === 'defensive' ? 1.0 : 0.7;
  if (v.trick.length === 0) {
    if (need > 0) {
      const top = hand[hand.length - 1];
      if (level === 'hard' || level === 'expert') {
        const un = unseenCards(v);
        if (un.every(c => S(c) < S(top))) return top;
        const med = un.map(S).sort((a, b) => a - b)[Math.floor(un.length / 2)];
        return S(top) > med || pers === 'aggressive' ? top : hand[0];
      }
      return top;
    }
    return pers === 'aggressive' && anyOtherNeedy ? hand[hand.length - 1] : hand[0];
  }
  const w = curWinner(v.trick), beaters = hand.filter(c => S(c) > S(w.card));
  const trickPts = v.trick.reduce((s, t) => s + t.card.pts, 0);
  if (beaters.length) {
    const cheap = beaters[0], value = trickPts + cheap.pts;
    if (need > 0 && value >= (need / hand.length) * k) return cheap;
    if (need <= 0 && needy(w.p) && pers !== 'defensive') return cheap;   // take points away from someone still chasing a call
  }
  return hand[0];                                                          // otherwise give away the weakest card
}

/* ---- Smart plan (hard + expert rollouts) -------------------------------------------------------
   Every player is "safe" (already has the points for their call), "doomed" (cannot reach it any more)
   or "chasing" (still can). The plan: win what I need; otherwise stop the chasing players from winning
   points, and let safe/doomed players take the tricks (their points are then not available to the chasers). */
function smartPlay(v, pers) {
  const S = RULES.strength.bind(RULES), me = v.me;
  const hand = v.hand.slice().sort((a, b) => S(a) - S(b));
  const un = unseenCards(v);
  const rem = v.hand.reduce((s, c) => s + c.pts, 0) + un.reduce((s, c) => s + c.pts, 0) + v.trick.reduce((s, t) => s + t.card.pts, 0);
  const status = p => v.cap[p] >= v.calls[p] ? 'safe' : (v.calls[p] - v.cap[p] > rem ? 'doomed' : 'chasing');
  const chasing = [0, 1, 2, 3].filter(p => p !== me && status(p) === 'chasing');
  const mine = status(me);
  const lowestPts = () => hand.slice().sort((a, b) => a.pts - b.pts || S(a) - S(b))[0];
  const top = hand[hand.length - 1], topIsSure = un.every(c => S(c) < S(top));
  const k = pers === 'aggressive' ? 0.45 : pers === 'defensive' ? 1.0 : 0.7;
  const per = (v.calls[me] - v.cap[me]) / hand.length;
  if (v.trick.length === 0) {                                   // I lead
    if (mine === 'chasing') return topIsSure || per >= 12 || pers === 'aggressive' ? top : lowestPts();
    return chasing.length && topIsSure ? top : lowestPts();     // safe/doomed: steal points from chasers only when it is sure
  }
  const w = curWinner(v.trick), beaters = hand.filter(c => S(c) > S(w.card));
  const tp = v.trick.reduce((s, t) => s + t.card.pts, 0), wChasing = status(w.p) === 'chasing';
  if (mine === 'chasing') {
    if (beaters.length && (wChasing || tp + beaters[0].pts >= per * k)) return beaters[0];
    return lowestPts();
  }
  if (wChasing) return beaters.length ? beaters[0] : lowestPts();   // do not let him have the points
  const waiting = [0, 1, 2, 3].filter(p => p !== me && !v.trick.some(t => t.p === p));
  const threatAfter = waiting.some(p => status(p) === 'chasing');
  const nonBeat = hand.filter(c => S(c) < S(w.card));
  if (!threatAfter && nonBeat.length) return nonBeat.sort((a, b) => b.pts - a.pts || S(a) - S(b))[0];   // feed the safe winner
  if (threatAfter && topIsSure && beaters.length) return top;       // a chaser still to play: take it first
  return lowestPts();
}
function heurPlay(v, level, pers) { return (level === 'hard' || level === 'expert') ? smartPlay(v, pers) : basicPlay(v, level, pers); }

/* =====================================================================================================
   STRONG AI  (all levels)
   Every decision is made by simulation: the AI imagines many possible deals of the cards it cannot see
   (consistent with the deal rules, the calls everybody made and the cards already played), plays each
   candidate out to the end of the round, and picks the move with the best "utility":

        utility = my own score change  +  sum over others (weight x their score change)

   The weights are what make the AI play with a purpose:
     - against a human: all computer players are one team; the human is the common target (more so if he
       made the highest call or leads the match) and the other computers are friends whose success helps;
     - without a human (free for all): the match leader, whoever is catching up, and the highest caller are targeted.
   A player whose own call is out of reach simply stops caring about his own points, so he keeps big
   cards back and spends his cards on making the target fail (that falls out of the utility automatically).
   The AI never looks at hidden hands. ===================================================================== */
const LV = {
  easy:   { N: 16,  bidN: 24,  noise: 0.10, infer: false, Wh: 0.65, A: 0.30, bias: -5 },
  normal: { N: 34,  bidN: 44,  noise: 0.03, infer: true,  Wh: 0.85, A: 0.40, bias: 0 },
  hard:   { N: 70,  bidN: 70,  noise: 0,    infer: true,  Wh: 1.00, A: 0.50, bias: 0 },
  expert: { N: 120, bidN: 110, noise: 0,    infer: true,  Wh: 1.10, A: 0.55, bias: 0 }
};
function normCtx(ctx) {
  ctx = ctx || {};
  const humans = Array.isArray(ctx.humans) ? ctx.humans.slice() : (ctx.human != null && ctx.human >= 0 ? [ctx.human] : []);
  return { totals: (ctx.totals || [0, 0, 0, 0]).slice(), humans, pers: ctx.pers || [], round: ctx.round || 0, rounds: ctx.rounds || 0 };
}
/* how much does seat `me` value a change in the score of every other seat? (negative = wants him to lose) */
function weightsFor(me, calls, ctx, lv, pers) {
  const H = ctx.humans, tot = ctx.totals, u = [0, 0, 0, 0], others = [0, 1, 2, 3].filter(p => p !== me);
  const maxCall = Math.max(...others.map(p => calls[p] || 0)), maxTot = Math.max(...others.map(p => tot[p] || 0));
  const aggr = pers === 'aggressive' ? 1.3 : pers === 'defensive' ? 0.9 : 1, def = pers === 'defensive' ? 1.2 : 1;
  const teamMode = H.length > 0 && !H.includes(me);
  for (const p of others) {
    if (teamMode) {
      if (H.includes(p)) {
        let w = lv.Wh * aggr;
        if (calls[p] != null && calls[p] > 0 && calls[p] >= maxCall) w *= 1.2;          // the human made the highest call
        if ((tot[p] || 0) >= maxTot && (tot[p] || 0) > (tot[me] || 0) - 1) w *= 1.2;    // the human leads the match
        u[p] = -w;
      } else u[p] = lv.A * def;
    } else {
      let w = 0.18;
      const gap = (tot[p] || 0) - (tot[me] || 0);
      w += Math.max(0, Math.min(0.4, gap / 60));                                        // ahead of me in the match
      if ((tot[p] || 0) >= maxTot && maxTot > 0) w += 0.12;                             // the match leader
      if (calls[p] != null && calls[p] > 0 && calls[p] >= maxCall) w += 0.25;           // the highest caller
      u[p] = -w * aggr;
    }
  }
  return u;
}
function utility(st, me, u) {
  const d = p => (st.cap[p] >= st.calls[p] ? RULES.fulfilledScore(st.calls[p], st.cap[p]) : RULES.kabuPenalty(st.calls[p], st.cap[p]));
  let x = d(me);
  for (let p = 0; p < 4; p++) if (p !== me && u[p]) x += u[p] * d(p);
  return x / 100 + 0.002 * st.cap[me];
}
function rollout(st) {
  while (!isOver(st)) { const p = st.turn; playCard(st, p, smartPlay(view(st, p), 'balanced').id); }
  return st;
}
function playedByCards(v) {
  const pb = [[], [], [], []], map = new Map(allCards().map(c => [c.id, c]));
  (v.log || []).forEach(e => pb[e.p].push(map.get(e.id)));
  return pb;
}
/* one random deal of the unseen cards to the other seats that respects the "everyone holds a 65+ card" rule */
function sampleHands(v, un, others, topDone, rng) {
  const hands = [[], [], [], []]; hands[v.me] = v.hand.slice();
  for (let t = 0; t < 40; t++) {
    const pool = shuffle(un, rng); let k = 0, ok = true;
    for (const p of others) {
      const h = pool.slice(k, k + v.sizes[p]); k += v.sizes[p]; hands[p] = h;
      if (!topDone[p] && !h.some(c => RULES.strength(c) >= RULES.minTopStrength)) ok = false;
    }
    if (ok) break;
  }
  return hands;
}
const persOff = p => p === 'aggressive' ? 6 : p === 'defensive' ? -4 : 0;
/* how plausible is this deal, given the calls the others made? (a big call means a strong hand) */
function plausibility(calls, hands, pb, others, ctx, me) {
  let lw = 0;
  for (const p of others) {
    if (calls[p] == null) continue;
    const e = Math.min(RULES.maxCall, Math.max(RULES.minCall, predictCapture(hands[p].concat(pb ? pb[p] : [])) * CALL_SCALE.hard + persOff(ctx.pers[p])));
    const sd = ctx.humans.includes(p) ? 18 : 12;
    lw -= ((calls[p] - e) * (calls[p] - e)) / (2 * sd * sd);
  }
  return Math.exp(lw);
}

function searchPlay(v, lv, pers, rng, ctx) {
  const me = v.me, hand = v.hand, un = unseenCards(v), others = [0, 1, 2, 3].filter(p => p !== me);
  const u = weightsFor(me, v.calls, ctx, lv, pers), pb = playedByCards(v);
  const topDone = pb.map(a => a.some(c => RULES.strength(c) >= RULES.minTopStrength));
  const score = hand.map(() => 0), ful = hand.map(() => 0); let wsum = 0; const t0 = Date.now();
  for (let s = 0; s < lv.N; s++) {
    if (s >= 16 && Date.now() - t0 > 250) break;
    const hands = sampleHands(v, un, others, topDone, rng);
    const w = lv.infer ? plausibility(v.calls, hands, pb, others, ctx, me) : 1;
    if (w < 1e-6) continue;
    for (let i = 0; i < hand.length; i++) {
      const st = { hands: hands.map(h => h.slice()), trick: v.trick.slice(), cap: v.cap.slice(), tricks: [0, 0, 0, 0],
                   leader: v.leader, turn: me, calls: v.calls.slice(), played: v.played.slice(), log: [] };
      playCard(st, me, hand[i].id); rollout(st);
      score[i] += w * utility(st, me, u);
      if (st.cap[me] >= st.calls[me]) ful[i] += w;
    }
    wsum += w;
  }
  if (!wsum) return smartPlay(v, pers);
  let bi = 0; for (let i = 1; i < hand.length; i++) if (score[i] > score[bi]) bi = i;
  /* My own call is already made (or almost certainly will be): my own points no longer matter, so among the
     moves that are about equally good I spend the SMALLEST card and keep the biggest ones to take points
     away from the players who are still chasing their call. */
  if (v.cap[me] >= v.calls[me] || ful[bi] / wsum >= 0.85) {
    const eps = 0.02 * wsum; let best = bi;
    for (let i = 0; i < hand.length; i++)
      if (score[i] >= score[bi] - eps && RULES.strength(hand[i]) < RULES.strength(hand[best])) best = i;
    bi = best;
  }
  return hand[bi];
}

/* ---- calls: simulate the whole round for every possible call and keep the best one ---- */
function searchBid(hand, b, lv, pers, rng, ctx) {
  const me = b.turn, mine = new Set(hand.map(c => c.id)), un = allCards().filter(c => !mine.has(c.id));
  const others = [0, 1, 2, 3].filter(p => p !== me), pc = predictCapture(hand);
  const hi = Math.min(RULES.maxCall, Math.max(40, Math.ceil((pc * 1.6 + 10) / 5) * 5)), cands = [];
  for (let c = RULES.minCall; c <= hi; c += RULES.step) cands.push(c);
  const score = cands.map(() => 0); let wsum = 0; const t0 = Date.now();
  for (let s = 0; s < lv.bidN; s++) {
    if (s >= 16 && Date.now() - t0 > 350) break;
    const v = { me, hand, sizes: [5, 5, 5, 5], played: [], log: [] };
    const hands = sampleHands(v, un, others, [false, false, false, false], rng);
    const w = lv.infer ? plausibility(b.calls, hands, null, others, ctx, me) : 1;
    if (w < 1e-6) continue;
    const calls = b.calls.slice();
    for (const p of others) if (calls[p] == null) calls[p] = heurBid(hands[p], ctx.pers[p] || 'balanced', 'hard');
    for (let i = 0; i < cands.length; i++) {
      calls[me] = cands[i];
      const st = newPlayState(hands.map(h => h.slice()), calls, b.start); rollout(st);
      score[i] += w * utility(st, me, weightsFor(me, calls, ctx, lv, pers));
    }
    wsum += w;
  }
  if (!wsum) return heurBid(hand, pers, 'hard');
  let bi = 0; for (let i = 1; i < cands.length; i++) if (score[i] > score[bi]) bi = i;
  const eps = 0.012 * 100 / 100;   // personality: near-ties go to the bolder / safer call
  if (pers === 'aggressive' && bi + 1 < cands.length && score[bi + 1] >= score[bi] - eps * wsum) bi++;
  if (pers === 'defensive' && bi > 0 && score[bi - 1] >= score[bi] - eps * wsum) bi--;
  return Math.min(RULES.maxCall, Math.max(RULES.minCall, cands[bi] + (lv.bias || 0)));
}

function aiBid(hand, b, level, pers, rng, ctx) {
  const lv = LV[level] || LV.hard; ctx = normCtx(ctx);
  return { value: searchBid(hand, b, lv, pers, rng, ctx) };
}
function aiPlay(v, level, pers, rng, ctx) {
  if (v.hand.length === 1) return v.hand[0];
  const lv = LV[level] || LV.hard; ctx = normCtx(ctx);
  if (lv.noise && rng() < lv.noise) return v.hand[Math.floor(rng() * v.hand.length)];
  return searchPlay(v, lv, pers, rng, ctx);
}

/* Headless full round (used by tests and balance checks). start = seat after the dealer. */
function simulateRound(seed, levels, pers, start, ctx) {
  const rng = mulberry32(seed), hands = deal(rng), b = newBidding(start || 0);
  while (!b.done) { const p = b.turn; placeBid(b, p, aiBid(hands[p], b, levels[p], pers[p], rng, ctx).value); }
  const st = newPlayState(hands, b.calls, RULES.firstLeader === 'afterDealer' ? (start || 0) : (start || 0));
  while (!isOver(st)) { const p = st.turn; playCard(st, p, aiPlay(view(st, p), levels[p], pers[p], rng, ctx).id); }
  return { st, bidding: b, rows: scoreRound(st) };
}

const CM = { RULES, mulberry32, shuffle, buildDeck, validateDeck, deal, legalBids, newBidding, placeBid,
  newPlayState, trickWinner, playCard, isOver, scoreRound, view, aiBid, aiPlay, simulateRound, predictCapture, heurPlay, smartPlay, basicPlay, aiNames, PERS, AI_PERS, AI_LEVEL, heurBid, LV };
if (typeof module !== 'undefined' && module.exports) module.exports = CM;
root.CM = CM;
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';

/* ==========================================================================
   Torn Blackjack Tracker
   Static page. No backend. The API key lives in this browser and is sent
   only to api.torn.com.
   ========================================================================== */

const VERSION = '0.3.0';

/* --------------------------------------------------------------------------
   GAME CONFIG
   Each casino game is its own log category with its own event types. The
   fetch, cache, aggregation and export code below is game-agnostic, so
   adding roulette or slots later means adding an entry here.
   -------------------------------------------------------------------------- */

const GAMES = {
  blackjack: {
    label: 'Blackjack',
    category: 191,
    startType: 8350,
    splitType: 8353,
    // Money leaving your balance, and money coming back. Verified against
    // real logs: `winnings` is GROSS (stake included), and a push returns
    // the stake under the key `money`, not `winnings`.
    moneyOut: ['bet'],
    moneyIn: ['winnings', 'money'],
    types: {
      8350: { key: 'start',          label: 'Start' },
      8351: { key: 'hit',            label: 'Hit' },
      8352: { key: 'double',         label: 'Double down' },
      8353: { key: 'split',          label: 'Split' },
      8354: { key: 'lose',           label: 'Loss',      outcome: 'loss' },
      8355: { key: 'win',            label: 'Win',       outcome: 'win' },
      8356: { key: 'insurance_lose', label: 'Insurance lost' },
      8357: { key: 'insurance_win',  label: 'Insurance won' },
      8358: { key: 'push',           label: 'Push',      outcome: 'push' },
      8359: { key: 'surrender',      label: 'Surrender', outcome: 'surrender' }
    }
  }
};

const GAME = GAMES.blackjack;

const API_ROOT     = 'https://api.torn.com';
const PAGE_LIMIT   = 100;
const CALLS_PER_MIN = 60;   // Torn allows 100. Deliberately conservative.
const DAY = 86400;

/* --------------------------------------------------------------------------
   SMALL HELPERS
   -------------------------------------------------------------------------- */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
const nowTs = () => Math.floor(Date.now() / 1000);

function fmtFull(n) {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
}

function fmtShort(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'b';
  if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(2) + 'm';
  if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(1) + 'k';
  return sign + '$' + Math.round(a);
}

function signClass(n) { return n > 0 ? 'pos' : (n < 0 ? 'neg' : ''); }

// Torn City Time is UTC. Local mode uses the viewer's own offset.
function dayKey(ts, useLocal) {
  const d = new Date(ts * 1000);
  if (useLocal) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return d.toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------------------------------------------------------
   STORAGE
   Raw events go in IndexedDB rather than localStorage: a heavy player can
   generate tens of thousands of them, well past the ~5MB localStorage cap.
   We keep raw events (not pre-computed totals) so that if the insurance
   question is ever settled the other way, everything recalculates from
   cache instead of re-downloading.
   -------------------------------------------------------------------------- */

const DB_NAME = 'torn-blackjack-tracker';
const DB_VER = 1;
const STORE_EVENTS = 'events';
const STORE_META = 'meta';

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const s = db.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return openDb().then((db) => db.transaction(store, mode).objectStore(store));
}

async function putEvents(rows) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_EVENTS, 'readwrite');
    const s = t.objectStore(STORE_EVENTS);
    for (const r of rows) s.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function allEvents() {
  const s = await tx(STORE_EVENTS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function countEvents() {
  const s = await tx(STORE_EVENTS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = s.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function metaGet(k, dflt) {
  const s = await tx(STORE_META, 'readonly');
  return new Promise((resolve) => {
    const req = s.get(k);
    req.onsuccess = () => resolve(req.result === undefined ? dflt : req.result);
    req.onerror = () => resolve(dflt);
  });
}

async function metaSet(k, v) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_META, 'readwrite');
    t.objectStore(STORE_META).put(v, k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function wipeAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_EVENTS, STORE_META], 'readwrite');
    t.objectStore(STORE_EVENTS).clear();
    t.objectStore(STORE_META).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* Covered time ranges, so a second fetch never re-downloads the first. */
function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/* Subtract already-covered ranges from a wanted range. */
function missingParts(want, covered) {
  let gaps = [[want[0], want[1]]];
  for (const c of covered) {
    const next = [];
    for (const g of gaps) {
      if (c[1] < g[0] || c[0] > g[1]) { next.push(g); continue; }
      if (c[0] > g[0]) next.push([g[0], c[0] - 1]);
      if (c[1] < g[1]) next.push([c[1] + 1, g[1]]);
    }
    gaps = next;
  }
  return gaps.filter((g) => g[1] > g[0]);
}

/* --------------------------------------------------------------------------
   THEME
   Three states. "auto" removes the attribute entirely so the OS preference
   applies through the media query; the other two pin it.
   -------------------------------------------------------------------------- */

const THEME_STORAGE = 'tbt.theme';
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };

function applyTheme(mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  const btn = document.getElementById('btnTheme');
  if (btn) btn.textContent = THEME_LABEL[mode];
  try { localStorage.setItem(THEME_STORAGE, mode); } catch (e) { /* private mode */ }
}

function currentTheme() {
  try {
    const v = localStorage.getItem(THEME_STORAGE);
    return THEME_ORDER.includes(v) ? v : 'auto';
  } catch (e) { return 'auto'; }
}

/* --------------------------------------------------------------------------
   API KEY
   Held in memory always. Persisted only if the user opts in. The input is a
   plain text field masked with CSS, never type="password" and never inside a
   form, so Chrome's password manager has nothing to latch onto.
   -------------------------------------------------------------------------- */

const KEY_STORAGE = 'tbt.key';
let apiKey = null;

function loadStoredKey() {
  try { return localStorage.getItem(KEY_STORAGE); } catch (e) { return null; }
}
function storeKey(k) {
  try { localStorage.setItem(KEY_STORAGE, k); } catch (e) { /* private mode */ }
}
function clearStoredKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch (e) { /* ignore */ }
}

/* --------------------------------------------------------------------------
   RATE LIMITED FETCH
   -------------------------------------------------------------------------- */

const callTimes = [];

function callsLastMinute() {
  const cut = Date.now() - 60000;
  while (callTimes.length && callTimes[0] < cut) callTimes.shift();
  return callTimes.length;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function throttle() {
  while (callsLastMinute() >= CALLS_PER_MIN) {
    const waitMs = 60000 - (Date.now() - callTimes[0]) + 50;
    setRate(`waiting ${Math.ceil(waitMs / 1000)}s`, true);
    await sleep(Math.min(waitMs, 2000));
  }
  callTimes.push(Date.now());
  setRate(`${callsLastMinute()}/${CALLS_PER_MIN} per min`, true);
}

async function apiGet(path, params) {
  await throttle();
  const url = new URL(API_ROOT + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', apiKey);

  let res;
  try {
    res = await fetch(url.toString(), { credentials: 'omit', cache: 'no-store' });
  } catch (e) {
    throw new Error('Could not reach the Torn API. Check your connection.');
  }
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('Torn returned something unreadable.');
  if (json.error) {
    throw new Error(`Torn API error ${json.error.code}: ${json.error.error}`);
  }
  return json;
}

/* --------------------------------------------------------------------------
   SYNC
   The log endpoint returns newest-first. We page backwards with `to`, using
   `from` to bound the window server-side. Overlap is harmless because events
   are keyed by their own id.
   -------------------------------------------------------------------------- */

// Compress an API event down to what the maths needs.
// `ix` is its index within its page: the API returns descending, so for two
// events sharing a timestamp the higher index is the earlier one. Sorting by
// (ts asc, ix desc) reproduces true chronological order without relying on
// timestamps alone, which collide when a double down resolves instantly.
function compress(ev, ix) {
  const d = ev.data || {};
  const row = { id: ev.id, ts: ev.timestamp, t: (ev.details && ev.details.id) || 0, ix };
  if (d.bet !== undefined) row.b = num(d.bet);
  if (d.winnings !== undefined) row.w = num(d.winnings);
  if (d.money !== undefined) row.m = num(d.money);
  return row;
}

async function fetchRange(fromTs, toTs, onProgress) {
  let cursor = toTs;
  let fetched = 0;
  let pages = 0;
  const span = Math.max(1, toTs - fromTs);

  while (true) {
    const json = await apiGet('/v2/user/log', {
      cat: GAME.category, limit: PAGE_LIMIT, from: fromTs, to: cursor
    });
    const page = json.log || [];
    pages++;
    if (!page.length) break;

    await putEvents(page.map(compress));
    fetched += page.length;

    let oldest = Infinity;
    for (const e of page) oldest = Math.min(oldest, e.timestamp);

    if (onProgress) {
      const done = Math.min(1, (toTs - oldest) / span);
      onProgress(done, fetched, pages);
    }

    if (page.length < PAGE_LIMIT) break;   // window exhausted
    if (oldest <= fromTs) break;
    // Inclusive `to` means one overlapping event; dedupe handles it. If the
    // cursor fails to move (a whole page sharing one timestamp) step past it.
    cursor = (oldest === cursor) ? oldest - 1 : oldest;
  }

  const covered = mergeRanges(
    (await metaGet('covered', [])).concat([[fromTs, toTs]])
  );
  await metaSet('covered', covered);
  return fetched;
}

/* --------------------------------------------------------------------------
   ENGINE
   Deals are grouped by walking from one start event to the next. Money in
   minus money out gives net, with no special cases for doubles, splits,
   pushes or surrenders.
   -------------------------------------------------------------------------- */

function sortEvents(rows) {
  return rows.slice().sort((a, b) => (a.ts - b.ts) || ((b.ix || 0) - (a.ix || 0)));
}

function buildDeals(rows) {
  const events = sortEvents(rows);
  const deals = [];
  const unknownTypes = new Set();
  let cur = null;
  let orphans = 0;

  const finish = (d) => {
    if (!d) return;
    d.expected = 1 + d.splits;
    d.complete = d.outcomes.length >= d.expected;
    d.net = d.moneyIn - d.moneyOut;
    deals.push(d);
  };

  for (const e of events) {
    const def = GAME.types[e.t];
    if (!def) unknownTypes.add(e.t);

    if (e.t === GAME.startType) {
      finish(cur);
      cur = {
        ts: e.ts, openingBet: num(e.b), moneyIn: 0, moneyOut: 0,
        splits: 0, doubled: false, insuranceWin: false, insuranceBet: 0,
        insuranceReturn: 0, outcomes: []
      };
    }

    // Events arriving before the first start belong to a deal that began
    // outside the loaded window. Counting them would distort the totals.
    if (!cur) { orphans++; continue; }

    if (e.b !== undefined) cur.moneyOut += e.b;
    if (e.w !== undefined) cur.moneyIn += e.w;
    if (e.m !== undefined) cur.moneyIn += e.m;

    if (e.t === GAME.splitType) cur.splits++;
    if (def && def.key === 'double') cur.doubled = true;
    if (def && def.key === 'insurance_win') {
      cur.insuranceWin = true;
      cur.insuranceBet = num(e.b);
      cur.insuranceReturn = num(e.w);
    }
    if (def && def.outcome) cur.outcomes.push(def.outcome);
  }
  finish(cur);

  return { deals, unknownTypes: Array.from(unknownTypes), orphans };
}

function aggregate(deals) {
  const s = {
    hands: 0, deals: 0, win: 0, loss: 0, push: 0, surrender: 0,
    wagered: 0, returned: 0, net: 0,
    insuranceHands: 0, incomplete: 0,
    best: null, worst: null
  };
  for (const d of deals) {
    if (!d.complete) { s.incomplete++; continue; }
    s.deals++;
    s.wagered += d.moneyOut;
    s.returned += d.moneyIn;
    s.net += d.net;
    if (d.insuranceWin) s.insuranceHands++;
    for (const o of d.outcomes) {
      s.hands++;
      if (o === 'win') s.win++;
      else if (o === 'loss') s.loss++;
      else if (o === 'push') s.push++;
      else if (o === 'surrender') s.surrender++;
    }
    if (!s.best || d.net > s.best.net) s.best = d;
    if (!s.worst || d.net < s.worst.net) s.worst = d;
  }
  const decided = s.win + s.loss;
  s.winRate = decided ? (s.win / decided) : null;
  s.edge = s.wagered ? (s.net / s.wagered) : null;
  return s;
}

function groupByDay(deals, useLocal) {
  const map = new Map();
  for (const d of deals) {
    if (!d.complete) continue;
    const k = dayKey(d.ts, useLocal);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  return Array.from(map.entries())
    .map(([day, list]) => ({ day, ...aggregate(list) }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

/* --------------------------------------------------------------------------
   UI STATE
   -------------------------------------------------------------------------- */

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ALL_DOW = [0, 1, 2, 3, 4, 5, 6];

const state = {
  deals: [],
  unknownTypes: [],
  orphans: 0,
  range: 'today',
  useLocal: false,
  dow: new Set(ALL_DOW),
  busy: false
};

// Which weekday a hand fell on, honouring the TCT/local toggle so the filter
// agrees with the day boundaries used everywhere else.
function dowOf(ts, useLocal) {
  const d = new Date(ts * 1000);
  return useLocal ? d.getDay() : d.getUTCDay();
}

// Every view below the filter row works from this, so the weekday filter
// applies to the summary, the chart and the table alike.
function visibleDeals() {
  if (state.dow.size === 7) return state.deals;
  return state.deals.filter((d) => state.dow.has(dowOf(d.ts, state.useLocal)));
}

function dowSummary() {
  if (state.dow.size === 7) return null;
  if (state.dow.size === 0) return 'none';
  const picked = ALL_DOW.filter((d) => state.dow.has(d));
  // Monday-first reads better than the 0=Sunday index order.
  const ordered = [1, 2, 3, 4, 5, 6, 0].filter((d) => picked.includes(d));
  return ordered.map((d) => DOW_NAMES[d] + 's').join(', ');
}

function setRate(text, busy) {
  const el = $('#rateBadge');
  el.textContent = text;
  el.classList.toggle('busy', !!busy);
}

function showMsg(sel, text, kind) {
  const el = $(sel);
  el.textContent = text;
  el.className = 'msg ' + (kind || '');
  el.classList.remove('hidden');
}
function hideMsg(sel) { $(sel).classList.add('hidden'); }

function setBusy(b) {
  state.busy = b;
  $$('#loadRow .btn, #btnCustom').forEach((el) => { el.disabled = b; });
  if (!b) setRate(`${callsLastMinute()}/${CALLS_PER_MIN} per min`, false);
}

/* --------------------------------------------------------------------------
   RENDER
   -------------------------------------------------------------------------- */

function rangeBounds() {
  const now = nowTs();
  if (state.range === 'all') return [0, now];
  if (state.range === 'today') {
    const k = dayKey(now, state.useLocal);
    const start = state.useLocal
      ? Math.floor(new Date(k + 'T00:00:00').getTime() / 1000)
      : Math.floor(Date.parse(k + 'T00:00:00Z') / 1000);
    return [start, now];
  }
  return [now - Number(state.range) * DAY, now];
}

function renderDowChips() {
  const all = state.dow.size === 7;
  $$('#dowPick button').forEach((b) => {
    if (b.dataset.dow === 'all') b.classList.toggle('on', all);
    else b.classList.toggle('on', !all && state.dow.has(Number(b.dataset.dow)));
  });
}

function renderStats() {
  const [from, to] = rangeBounds();
  const inRange = visibleDeals().filter((d) => d.ts >= from && d.ts <= to);
  const s = aggregate(inRange);

  const dowNote = dowSummary();
  const hint = $('#dowHint');
  if (dowNote === 'none') {
    hint.textContent = 'No weekdays selected, so nothing is shown. Press All to bring everything back.';
    hint.classList.remove('hidden');
  } else if (dowNote) {
    hint.textContent = `Showing ${dowNote} only — this applies to the chart and the day table too.`;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }

  // Net profit is the number people actually came for, so it gets to be the
  // headline rather than one tile among eight.
  $('#hero').innerHTML = `
    <div>
      <div class="cap">Net profit</div>
      <div class="figure ${signClass(s.net)}">${escapeHtml(fmtShort(s.net))}</div>
    </div>
    <div class="exact">${escapeHtml(fmtFull(s.net))} over ${s.hands.toLocaleString()} hand${s.hands === 1 ? '' : 's'}</div>`;

  // Outcome mix as one bar. Four counts side by side are harder to read at a
  // glance than their proportions.
  const total = s.win + s.loss + s.push + s.surrender;
  if (total) {
    const pct = (n) => (n / total) * 100;
    const key = [
      ['w', 'Won', s.win, 'var(--win)'],
      ['l', 'Lost', s.loss, 'var(--loss)'],
      ['p', 'Pushed', s.push, 'var(--push)'],
      ['s', 'Surrendered', s.surrender, 'var(--gold)']
    ];
    $('#wlp').innerHTML = `
      <div class="wlpbar" role="img" aria-label="${s.win} won, ${s.loss} lost, ${s.push} pushed, ${s.surrender} surrendered">
        ${key.map(([c, , n]) => n ? `<span class="${c}" style="width:${pct(n).toFixed(2)}%"></span>` : '').join('')}
      </div>
      <div class="wlpkey">
        ${key.map(([, label, n, col]) =>
          `<span><i class="dotmark" style="background:${col}"></i>${label} <b>${n.toLocaleString()}</b></span>`).join('')}
      </div>`;
  } else {
    $('#wlp').innerHTML = '<p class="muted">No completed hands in this range.</p>';
  }

  const tiles = [
    { k: 'Deals', v: s.deals.toLocaleString(), sub: `${s.hands.toLocaleString()} hands` },
    { k: 'Win rate', v: s.winRate === null ? '—' : `${(s.winRate * 100).toFixed(1)}%`,
      sub: 'of decided hands' },
    { k: 'Wagered', v: fmtShort(s.wagered), sub: fmtFull(s.wagered) },
    { k: 'Return', v: s.edge === null ? '—' : `${(s.edge * 100).toFixed(2)}%`,
      cls: s.edge === null ? '' : signClass(s.edge), sub: 'net vs wagered' },
    { k: 'Best deal', v: s.best ? fmtShort(s.best.net) : '—', cls: s.best ? 'pos' : '' },
    { k: 'Worst deal', v: s.worst ? fmtShort(s.worst.net) : '—', cls: s.worst ? 'neg' : '' }
  ];

  $('#stats').innerHTML = tiles.map((t) => `
    <div class="stat">
      <div class="k">${escapeHtml(t.k)}</div>
      <div class="v ${t.cls || ''}">${escapeHtml(t.v)}</div>
      ${t.sub ? `<div class="sub">${escapeHtml(t.sub)}</div>` : ''}
    </div>`).join('');

  $('#tzNote').textContent = state.useLocal
    ? 'Days run midnight to midnight in your local timezone.'
    : 'Days run midnight to midnight in TCT (Torn City Time, which is UTC).';
}

function renderChart() {
  const days = groupByDay(visibleDeals(), state.useLocal).slice().reverse();
  const box = $('#chart');
  if (days.length < 2) {
    box.innerHTML = days.length
      ? '<p class="muted">Only one day matches. Widen the filter to see a trend.</p>'
      : '<p class="muted">Load a few days of history to see a trend.</p>';
    return;
  }

  let run = 0;
  const pts = days.map((d) => { run += d.net; return { day: d.day, y: run }; });
  const ys = pts.map((p) => p.y);
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const range = (max - min) || 1;

  const W = 900, H = 220, PADL = 56, PADR = 10, PADY = 16;
  const x = (i) => PADL + (i * (W - PADL - PADR)) / Math.max(1, pts.length - 1);
  const y = (v) => PADY + (1 - (v - min) / range) * (H - PADY * 2);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const stroke = run >= 0 ? 'var(--win)' : 'var(--loss)';

  // Four horizontal guides so a reader can judge magnitude, not just shape.
  const ticks = [];
  for (let i = 0; i <= 3; i++) {
    const v = min + (range * i) / 3;
    ticks.push(`<line class="grid" x1="${PADL}" x2="${W - PADR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="lbl" x="${PADL - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${escapeHtml(fmtShort(v))}</text>`);
  }

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Cumulative profit from ${escapeHtml(pts[0].day)} to ${escapeHtml(pts[pts.length - 1].day)}, ending at ${escapeHtml(fmtFull(run))}">
      <defs>
        <linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${stroke}" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="${stroke}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${ticks.join('')}
      ${(min < 0 && max > 0) ? `<line class="zero" x1="${PADL}" x2="${W - PADR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : ''}
      <path d="${area}" fill="url(#fillGrad)"/>
      <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(run).toFixed(1)}" r="3.5" fill="${stroke}"/>
    </svg>
    <p class="fineprint">${escapeHtml(pts[0].day)} to ${escapeHtml(pts[pts.length - 1].day)} &mdash;
      cumulative net ${escapeHtml(fmtFull(run))} across the loaded history.</p>`;
}

function renderDays() {
  const rows = groupByDay(visibleDeals(), state.useLocal);
  const body = $('#dayTable tbody');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">${
      state.dow.size < 7 ? 'No hands match the weekday filter.' : 'No completed hands loaded yet.'
    }</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.day)}</td>
      <td class="num">${r.hands}</td>
      <td class="num">${r.win}</td>
      <td class="num">${r.loss}</td>
      <td class="num">${r.push}</td>
      <td class="num">${r.surrender}</td>
      <td class="num">${escapeHtml(fmtShort(r.wagered))}</td>
      <td class="num ${signClass(r.net)}">${escapeHtml(fmtShort(r.net))}</td>
    </tr>`).join('');
}

function renderFlags() {
  const all = aggregate(state.deals);
  const out = [];

  if (state.unknownTypes.length) {
    out.push(`<div class="flag"><strong>Unrecognised log types:</strong>
      ${escapeHtml(state.unknownTypes.join(', '))}. These were counted for money but not
      classified as wins or losses. Torn may have added something new &mdash; worth reporting.</div>`);
  }

  if (all.insuranceHands) {
    out.push(`<div class="flag"><strong>${all.insuranceHands} hand${all.insuranceHands === 1 ? '' : 's'}
      won on insurance.</strong> Torn's logs record the insurance payout in a way that could mean
      one of two amounts, and the log alone cannot tell them apart. These hands are counted using
      the same rule as every other payout. If they matter to you, check your cash before and after
      the next one &mdash; if it comes out even, the figure here is understating you by half the
      main bet on each.</div>`);
  }

  if (all.incomplete) {
    out.push(`<div class="flag"><strong>${all.incomplete} deal${all.incomplete === 1 ? '' : 's'}
      excluded as incomplete.</strong> Normally a hand still in progress, or one that started just
      outside the loaded window. Excluded from every total on this page.</div>`);
  }

  if (state.orphans) {
    out.push(`<div class="flag">${state.orphans} event${state.orphans === 1 ? '' : 's'} at the very
      start of the loaded range belong to a deal that began earlier. Ignored, so they cannot skew
      the numbers. Loading a little more history absorbs them.</div>`);
  }

  if (!out.length) {
    out.push('<div class="flag none">Nothing unusual. Every loaded hand was recognised and accounted for.</div>');
  }
  $('#flags').innerHTML = out.join('');
}

async function renderCoverage() {
  const covered = await metaGet('covered', []);
  const n = await countEvents();
  if (!covered.length) {
    $('#coverage').textContent = 'nothing loaded yet';
    return;
  }
  const from = Math.min(...covered.map((c) => c[0]));
  const to = Math.max(...covered.map((c) => c[1]));
  $('#coverage').textContent =
    `${dayKey(from, false)} to ${dayKey(to, false)} · ${n.toLocaleString()} events`;
}

async function refresh() {
  const rows = await allEvents();
  const built = buildDeals(rows);
  state.deals = built.deals;
  state.unknownTypes = built.unknownTypes;
  state.orphans = built.orphans;
  renderStats();
  renderChart();
  renderDays();
  renderFlags();
  await renderCoverage();
}

/* --------------------------------------------------------------------------
   ACTIONS
   -------------------------------------------------------------------------- */

async function doFetch(fromTs, toTs) {
  if (state.busy) return;
  setBusy(true);
  hideMsg('#syncMsg');
  $('#progress').classList.remove('hidden');
  $('#progressBar').style.width = '0%';
  $('#progressText').textContent = 'starting…';

  try {
    const covered = await metaGet('covered', []);
    const gaps = missingParts([fromTs, toTs], covered);
    if (!gaps.length) {
      showMsg('#syncMsg', 'Already have that range cached — nothing to download.', 'ok');
      $('#progress').classList.add('hidden');
      setBusy(false);
      return;
    }

    let total = 0;
    for (const [gFrom, gTo] of gaps) {
      total += await fetchRange(gFrom, gTo, (done, fetched, pages) => {
        $('#progressBar').style.width = `${Math.round(done * 100)}%`;
        $('#progressText').textContent = `${fetched.toLocaleString()} events · ${pages} call${pages === 1 ? '' : 's'}`;
      });
    }
    $('#progressBar').style.width = '100%';
    showMsg('#syncMsg', `Done. ${total.toLocaleString()} events downloaded.`, 'ok');
    await refresh();
  } catch (err) {
    showMsg('#syncMsg', err.message, 'bad');
  } finally {
    setBusy(false);
    setTimeout(() => $('#progress').classList.add('hidden'), 1200);
  }
}

async function validateKey(k) {
  apiKey = k;
  const info = await apiGet('/key/', { selections: 'info' });
  return info;
}

function describeAccess(info) {
  const lvl = info.access_type || info.access_level || 'unknown';
  return String(lvl);
}

// Pre-login the disclaimers are unmissable. Once someone is in and using the
// tool they have already read them, so they collapse to a footer link.
function enterDashboard() {
  $('#setup').classList.add('hidden');
  $('#dash').classList.remove('hidden');
  $('#btnForget').classList.remove('hidden');
  $('#disclaimer').classList.add('hidden');
  $('#btnDisclaimer').classList.remove('hidden');
  $('#footDot1').classList.remove('hidden');
}

function leaveDashboard() {
  $('#dash').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#btnForget').classList.add('hidden');
  $('#disclaimer').classList.remove('hidden');
  $('#btnDisclaimer').classList.add('hidden');
  $('#footDot1').classList.add('hidden');
}

/* --------------------------------------------------------------------------
   EXPORT
   -------------------------------------------------------------------------- */

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  // Exports everything loaded, not the current filter — a data export should
  // be the whole dataset. `weekday` is included so it can be filtered in a
  // spreadsheet without recomputing it.
  const head = ['date_tct', 'weekday_tct', 'timestamp', 'opening_bet', 'wagered',
    'returned', 'net', 'outcomes', 'split', 'doubled', 'insurance_win'];
  const lines = [head.join(',')];
  for (const d of state.deals) {
    if (!d.complete) continue;
    lines.push([
      dayKey(d.ts, false), DOW_NAMES[dowOf(d.ts, false)], d.ts, d.openingBet,
      d.moneyOut, d.moneyIn, d.net,
      `"${d.outcomes.join(' ')}"`, d.splits > 0 ? 1 : 0, d.doubled ? 1 : 0,
      d.insuranceWin ? 1 : 0
    ].join(','));
  }
  download(`blackjack-${dayKey(nowTs(), false)}.csv`, lines.join('\n'), 'text/csv');
}

async function exportBackup() {
  const payload = {
    tool: 'torn-blackjack-tracker',
    version: VERSION,
    exported: new Date().toISOString(),
    covered: await metaGet('covered', []),
    events: await allEvents()
  };
  download(`blackjack-backup-${dayKey(nowTs(), false)}.json`,
    JSON.stringify(payload), 'application/json');
}

async function importBackup(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
  if (data.tool !== 'torn-blackjack-tracker' || !Array.isArray(data.events)) {
    throw new Error('That does not look like a backup from this tool.');
  }
  await putEvents(data.events);
  if (Array.isArray(data.covered)) {
    const merged = mergeRanges((await metaGet('covered', [])).concat(data.covered));
    await metaSet('covered', merged);
  }
  return data.events.length;
}

/* --------------------------------------------------------------------------
   WIRING
   -------------------------------------------------------------------------- */

function keyCreationUrl() {
  // Torn's custom-key link. The odd '#tab=api?step=...' ordering is Torn's,
  // not a typo. NOTE: this creates a key immediately, with no confirmation
  // step — which is why the warning above it is as blunt as it is.
  const title = encodeURIComponent('Blackjack Tracker');
  return `https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=${title}&user=log`;
}

function init() {
  $('#version').textContent = `Blackjack Tracker v${VERSION}`;
  $('#btnCreateKey').href = keyCreationUrl();
  setRate('idle', false);

  applyTheme(currentTheme());
  $('#btnTheme').addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
    applyTheme(next);
    renderChart();   // the chart bakes theme colours into its markup
  });

  // Key entry
  $('#btnReveal').addEventListener('click', () => {
    const el = $('#keyInput');
    const on = el.classList.toggle('revealed');
    $('#btnReveal').textContent = on ? 'Hide' : 'Show';
  });

  $('#btnSave').addEventListener('click', async () => {
    const k = $('#keyInput').value.trim();
    if (!k) { showMsg('#keyMsg', 'Paste a key first.', 'bad'); return; }
    $('#btnSave').disabled = true;
    showMsg('#keyMsg', 'Checking the key…');
    try {
      const info = await validateKey(k);
      if ($('#chkRemember').checked) storeKey(k); else clearStoredKey();
      showMsg('#keyMsg', `Key accepted (${describeAccess(info)}).`, 'ok');
      enterDashboard();
      await refresh();
    } catch (err) {
      apiKey = null;
      showMsg('#keyMsg', err.message, 'bad');
    } finally {
      $('#btnSave').disabled = false;
    }
  });

  $('#btnForget').addEventListener('click', () => {
    clearStoredKey();
    apiKey = null;
    $('#keyInput').value = '';
    leaveDashboard();
    showMsg('#keyMsg', 'Key forgotten. Your cached history is still here.', 'ok');
  });

  $('#btnDisclaimer').addEventListener('click', () => {
    const el = $('#disclaimer');
    const wasHidden = el.classList.contains('hidden');
    el.classList.toggle('hidden');
    if (wasHidden) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // History fetching
  $$('#loadRow .btn').forEach((b) => {
    b.addEventListener('click', () => {
      const days = Number(b.dataset.days);
      const to = nowTs();
      doFetch(to - days * DAY, to);
    });
  });

  $('#btnCustom').addEventListener('click', () => {
    const f = $('#customFrom').value, t = $('#customTo').value;
    if (!f || !t) { showMsg('#syncMsg', 'Pick both dates.', 'bad'); return; }
    const from = Math.floor(Date.parse(f + 'T00:00:00Z') / 1000);
    const to = Math.min(nowTs(), Math.floor(Date.parse(t + 'T23:59:59Z') / 1000));
    if (!(from < to)) { showMsg('#syncMsg', 'The "from" date must come first.', 'bad'); return; }
    doFetch(from, to);
  });

  // Range + timezone
  $$('#rangePick button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#rangePick button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.range = b.dataset.range;
      renderStats();
    });
  });

  $$('#dowPick button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.dow === 'all') {
        state.dow = new Set(ALL_DOW);
      } else {
        const d = Number(b.dataset.dow);
        // "All" really means "no filter", so the first click picks a day
        // rather than removing one -- clicking Mon should show Mondays, not
        // hide them. After that the chips behave as ordinary toggles.
        if (state.dow.size === 7) state.dow = new Set([d]);
        else if (state.dow.has(d)) state.dow.delete(d);
        else state.dow.add(d);
      }
      renderDowChips();
      renderStats(); renderChart(); renderDays();
    });
  });
  renderDowChips();

  $('#chkLocal').addEventListener('change', (e) => {
    state.useLocal = e.target.checked;
    renderStats(); renderChart(); renderDays();
  });

  // Data
  $('#btnCsv').addEventListener('click', exportCsv);
  $('#btnBackup').addEventListener('click', exportBackup);
  $('#btnRestore').addEventListener('click', () => $('#restoreFile').click());
  $('#restoreFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const n = await importBackup(f);
      showMsg('#syncMsg', `Restored ${n.toLocaleString()} events.`, 'ok');
      await refresh();
    } catch (err) {
      showMsg('#syncMsg', err.message, 'bad');
    }
    e.target.value = '';
  });

  $('#btnWipe').addEventListener('click', async () => {
    if (!confirm('Delete all cached history from this browser? Your API key is kept.')) return;
    await wipeAll();
    await refresh();
    showMsg('#syncMsg', 'Cached history deleted.', 'ok');
  });

  // Resume a stored key
  const stored = loadStoredKey();
  if (stored) {
    apiKey = stored;
    $('#keyInput').value = stored;
    enterDashboard();
    refresh();
  }
}

document.addEventListener('DOMContentLoaded', init);

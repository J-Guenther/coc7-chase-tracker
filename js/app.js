'use strict';

const KEY = 'coc-chase-v1';
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

let S = load() || fresh();
let undoStack = [];
// Transient UI state (not saved, not undoable)
let ui = { sheet: null, placing: null, skill: {}, roll: null, breakDmg: '', sdiff: 'R' };

function fresh() {
  return {
    phase: 'setup', setting: 'foot-city', env: 'normal', range: 2,
    ps: [], minMov: 0, round: 1, cur: null,
    gaps: {}, upTo: 0, sudden: null, pending: null, seq: 1,
  };
}
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage unavailable */ }
}
function commit(fn) {
  undoStack.push(JSON.stringify(S));
  if (undoStack.length > 80) undoStack.shift();
  fn();
  save();
  render();
}
function undo() {
  if (!undoStack.length) return toast('Nothing to undo');
  S = JSON.parse(undoStack.pop());
  ui.sheet = null; ui.placing = null; ui.roll = null;
  save(); render(); toast('Undone');
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byId = id => S.ps.find(p => p.id === +id);
const setting = () => SETTINGS[S.setting];
const eff = p => p.mov + (p.speed === 'extreme' ? 1 : p.speed === 'fail' ? -1 : 0);
const base = p => Math.max(1, 1 + eff(p) - S.minMov);
const order = () => S.ps.filter(p => p.status === 'active').sort((a, b) => b.dex - a.dex);
const impaired = p => p.vehicle && p.buildMax && p.build !== null && p.build <= Math.floor(p.buildMax / 2);

// ---------- dice ----------
const d = n => 1 + Math.floor(Math.random() * n);
function roll(expr) { // "1D3", "1D3-1", "1D3+1D4", "5D10"
  let t = 0;
  for (const term of expr.replace(/-/g, '+-').split('+').filter(Boolean)) {
    const m = /^(-?)(\d+)D(\d+)$/i.exec(term);
    if (m) {
      let s = 0;
      for (let i = 0; i < +m[2]; i++) s += d(+m[3]);
      t += m[1] ? -s : s;
    } else t += parseInt(term, 10) || 0;
  }
  return Math.max(0, t);
}
// net > 0: bonus dice, net < 0: penalty dice
function d100(net = 0) {
  const u = d(10) - 1;
  let best = null;
  for (let i = 0; i <= Math.abs(net); i++) {
    let v = (d(10) - 1) * 10 + u;
    if (v === 0) v = 100;
    if (best === null || (net > 0 ? v < best : v > best)) best = v;
  }
  return best;
}
const LEVELS = ['Fumble', 'Failure', 'Regular success', 'Hard success', 'Extreme success', 'Critical'];
function level(r, skill) {
  if (r === 1) return 5;
  if (r === 100 || (skill < 50 && r >= 96)) return 0;
  if (r <= Math.floor(skill / 5)) return 4;
  if (r <= Math.floor(skill / 2)) return 3;
  if (r <= skill) return 2;
  return 1;
}
const NEED = { R: 2, H: 3, E: 4 };

// ---------- track ----------
const envNet = () => (S.env === 'calm' ? 1 : S.env === 'hazardous' ? -1 : 0);
function makeHazard(diff) {
  const pool = setting().items.flatMap(it => (it[0] === 'h' ? [it, it, it] : [it]));
  const [t, n, s, hp] = pool[Math.floor(Math.random() * pool.length)];
  return { t, n, s, d: diff, hp: t === 'b' ? (hp ?? null) : null };
}
function randomGap() {
  const r = d100(envNet());
  if (r < 60) return null;
  return makeHazard(r >= 96 ? 'E' : r >= 85 ? 'H' : 'R');
}
function ensureTrack() {
  const ps = S.ps.filter(p => p.status === 'active');
  if (!ps.length) return;
  const target = Math.max(...ps.map(p => p.pos)) + setting().look;
  for (let i = S.upTo + 1; i <= target; i++) S.gaps[i] = randomGap();
  S.upTo = Math.max(S.upTo, target);
}

// ---------- participants ----------
function newP(side, pr = {}) {
  const n = pr.name || (side === 'pursuer' ? 'Pursuer' : 'Investigator');
  const count = S.ps.filter(p => p.name.replace(/ \d+$/, '') === n).length;
  const vehicle = pr.name ? !!pr.vehicle : setting().mode === 'vehicle';
  return {
    id: S.seq++, name: count ? `${n} ${count + 1}` : n, side,
    mov: pr.mov ?? (vehicle ? 14 : 8), dex: pr.dex ?? 50, speed: 'success', vehicle,
    hp: null, build: pr.build ?? null, buildMax: pr.build ?? null,
    pos: 0, actions: 0, status: 'active',
  };
}

// ---------- chase flow ----------
function startSummary() {
  const f = S.ps.filter(p => p.side === 'fleeing');
  const pu = S.ps.filter(p => p.side === 'pursuer');
  if (!f.length || !pu.length) return toast('Add at least one fleeing character and one pursuer');
  const fastP = Math.max(...pu.map(eff));
  const slowF = Math.min(...f.map(eff));
  ui.sheet = {
    type: 'start',
    escapes: f.filter(p => eff(p) > fastP).map(p => p.id),
    behind: pu.filter(p => eff(p) < slowF).map(p => p.id),
    stay: {},
  };
  render();
}
function startChase() {
  const sh = ui.sheet;
  ui.sheet = null;
  commit(() => {
    S.ps.forEach(p => {
      p.status = 'active';
      if (sh.escapes.includes(p.id) && !sh.stay[p.id]) p.status = 'escaped';
      if (sh.behind.includes(p.id)) p.status = 'out';
    });
    const act = S.ps.filter(p => p.status === 'active');
    const pu = act.filter(p => p.side === 'pursuer');
    const f = act.filter(p => p.side === 'fleeing');
    // Pursuers: slowest at the back, others ahead by MOV difference
    const slowP = Math.min(...pu.map(eff));
    pu.forEach(p => { p.pos = eff(p) - slowP; });
    // Fleeing: slowest is `range` ahead of the foremost pursuer, others ahead by MOV difference
    const front = Math.max(...pu.map(p => p.pos));
    const slowF = Math.min(...f.map(eff));
    f.forEach(p => { p.pos = front + S.range + eff(p) - slowF; });
    S.minMov = Math.min(...act.map(eff));
    act.forEach(p => { p.actions = base(p); });
    Object.assign(S, { round: 1, gaps: {}, upTo: 0, sudden: null, pending: null, phase: 'chase' });
    ensureTrack();
    S.cur = order()[0].id;
  });
}
function nextTurn() {
  const o = order();
  if (!o.length) return;
  const i = o.findIndex(p => p.id === S.cur);
  commit(() => {
    if (i < 0) {
      S.cur = o[0].id;
    } else if (i < o.length - 1) {
      S.cur = o[i + 1].id;
    } else {
      S.round++;
      // Unused actions are lost; owed actions (negative) carry over
      o.forEach(p => { p.actions = base(p) + Math.min(0, p.actions); });
      S.cur = o[0].id;
      toast(`Round ${S.round}`);
    }
  });
}

// Movement: pay 1 action, then walk `steps` locations, stopping at each hazard/barrier.
function startMove(id, steps) {
  commit(() => {
    const p = byId(id);
    p.actions -= 1;
    S.pending = { id: p.id, steps, pen: steps >= 4 ? 2 : steps >= 2 ? 1 : 0, cautious: 0, phase: 'ask', gap: null };
    ui.roll = null;
    advance();
  });
}
function advance() {
  const pe = S.pending;
  const p = byId(pe.id);
  while (pe.steps > 0) {
    ensureTrack();
    if (S.gaps[p.pos + 1]) {
      Object.assign(pe, { phase: 'ask', gap: p.pos + 1 });
      ui.roll = null;
      return;
    }
    p.pos++;
    pe.steps--;
  }
  S.pending = null;
  ensureTrack();
}
function passHazard() {
  commit(() => {
    const pe = S.pending, p = byId(pe.id);
    p.actions -= pe.cautious;
    pe.cautious = 0;
    p.pos++;
    pe.steps--;
    advance();
  });
}
function failHazard() {
  commit(() => {
    const pe = S.pending, p = byId(pe.id), g = S.gaps[pe.gap];
    const expr = DMG[p.vehicle ? 'vehicle' : 'foot'][g.d];
    Object.assign(pe, { phase: 'fail', lost: roll('1D3'), dmgExpr: expr, dmg: roll(expr) });
  });
}
function applyFail(mode) {
  commit(() => {
    const pe = S.pending, p = byId(pe.id), g = S.gaps[pe.gap];
    p.actions -= pe.cautious;
    if (g.t === 'h') p.pos++; // hazards: move on even when failed; barriers: stay put
    const msg = [];
    if (mode !== 'none') { p.actions -= pe.lost; msg.push(`−${pe.lost} action${pe.lost === 1 ? '' : 's'}`); }
    if (mode === 'both' && pe.dmg) {
      if (p.vehicle) {
        if (p.build !== null) p.build = Math.max(0, p.build - pe.dmg);
        msg.push(`−${pe.dmg} build (occupants roll ${pe.dmgExpr} HP)`);
      } else {
        if (p.hp !== null) p.hp = Math.max(0, p.hp - pe.dmg);
        msg.push(`−${pe.dmg} HP`);
      }
    }
    S.pending = null;
    ensureTrack();
    toast(`${p.name}: ${msg.join(', ') || (g.t === 'b' ? 'blocked' : 'no penalty')}`);
  });
}
function applyBreak() {
  const v = parseInt(ui.breakDmg, 10);
  if (!(v >= 0)) return toast('Enter damage');
  commit(() => {
    const pe = S.pending, p = byId(pe.id), g = S.gaps[pe.gap];
    const prior = g.hp;
    g.hp = Math.max(0, g.hp - v);
    p.actions -= pe.cautious;
    pe.cautious = 0;
    if (g.hp <= 0) {
      S.gaps[pe.gap] = { t: 'h', n: `Wreckage of ${g.n.toLowerCase()}`, s: 'DEX / Dodge / Drive Auto', d: 'R', hp: null };
      let msg = `${g.n} destroyed!`;
      if (p.vehicle) {
        const vd = Math.floor(prior / 2);
        if (p.build !== null) p.build = Math.max(0, p.build - Math.floor(vd / 10));
        msg += ` Vehicle takes ${vd} dmg (−${Math.floor(vd / 10)} build).`;
      }
      toast(msg);
      p.pos++;
      pe.steps--;
      advance();
    } else {
      S.pending = null;
      toast(p.vehicle ? `${g.n} holds (${g.hp} HP left). Vehicle is WRECKED!` : `${g.n} holds — ${g.hp} HP left`);
    }
  });
  ui.breakDmg = '';
}

// ---------- rendering ----------
let lastPhase = S.phase;
function render() {
  if (S.phase !== lastPhase) { lastPhase = S.phase; window.scrollTo(0, 0); }
  app.innerHTML = S.phase === 'setup' ? renderSetup() : renderChase();
  app.insertAdjacentHTML('beforeend', renderSheet());
  if (S.phase === 'chase') centerTrack();
}

const SPEED = [['fail', '✗ −1'], ['success', '✓'], ['extreme', '★ +1']];
function seg(action, options, current, extra = '') {
  return `<div class="seg">${options.map(([v, l]) =>
    `<button data-a="${action}" data-v="${v}" ${extra} class="${v === current ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function renderSetup() {
  const tiles = Object.entries(SETTINGS).map(([k, s]) =>
    `<button data-a="setting" data-v="${k}" class="tile ${k === S.setting ? 'on' : ''}"><span>${s.icon}</span>${esc(s.name)}</button>`).join('');
  const side = (sd, title) => {
    const ps = S.ps.filter(p => p.side === sd);
    return `<section class="card">
      <h2 class="${sd}">${title} <small>${ps.length || ''}</small></h2>
      ${ps.map(prow).join('') || '<p class="hint">Nobody yet — add below.</p>'}
      <div class="chips">
        <button data-a="add" data-side="${sd}" data-pr="-1" class="chip add">＋ Blank</button>
        ${PRESETS.map((pr, i) => `<button data-a="add" data-side="${sd}" data-pr="${i}" class="chip">${pr.vehicle ? '🚗 ' : ''}${esc(pr.name)}</button>`).join('')}
      </div>
    </section>`;
  };
  return `
  <header class="bar">
    <h1>Chase setup</h1>
    <button data-a="rules" class="icon" aria-label="Rules">📖</button>
    <button data-a="reset" class="icon" aria-label="New chase">🗑</button>
  </header>
  <main>
    <section class="card">
      <h2>Terrain</h2>
      <div class="tiles">${tiles}</div>
      <h3>Environment</h3>
      ${seg('env', Object.entries(ENV), S.env)}
      <p class="hint">Calm = bonus die, hazardous = penalty die on random hazard rolls.</p>
    </section>
    ${side('fleeing', 'Fleeing')}
    ${side('pursuer', 'Pursuers')}
    <section class="card">
      <h2>Starting gap</h2>
      ${seg('range', [['1', '1 location (tense)'], ['2', '2 locations']], String(S.range))}
    </section>
    <p class="hint center">Speed roll: CON on foot · Drive Auto in vehicles.<br>Extreme success +1 MOV · Failure −1 MOV.</p>
  </main>
  <footer class="foot"><button data-a="start" class="primary big">Cut to the chase ▶</button></footer>`;
}

function prow(p) {
  return `<div class="prow ${p.side}">
    <div class="r1">
      <input class="name" data-f="name" data-id="${p.id}" value="${esc(p.name)}" aria-label="Name">
      <button data-a="veh" data-id="${p.id}" class="mini ${p.vehicle ? 'on' : ''}" aria-label="Vehicle">🚗</button>
      <button data-a="del" data-id="${p.id}" class="mini" aria-label="Remove">✕</button>
    </div>
    <div class="r2">
      <label>MOV<input type="number" inputmode="numeric" data-f="mov" data-t="num" data-id="${p.id}" value="${p.mov}"></label>
      <label>DEX<input type="number" inputmode="numeric" data-f="dex" data-t="num" data-id="${p.id}" value="${p.dex}"></label>
      ${seg('speed', SPEED, p.speed, `data-id="${p.id}"`)}
    </div>
  </div>`;
}

function pips(p) {
  const b = base(p), a = p.actions;
  if (a < 0) return `<span class="owe">owes ${-a}</span>`;
  return `<span class="pip">${'●'.repeat(Math.min(a, b))}${'○'.repeat(Math.max(0, b - a))}${a > b ? '+' + (a - b) : ''}</span>`;
}
function distance(p) {
  const enemies = order().filter(q => q.side !== p.side);
  if (p.side === 'fleeing') {
    const behind = enemies.filter(q => q.pos <= p.pos);
    if (!behind.length) return '';
    const dd = p.pos - Math.max(...behind.map(q => q.pos));
    return dd === 0 ? '⚔ caught up' : `lead ${dd}`;
  }
  const ahead = enemies.filter(q => q.pos >= p.pos);
  if (!ahead.length) return '';
  const dd = Math.min(...ahead.map(q => q.pos)) - p.pos;
  return dd === 0 ? '⚔ on target' : `${dd} behind`;
}
const gapIcon = g => (g.t === 'b' ? '⛔' : '⚠');
const diffChip = dd => `<span class="diff ${dd}">${DIFF[dd]}</span>`;

function renderChase() {
  const o = order();
  const cur = byId(S.cur);
  const last = o.length && o[o.length - 1].id === S.cur;
  const nextP = o[o.findIndex(p => p.id === S.cur) + 1];
  const suddenNext = S.sudden === 'keeper' ? 'Players' : S.sudden === 'players' ? 'Keeper' : 'Either';
  const removed = S.ps.filter(p => p.status !== 'active');
  return `
  <header class="bar">
    <div class="round">Round <b>${S.round}</b></div>
    <button data-a="sudden" class="chip sudden">⚡ Sudden <small>${suddenNext}</small></button>
    <button data-a="undo" class="icon" aria-label="Undo" ${undoStack.length ? '' : 'disabled'}>↶</button>
    <button data-a="menu" class="icon" aria-label="Menu">☰</button>
  </header>
  ${ui.placing ? `<div class="banner">
      <div>${gapIcon(ui.placing.h)} <b>${esc(ui.placing.h.n)}</b> ${diffChip(ui.placing.h.d)}<br><small>Tap a gap on the track to place it</small></div>
      <button data-a="placeReroll" class="mini">🎲</button><button data-a="placeCancel" class="mini">✕</button>
    </div>` : ''}
  ${renderTrack()}
  <button data-a="menu" class="terrain">${setting().icon} ${esc(setting().name)} · ${ENV[S.env]}</button>
  <main>
    ${cur && cur.status === 'active' ? actorCard(cur) : '<p class="hint center">Nobody is active. Use ☰ to add participants or go back to setup.</p>'}
    <section class="card">
      <h2>Turn order <small>DEX</small></h2>
      ${o.map(p => orow(p)).join('')}
      ${removed.length ? `<h3>Out of the chase</h3>${removed.map(p => orow(p)).join('')}` : ''}
    </section>
  </main>
  <footer class="foot">
    <button data-a="next" class="primary big">${last || !nextP ? `Start round ${S.round + 1} ⟳` : `Next: ${esc(nextP.name)} ▶`}</button>
  </footer>`;
}

function renderTrack() {
  const act = S.ps.filter(p => p.status === 'active');
  if (!act.length) return '<div class="track"></div>';
  const lo = Math.max(0, Math.min(...act.map(p => p.pos)) - 1);
  const shown = S.ps.filter(p => p.status === 'active' || p.status === 'caught');
  let h = '';
  for (let i = lo; i <= S.upTo; i++) {
    if (i > lo) {
      const g = S.gaps[i];
      h += g
        ? `<button data-a="gap" data-i="${i}" class="gap ${g.t} ${g.d} ${ui.placing ? 'placing' : ''}" title="${esc(g.n)}">${gapIcon(g)}<small>${g.d}</small></button>`
        : `<button data-a="gap" data-i="${i}" class="gap clear ${ui.placing ? 'placing' : ''}" aria-label="Clear gap"></button>`;
    }
    const here = shown.filter(p => p.pos === i);
    const clash = here.some(p => p.side === 'fleeing') && here.some(p => p.side === 'pursuer');
    h += `<div class="loc ${clash ? 'clash' : ''}" ${here.some(p => p.id === S.cur) ? 'id="curloc"' : ''}>
      <span class="num">${clash ? '⚔ ' : ''}${i}</span>
      ${here.map(p => `<button data-a="edit" data-id="${p.id}" class="tok ${p.side} ${p.id === S.cur ? 'cur' : ''} ${p.status}">${esc(p.name)}</button>`).join('')}
    </div>`;
  }
  return `<div class="track" id="track">${h}</div>`;
}
function centerTrack() {
  const t = document.getElementById('track'), c = document.getElementById('curloc');
  if (t && c) t.scrollLeft = c.offsetLeft - t.clientWidth / 2 + c.clientWidth / 2;
}

function actorCard(p) {
  const look = setting().look;
  const ahead = [];
  for (let i = p.pos + 1; i <= p.pos + look; i++) {
    const g = S.gaps[i];
    ahead.push(g
      ? `<button data-a="gap" data-i="${i}" class="ah ${g.t}">${gapIcon(g)} ${esc(g.n)} ${diffChip(g.d)}<small>${esc(g.s)}${g.t === 'b' && g.hp !== null ? ` · ${g.hp} HP` : ''}</small></button>`
      : `<div class="ah clear">· clear</div>`);
  }
  const accel = p.vehicle ? `<div class="accel"><span>Pedal to the metal</span>
      ${[2, 3, 4, 5].map(n => `<button data-a="move" data-n="${n}" data-id="${p.id}" ${p.actions < 1 ? 'disabled' : ''}>${n}${n >= 4 ? '<small>−2</small>' : '<small>−1</small>'}</button>`).join('')}
    </div>` : '';
  const stat = (f, label) => (p[f] === null ? '' :
    `<div class="stat"><span>${label}</span><button data-a="stat" data-f="${f}" data-n="-1" data-id="${p.id}" class="mini">−</button><b>${p[f]}</b><button data-a="stat" data-f="${f}" data-n="1" data-id="${p.id}" class="mini">＋</button></div>`);
  return `<section class="card actor ${p.side}">
    <div class="ahd">
      <button data-a="edit" data-id="${p.id}" class="aname">${esc(p.name)} <small>✎</small></button>
      <span class="meta">${p.side === 'fleeing' ? 'Fleeing' : 'Pursuer'} · MOV ${eff(p)} · DEX ${p.dex}${impaired(p) ? ' · <b class="warn">impaired</b>' : ''}</span>
    </div>
    <div class="acts">${pips(p)} <span>${p.actions < 0 ? 'next round' : `${p.actions} / ${base(p)} actions`}</span> <span class="dist">${distance(p)}</span></div>
    ${stat('hp', 'HP')}${stat('build', 'Build')}
    <div class="ahead"><span class="lbl">Ahead</span>${ahead.join('')}</div>
    <button data-a="move" data-n="1" data-id="${p.id}" class="primary big" ${p.actions < 1 ? 'disabled' : ''}>▶ Move 1 location</button>
    ${accel}
    <div class="grid3">
      <button data-a="spend" data-id="${p.id}" ${p.actions < 1 ? 'disabled' : ''}>⚔ Attack / act<small>−1 action</small></button>
      <button data-a="back" data-id="${p.id}" ${p.actions < 1 ? 'disabled' : ''}>◀ Back<small>−1 action</small></button>
      <button data-a="delay" data-id="${p.id}">🌀 Delayed<small>−1D3 actions</small></button>
    </div>
    <div class="grid3">
      <button data-a="adj" data-n="-1" data-id="${p.id}">−1 action</button>
      <button data-a="adj" data-n="1" data-id="${p.id}">+1 action</button>
      <button data-a="edit" data-id="${p.id}">⋯ More</button>
    </div>
  </section>`;
}

function orow(p) {
  const st = { escaped: 'Escaped', caught: 'Caught', out: 'Out' }[p.status];
  return `<button data-a="${p.status === 'active' ? 'pick' : 'edit'}" data-id="${p.id}" class="orow ${p.side} ${p.id === S.cur ? 'cur' : ''} ${st ? 'gone' : ''}">
    <span class="dex">${p.dex}</span>
    <span class="nm">${esc(p.name)}<small>${st || `loc ${p.pos} · ${distance(p)}`}</small></span>
    ${st ? '' : pips(p)}
  </button>`;
}

// ---------- sheets ----------
function sheet(content, closable = true) {
  return `<div class="backdrop" data-a="${closable ? 'close' : 'noop'}"><div class="sheet" data-a="noop">${content}</div></div>`;
}
function renderSheet() {
  if (S.pending && S.phase === 'chase') return sheet(hazardSheet(), false);
  const sh = ui.sheet;
  if (!sh) return '';
  if (sh.type === 'start') return sheet(startSheet(sh));
  if (sh.type === 'edit') return sheet(editSheet(byId(sh.id)));
  if (sh.type === 'gap') return sheet(gapSheet(sh.i));
  if (sh.type === 'menu') return sheet(menuSheet());
  if (sh.type === 'sudden') return sheet(suddenSheet());
  if (sh.type === 'rules') return sheet(RULES);
  return '';
}

function startSheet(sh) {
  const name = id => esc(byId(id).name);
  const remainingF = S.ps.filter(p => p.side === 'fleeing' && (!sh.escapes.includes(p.id) || sh.stay[p.id]));
  const remainingP = S.ps.filter(p => p.side === 'pursuer' && !sh.behind.includes(p.id));
  const ok = remainingF.length && remainingP.length;
  return `<h2>Speed check</h2>
    <div class="speeds">${S.ps.map(p => `<span class="${p.side}">${esc(p.name)} <b>${eff(p)}</b></span>`).join('')}</div>
    ${sh.escapes.length ? `<h3>Escapes (faster than every pursuer)</h3>
      ${sh.escapes.map(id => `<label class="check"><input type="checkbox" data-a="stay" data-id="${id}" ${sh.stay[id] ? 'checked' : ''}> ${name(id)} <small>stays to help</small></label>`).join('')}` : ''}
    ${sh.behind.length ? `<h3>Left behind (slower than every quarry)</h3><p>${sh.behind.map(name).join(', ')}</p>` : ''}
    ${ok ? `<button data-a="go" class="primary big">Cut to the chase ▶</button>`
      : `<p class="big-msg">No chase — ${remainingF.length ? 'pursuers fall behind' : 'the quarry gets away'}.</p><button data-a="close" class="big">Back</button>`}`;
}

function editSheet(p) {
  if (!p) return '';
  const num = (f, label) => `<label>${label}<input type="number" inputmode="numeric" data-f="${f}" data-t="num" data-id="${p.id}" value="${p[f] ?? ''}" placeholder="–"></label>`;
  const step = (f, label) => `<div class="stat"><span>${label}</span><button data-a="stat" data-f="${f}" data-n="-1" data-id="${p.id}" class="mini">−</button><b>${p[f]}</b><button data-a="stat" data-f="${f}" data-n="1" data-id="${p.id}" class="mini">＋</button></div>`;
  return `<h2>Edit</h2>
    <input class="name wide" data-f="name" data-id="${p.id}" value="${esc(p.name)}">
    ${seg('side', [['fleeing', 'Fleeing'], ['pursuer', 'Pursuer']], p.side, `data-id="${p.id}"`)}
    <div class="row">${num('mov', 'MOV')}${num('dex', 'DEX')}${num('hp', 'HP')}${num('build', 'Build')}</div>
    <h3>Speed roll</h3>
    ${seg('speed', SPEED, p.speed, `data-id="${p.id}"`)}
    <label class="check"><input type="checkbox" data-a="veh" data-id="${p.id}" ${p.vehicle ? 'checked' : ''}> Vehicle (can accelerate)</label>
    ${S.phase === 'chase' ? `${step('pos', 'Location')}${step('actions', 'Actions left')}
      <h3>Status</h3>
      ${seg('status', [['active', 'In chase'], ['escaped', 'Escaped'], ['caught', 'Caught'], ['out', 'Out']], p.status, `data-id="${p.id}"`)}
      <button data-a="setcur" data-id="${p.id}" class="big">Make it ${esc(p.name)}'s turn</button>` : ''}
    <div class="grid2">
      <button data-a="del" data-id="${p.id}" class="danger">Remove</button>
      <button data-a="close" class="primary">Done</button>
    </div>`;
}

function gapSheet(i) {
  const g = S.gaps[i];
  const items = setting().items.map((it, k) => `<option value="${k}">${it[0] === 'b' ? '⛔' : '⚠'} ${esc(it[1])}</option>`).join('');
  return `<h2>Between location ${i - 1} and ${i}</h2>
    ${g ? `<p class="big-msg">${gapIcon(g)} ${esc(g.n)} ${diffChip(g.d)}</p>` : '<p class="big-msg">Clear</p>'}
    <div class="grid2">
      <button data-a="gapRoll" data-i="${i}">🎲 Random roll</button>
      <button data-a="gapClear" data-i="${i}">Clear</button>
    </div>
    <h3>Pick from ${esc(setting().name)}</h3>
    <select data-a2="gapPick" data-i="${i}"><option value="">Choose…</option>${items}</select>
    ${g ? `
      ${seg('gapType', [['h', '⚠ Hazard'], ['b', '⛔ Barrier']], g.t, `data-i="${i}"`)}
      ${seg('gapDiff', Object.entries(DIFF), g.d, `data-i="${i}"`)}
      <label class="full">Name<input data-g="n" data-i="${i}" value="${esc(g.n)}"></label>
      <label class="full">Skills<input data-g="s" data-i="${i}" value="${esc(g.s)}"></label>
      ${g.t === 'b' ? `<label class="full">Barrier HP (empty = can't be broken)<input type="number" inputmode="numeric" data-g="hp" data-i="${i}" value="${g.hp ?? ''}"></label>` : ''}` : ''}
    <button data-a="close" class="primary big">Done</button>`;
}

function hazardSheet() {
  const pe = S.pending, p = byId(pe.id), g = S.gaps[pe.gap];
  if (!p || !g) { S.pending = null; return ''; }
  const head = `<h2>${gapIcon(g)} ${esc(g.n)}</h2>
    <p>${diffChip(g.d)} <b>${g.t === 'b' ? 'Barrier' : 'Hazard'}</b>${g.t === 'b' && g.hp !== null ? ` · ${g.hp} HP` : ''} — <b>${esc(p.name)}</b></p>
    <p class="skills">${esc(g.s)}</p>`;
  if (pe.phase === 'fail') {
    return `${head}
      <p class="big-msg bad">${g.t === 'b' ? 'Blocked — stays put.' : 'Gets through, but badly.'}</p>
      <div class="stat"><span>Delay (1D3)</span><button data-a="lost" data-n="-1" class="mini">−</button><b>${pe.lost}</b><button data-a="lost" data-n="1" class="mini">＋</button><span>actions</span></div>
      <p>Damage ${pe.dmgExpr}${p.vehicle ? ' build' : ''}: <b>${pe.dmg}</b> <button data-a="reroll" class="mini">🎲</button>${p.vehicle ? `<br><small>Each occupant also takes ${pe.dmgExpr} HP.</small>` : ''}</p>
      <div class="grid3">
        <button data-a="applyFail" data-v="both" class="${g.t === 'h' ? 'primary' : ''}">Delay + damage</button>
        <button data-a="applyFail" data-v="delay">Delay only</button>
        <button data-a="applyFail" data-v="none" class="${g.t === 'b' ? 'primary' : ''}">No penalty</button>
      </div>`;
  }
  if (pe.phase === 'break') {
    const quick = p.vehicle ? [`${p.build || 1}D10`] : ['1D3', '1D3+1D4', '1D6'];
    return `${head}
      <h3>Break through ${p.vehicle ? '(1D10 per build, no roll)' : '(no attack roll)'}</h3>
      <div class="chips">${quick.map(q => `<button data-a="breakRoll" data-v="${q}" class="chip">🎲 ${q}</button>`).join('')}</div>
      <label class="full">Damage dealt<input id="breakDmg" type="number" inputmode="numeric" data-u="breakDmg" value="${esc(ui.breakDmg)}"></label>
      ${p.vehicle ? '<p class="hint">If the barrier survives, the vehicle is wrecked. If destroyed, the vehicle takes half its prior HP.</p>' : ''}
      <div class="grid2"><button data-a="phase" data-v="ask">◀ Back</button><button data-a="applyBreak" class="primary">Apply</button></div>`;
  }
  const accelPen = pe.pen, impPen = impaired(p) ? 1 : 0;
  const net = pe.cautious - accelPen - impPen;
  const sk = ui.skill[p.id] ?? '';
  let rollLine = '';
  if (ui.roll) {
    const r = ui.roll;
    rollLine = r.skill
      ? `<p class="rollres ${r.lvl >= NEED[g.d] ? 'good' : 'bad'}"><b>${r.r}</b> ${LEVELS[r.lvl]} → ${r.lvl >= NEED[g.d] ? 'PASS' : 'FAIL'}</p>`
      : `<p class="rollres"><b>${r.r}</b></p>`;
  }
  return `${head}
    <div class="dice">
      ${accelPen ? `<span class="pen">${accelPen} penalty (speed)</span>` : ''}
      ${impPen ? '<span class="pen">1 penalty (impaired)</span>' : ''}
      <span>Net: <b>${net === 0 ? 'no bonus/penalty' : net > 0 ? `${net} bonus` : `${-net} penalty`}</b></span>
    </div>
    <div class="stat"><span>Cautious</span>${[0, 1, 2].map(n => `<button data-a="cautious" data-n="${n}" class="mini ${pe.cautious === n ? 'on' : ''}">${n}</button>`).join('')}<small>bonus dice, costs actions (${p.actions} left)</small></div>
    <div class="quickroll">
      <input type="number" inputmode="numeric" placeholder="skill %" data-u="skill" data-id="${p.id}" value="${esc(sk)}">
      <button data-a="d100">🎲 Roll d100</button>
    </div>
    ${rollLine}
    <div class="grid2">
      <button data-a="pass" class="good big">✓ Passed</button>
      <button data-a="fail" class="bad big">✗ Failed</button>
    </div>
    <div class="grid2">
      ${g.t === 'b' && g.hp !== null ? '<button data-a="phase" data-v="break">💥 Break through</button>' : '<span></span>'}
      <button data-a="stopMove">Stop here</button>
    </div>`;
}

function menuSheet() {
  const tiles = Object.entries(SETTINGS).map(([k, s]) =>
    `<button data-a="setting" data-v="${k}" class="tile ${k === S.setting ? 'on' : ''}"><span>${s.icon}</span>${esc(s.name)}</button>`).join('');
  return `<h2>Terrain ahead</h2>
    <p class="hint">Changes only affect locations not yet revealed.</p>
    <div class="tiles">${tiles}</div>
    ${seg('env', Object.entries(ENV), S.env)}
    <h3>Participants</h3>
    <div class="grid2">
      <button data-a="join" data-side="fleeing">＋ Fleeing</button>
      <button data-a="join" data-side="pursuer">＋ Pursuer</button>
    </div>
    <h3>Chase</h3>
    <button data-a="rules" class="big">📖 Rules quick reference</button>
    <div class="grid2">
      <button data-a="toSetup">◀ Back to setup</button>
      <button data-a="reset" class="danger">🗑 New chase</button>
    </div>`;
}

function suddenSheet() {
  return `<h2>⚡ Sudden hazard</h2>
    <p>Call for a <b>group Luck roll</b>. Passed: players say where it appears. Failed: the Keeper places it in the investigators' way.</p>
    <p class="hint">Keeper and players take turns calling. Raise difficulty if the chase drags on.</p>
    ${seg('sdiff', Object.entries(DIFF), ui.sdiff)}
    <div class="grid2">
      <button data-a="suddenGo" data-v="keeper" class="big" ${S.sudden === 'keeper' ? 'disabled' : ''}>Keeper calls</button>
      <button data-a="suddenGo" data-v="players" class="big" ${S.sudden === 'players' ? 'disabled' : ''}>Players call</button>
    </div>`;
}

const RULES = `<h2>Chase rules</h2>
<div class="rules">
<h3>Setup</h3>
<ul>
<li><b>Speed roll:</b> CON on foot, Drive Auto in vehicles. Extreme +1 MOV, Fail −1 MOV.</li>
<li>Fleeing faster than every pursuer escape. Pursuers slower than every quarry drop out.</li>
<li><b>Actions/round:</b> 1 + (own MOV − slowest MOV). Act in DEX order.</li>
<li>Joining: new speed roll. If slower than the slowest, everyone's actions are recalculated.</li>
</ul>
<h3>Moving</h3>
<ul>
<li>1 action = 1 location. Unused actions are lost; owed actions carry over.</li>
<li><b>Pedal to the metal</b> (vehicles): 1 action = 2–3 locations (1 penalty die on hazards) or 4–5 (2 penalty dice). Not for barriers. Can't be retracted.</li>
<li>Navigator passenger: Spot Hidden/Navigate success → next acceleration has 1 fewer penalty die.</li>
<li>No pushed rolls in a chase.</li>
</ul>
<h3>Hazards &amp; barriers</h3>
<ul>
<li><b>Cautious:</b> spend 1–2 actions for 1–2 bonus dice.</li>
<li><b>Hazard failed:</b> still move on, lose 1D3 actions, maybe damage.</li>
<li><b>Barrier failed:</b> stay put (usually no further penalty).</li>
<li><b>Breaking:</b> no roll. Vehicles deal 1D10 per build. A vehicle that fails to destroy a barrier is wrecked; if it succeeds, it takes half the barrier's prior HP.</li>
<li>Barrier HP: inner door/thin fence 5 · back door 10 · strong outer door 15 · brick wall 25 · tree 50 · bridge support 100.</li>
</ul>
<h3>Damage</h3>
<ul>
<li><b>People:</b> minor 1D3 · moderate 1D6 · severe 1D10 · deadly 2D10 · terminal 4D10.</li>
<li><b>Vehicles:</b> minor 1D3−1 build · moderate 1D6 · severe 1D10 / 2D10 · road kill 5D10. Occupants roll the same as HP. Usually 1D3 lost actions too.</li>
<li>Each full 10 HP of damage = −1 build. Build ≤ half: impaired (1 penalty die). Damage ≥ full build in one hit: wrecked.</li>
<li>Driver takes a major wound: Hard hazard roll to keep control.</li>
</ul>
<h3>Conflict</h3>
<ul>
<li>Attack = 1 action, same location (except firearms). Defender may always respond.</li>
<li><b>Fighting maneuver</b> success: target loses 1D3 actions (as a failed hazard). Vehicles: target 1 build bigger = 1 penalty die, 2 = 2, 3+ = impossible.</li>
<li>Vehicle as weapon: 1D10 per build, takes half the damage it deals.</li>
<li><b>Firearms:</b> stop and shoot = 1 action, no movement. Shoot on the move = +1 penalty die, free. Tires: +1 penalty die, armor 3, burst at 2 dmg (−1 build).</li>
</ul>
<h3>Other</h3>
<ul>
<li><b>Sudden hazard:</b> group Luck roll; Regular difficulty; Keeper and players alternate calling.</li>
<li><b>Hiding:</b> Stealth vs. pursuer's Spot Hidden. Vehicles: combined Stealth + Drive Auto.</li>
<li>Lost trail: Track roll for pursuers when the quarry is out of sight.</li>
<li>Swimming without MOV listed: half MOV.</li>
<li>Monsters without a skill: aptitude = DEX, neutral = ½ DEX, inept = ⅕ DEX.</li>
<li>Random terrain: 01–59 clear · 60+ Regular · 85+ Hard · 96+ Extreme.</li>
</ul>
</div>
<button data-a="close" class="primary big">Close</button>`;

// ---------- events ----------
const A = {
  close() {
    if (ui.sheet?.type === 'edit') {
      // A newly slow participant lowers the baseline for everyone (joining rules)
      const p = byId(ui.sheet.id);
      if (p && S.phase === 'chase' && p.status === 'active') S.minMov = Math.min(S.minMov, eff(p));
      if (p && p.fresh) { p.actions = base(p); delete p.fresh; }
      save();
    }
    ui.sheet = null; render();
  },
  noop() {},
  undo,
  rules() { ui.sheet = { type: 'rules' }; render(); },
  menu() { ui.sheet = { type: 'menu' }; render(); },
  reset() {
    if (!confirm('Start a new chase? All participants are removed.')) return;
    ui.sheet = null;
    commit(() => { S = fresh(); });
  },
  toSetup() {
    ui.sheet = null;
    commit(() => { S.phase = 'setup'; S.pending = null; });
  },
  setting(t) { commit(() => { S.setting = t.dataset.v; }); },
  env(t) { commit(() => { S.env = t.dataset.v; }); },
  range(t) { commit(() => { S.range = +t.dataset.v; }); },
  add(t) {
    commit(() => { S.ps.push(newP(t.dataset.side, PRESETS[+t.dataset.pr])); });
  },
  join(t) {
    commit(() => {
      const p = newP(t.dataset.side);
      const act = order();
      if (act.length) {
        const pos = act.filter(q => q.side === p.side).map(q => q.pos);
        p.pos = pos.length ? (p.side === 'pursuer' ? Math.min(...pos) : Math.max(...pos)) : 0;
      }
      p.fresh = true;
      S.ps.push(p);
      ui.sheet = { type: 'edit', id: p.id };
    });
  },
  del(t) {
    const p = byId(t.dataset.id);
    if (S.phase === 'chase' && !confirm(`Remove ${p.name}?`)) return;
    if (ui.sheet?.type === 'edit') ui.sheet = null;
    commit(() => {
      S.ps = S.ps.filter(q => q !== p);
      if (S.cur === p.id) S.cur = order()[0]?.id ?? null;
    });
  },
  veh(t) { commit(() => { const p = byId(t.dataset.id); p.vehicle = !p.vehicle; }); },
  speed(t) { commit(() => { byId(t.dataset.id).speed = t.dataset.v; }); },
  side(t) { commit(() => { byId(t.dataset.id).side = t.dataset.v; }); },
  status(t) {
    commit(() => {
      const p = byId(t.dataset.id);
      p.status = t.dataset.v;
      if (p.status !== 'active' && S.cur === p.id) {
        const o = order();
        S.cur = (o.find(q => q.dex <= p.dex) || o[0])?.id ?? null;
      }
      if (p.status === 'active' && S.cur === null) S.cur = p.id;
    });
  },
  stat(t) {
    commit(() => {
      const p = byId(t.dataset.id), f = t.dataset.f;
      p[f] = (p[f] ?? 0) + +t.dataset.n;
      if (f === 'pos') { p.pos = Math.max(0, p.pos); ensureTrack(); }
      if (f === 'hp' || f === 'build') p[f] = Math.max(0, p[f]);
    });
  },
  start: startSummary,
  stay(t) { ui.sheet.stay[+t.dataset.id] = t.checked; render(); },
  go: startChase,
  next: nextTurn,
  pick(t) { commit(() => { S.cur = +t.dataset.id; }); },
  setcur(t) { ui.sheet = null; A.pick(t); },
  edit(t) {
    if (ui.placing) return;
    ui.sheet = { type: 'edit', id: +t.dataset.id }; render();
  },
  move(t) { startMove(+t.dataset.id, +t.dataset.n); },
  back(t) {
    commit(() => { const p = byId(t.dataset.id); p.actions--; p.pos = Math.max(0, p.pos - 1); });
  },
  spend(t) { commit(() => { byId(t.dataset.id).actions--; }); },
  adj(t) { commit(() => { byId(t.dataset.id).actions += +t.dataset.n; }); },
  delay(t) {
    const n = roll('1D3');
    commit(() => { byId(t.dataset.id).actions -= n; });
    toast(`${byId(t.dataset.id).name} loses ${n} action${n > 1 ? 's' : ''} (1D3)`);
  },
  // hazard resolution
  cautious(t) { commit(() => { S.pending.cautious = +t.dataset.n; }); },
  d100() {
    const pe = S.pending, p = byId(pe.id);
    const net = pe.cautious - pe.pen - (impaired(p) ? 1 : 0);
    const skill = parseInt(ui.skill[p.id], 10);
    const r = d100(net);
    ui.roll = { r, skill: skill > 0 ? skill : null, lvl: skill > 0 ? level(r, skill) : null };
    render();
  },
  pass: passHazard,
  fail: failHazard,
  applyFail(t) { applyFail(t.dataset.v); },
  lost(t) { commit(() => { S.pending.lost = Math.max(0, S.pending.lost + +t.dataset.n); }); },
  reroll() { commit(() => { S.pending.dmg = roll(S.pending.dmgExpr); }); },
  phase(t) { commit(() => { S.pending.phase = t.dataset.v; }); },
  breakRoll(t) { ui.breakDmg = String(roll(t.dataset.v)); render(); },
  applyBreak,
  stopMove() {
    commit(() => {
      const p = byId(S.pending.id);
      p.actions -= S.pending.cautious;
      S.pending = null;
    });
  },
  // track
  gap(t) {
    const i = +t.dataset.i;
    if (ui.placing) {
      const pl = ui.placing;
      ui.placing = null;
      commit(() => { S.gaps[i] = pl.h; S.sudden = pl.caller; });
      return toast(`${pl.h.n} placed`);
    }
    ui.sheet = { type: 'gap', i }; render();
  },
  gapRoll(t) {
    commit(() => {
      const i = +t.dataset.i;
      S.gaps[i] = randomGap();
      toast(S.gaps[i] ? `Rolled: ${S.gaps[i].n}` : 'Rolled: clear');
    });
  },
  gapClear(t) { commit(() => { S.gaps[+t.dataset.i] = null; }); },
  gapType(t) { commit(() => { const g = S.gaps[+t.dataset.i]; g.t = t.dataset.v; if (g.t === 'h') g.hp = null; }); },
  gapDiff(t) { commit(() => { S.gaps[+t.dataset.i].d = t.dataset.v; }); },
  // sudden hazards
  sudden() { ui.sheet = { type: 'sudden' }; render(); },
  sdiff(t) { ui.sdiff = t.dataset.v; render(); },
  suddenGo(t) {
    ui.placing = { h: makeHazard(ui.sdiff), caller: t.dataset.v };
    ui.sheet = null; render();
  },
  placeReroll() { ui.placing.h = makeHazard(ui.placing.h.d); render(); },
  placeCancel() { ui.placing = null; render(); },
};

app.addEventListener('click', e => {
  const t = e.target.closest('[data-a]');
  if (!t || t.disabled) return;
  // Clicks inside a sheet bubble up to the sheet (noop) before the backdrop (close)
  if (t.dataset.a === 'close' && t.classList.contains('backdrop') && e.target !== t) return;
  if (t.tagName === 'INPUT' && t.type === 'checkbox' && t.dataset.a === 'veh') {
    byId(t.dataset.id).vehicle = t.checked; save(); return;
  }
  A[t.dataset.a]?.(t, e);
});

// Typing updates state silently (no re-render, so focus and keyboard stay put)
app.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.f) {
    const p = byId(t.dataset.id);
    if (!p) return;
    if (t.dataset.t === 'num') {
      const v = parseInt(t.value, 10);
      if (Number.isNaN(v)) { if (t.dataset.f === 'hp' || t.dataset.f === 'build') p[t.dataset.f] = null; else return; }
      else p[t.dataset.f] = v;
      if (t.dataset.f === 'build') p.buildMax = Math.max(p.buildMax ?? 0, p.build ?? 0) || null;
    } else p[t.dataset.f] = t.value;
    save();
  } else if (t.dataset.g) {
    const g = S.gaps[+t.dataset.i];
    if (!g) return;
    g[t.dataset.g] = t.dataset.g === 'hp' ? (t.value === '' ? null : parseInt(t.value, 10)) : t.value;
    save();
  } else if (t.dataset.u === 'skill') {
    ui.skill[t.dataset.id] = t.value;
  } else if (t.dataset.u === 'breakDmg') {
    ui.breakDmg = t.value;
  }
});

app.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.a2 === 'gapPick' && t.value !== '') {
    const [ty, n, s, hp] = setting().items[+t.value];
    commit(() => {
      const i = +t.dataset.i;
      S.gaps[i] = { t: ty, n, s, d: S.gaps[i]?.d || 'R', hp: ty === 'b' ? (hp ?? null) : null };
    });
  }
});

render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

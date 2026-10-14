'use strict';
/*
 * test/bend-oracle.js — INDEPENDENT exact oracle for the call-schedule "bend cost" minimum.
 *
 * Written from the owner's spec only (2026-10-11), by a separate agent that never read
 * generator.js — generator-regression.js uses it to prove generate() reaches the exact
 * minimum bend cost on the live period. Do NOT share code with generator.js. Model:
 *   week slots: dayCall (service week Mon..Sat), nights mon/tue/wed/thu, wknd (Fri night + Sun 24h).
 *   each slot = one surgeon id or EMPTY (400).
 * Floor (hard):
 *   dayCall      : holder not in avail on any of Mon..SUN (rule 1, owner brief 2026-10-12: the
 *                  service-week surgeon must be free that Sunday).
 *   night on d   : holder not in avail on d, and not in vacOnly on d+1.
 *   wknd         : holder not in avail on Fri or Sun, and not in vacOnly on the following Monday.
 * Pins: fixed assignments; a pin that violates the floor is dropped and the slot is searched normally.
 * Designed pairs (never costed): by default, every pair of slots in the same week that are BOTH
 *   surviving pins held by the same surgeon. An explicit `designedPairs` list replaces the default.
 * Bend costs: pairwise over same-holder slot pairs (same week table + 4 week->week+1 rows, seam uses seed).
 * Rule 2 (owner brief 2026-10-12, restated here — not shared with generator.js): nobody works two
 *   overnights in a row. At the slot level those pairs are adjacent weeknights, Thu night + that
 *   weekend (Thu → Fri night), service week + that weekend (Fri night → service Saturday → Sunday)
 *   and weekend → next Monday night; they cost HARD (never chosen) unless designed (waived), except
 *   service week + weekend for an id in opts.flex, which costs opts.lastResort (FAK's last resort).
 *
 * Exact method: DP over weeks. The only coupling between week w and w+1 is through
 * (dayCall_w, wknd_w) x (dayCall_{w+1}, mon_{w+1}). For every week we fully enumerate all legal
 * assignments (EMPTY always allowed) and keep best[dc][mon][wknd] = min intra-week cost over
 * (tue, wed, thu). DP state = (dayCall, wknd) of the previous week. Every assignment is represented,
 * the objective decomposes exactly into these terms, so the minimum is exact (no pruning heuristics).
 */

const SLOTS = ['dayCall', 'mon', 'tue', 'wed', 'thu', 'wknd'];
const DC = 0, MON = 1, TUE = 2, WED = 3, THU = 4, WK = 5;
const EMPTY_COST = 400;

// symmetric same-week pair cost table, indexed by SLOTS order
const PAIR = (() => {
  const m = Array.from({ length: 6 }, () => new Array(6).fill(0));
  const set = (a, b, c) => { m[a][b] = c; m[b][a] = c; };
  set(MON, WK, 6); set(TUE, WK, 8); set(WED, WK, 10); set(THU, WK, 50);
  set(MON, WED, 12); set(MON, THU, 12); set(TUE, THU, 12);
  set(MON, TUE, 50); set(TUE, WED, 50); set(WED, THU, 50);
  set(DC, MON, 60); set(DC, TUE, 60); set(DC, WED, 60); set(DC, THU, 60); set(DC, WK, 60);
  return m;
})();
// week w -> week w+1 rows
const CROSS = { dcMon: 30, wkMon: 40, wkDc: 45, dcDc: 45 };
// rule 2 — the hard slot pairs (2026-10-12)
const HARD = Infinity;
const HARD_PAIRS = [[MON, TUE], [TUE, WED], [WED, THU], [THU, WK], [DC, WK]];
const isHardPair = (a, b) => HARD_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

// ---------- date utils (own, UTC-based on ISO strings) ----------
function isoToMs(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function addDays(iso, n) {
  return new Date(isoToMs(iso) + n * 86400000).toISOString().slice(0, 10);
}
function inRanges(ranges, iso) {
  if (!ranges) return false;
  for (const r of ranges) if (r[0] <= iso && iso <= r[1]) return true;
  return false;
}

function isLegal(id, mondayISO, slot, avail, vacOnly) {
  const A = avail[id], V = vacOnly[id];
  const d = (k) => addDays(mondayISO, k); // k: 0=Mon .. 6=Sun, 7=next Mon
  if (slot === DC) {
    for (let k = 0; k <= 6; k++) if (inRanges(A, d(k))) return false; // Mon..Sun (rule 1)
    return true;
  }
  if (slot === WK) return !inRanges(A, d(4)) && !inRanges(A, d(6)) && !inRanges(V, d(7));
  const k = slot - MON; // mon=0..thu=3
  return !inRanges(A, d(k)) && !inRanges(V, d(k + 1));
}

/**
 * minBendCost({ ids, mondays, avail, vacOnly, pins, designedPairs, seed, names, forceFill })
 *   ids        : surgeon ids
 *   mondays    : ISO 'YYYY-MM-DD' strings (week starts)
 *   avail      : {id: [[startISO,endISO,...],...]} vacation ∪ no-call ∪ Silvis (inclusive)
 *   vacOnly    : {id: [[startISO,endISO,...],...]} vacation only
 *   pins       : {mondayISO: {slot: id}}
 *   designedPairs (optional): [{monday, slots:[slotA, slotB]}] or [[monday, slotA, slotB]] —
 *                replaces the auto list; a listed pair is waived whenever one surgeon holds both.
 *   seed       : {dayCall, wknd} of week -1
 *   names      : optional {id: label} for readable pair labels
 *   forceFill  : optional; if true EMPTY is only allowed when no surgeon is legal (default false:
 *                EMPTY is always an option, it just costs 400)
 *   rule2      : optional; true → the rule-2 pairs above cost HARD (Infinity) unless designed
 *   flex, lastResort : with rule2 — ids whose service week + weekend costs lastResort instead
 * → { cost, perWeek:[{monday, cost, pairs:[...]}], assignment:[{monday, dayCall..wknd}], pinsKept, pinsDropped, waived }
 */
function minBendCost(opts) {
  const ids = opts.ids;
  const mondays = opts.mondays;
  const avail = opts.avail || {};
  const vacOnly = opts.vacOnly || {};
  const pins = opts.pins || {};
  const seed = opts.seed || {};
  const names = opts.names || {};
  const forceFill = !!opts.forceFill;
  const rule2 = !!opts.rule2, flexSet = new Set(opts.flex || []), lastResort = opts.lastResort === undefined ? HARD : opts.lastResort;
  const n = ids.length, E = n, S = n + 1, W = mondays.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const lbl = (i) => (i === E ? 'EMPTY' : (names[ids[i]] || ids[i]));

  for (const m of Object.keys(pins)) {
    for (const s of Object.keys(pins[m])) if (!SLOTS.includes(s)) throw new Error(`unknown pin slot ${s}`);
  }

  // ---- options per (week, slot), pins ----
  const options = [];
  const pinned = []; // [w][s] -> idx or -1 (surviving pins only)
  const pinsKept = [], pinsDropped = [];
  for (let w = 0; w < W; w++) {
    const mon = mondays[w];
    const wkPins = pins[mon] || {};
    options.push([]); pinned.push(new Array(6).fill(-1));
    for (let s = 0; s < 6; s++) {
      const legal = [];
      for (let i = 0; i < n; i++) if (isLegal(ids[i], mon, s, avail, vacOnly)) legal.push(i);
      const pid = wkPins[SLOTS[s]];
      if (pid != null) {
        const pi = idx.has(pid) ? idx.get(pid) : -1;
        if (pi >= 0 && legal.includes(pi)) {
          options[w].push([pi]); pinned[w][s] = pi;
          pinsKept.push({ monday: mon, slot: SLOTS[s], id: pid });
          continue;
        }
        pinsDropped.push({ monday: mon, slot: SLOTS[s], id: pid, reason: pi < 0 ? 'unknown id' : 'violates floor' });
      }
      options[w].push(forceFill && legal.length ? legal : legal.concat([E]));
    }
  }

  // ---- waived (designed) pairs ----
  const waived = Array.from({ length: W }, () => Array.from({ length: 6 }, () => new Array(6).fill(false)));
  const waivedList = [];
  if (Array.isArray(opts.designedPairs)) {
    for (const p of opts.designedPairs) {
      const monday = Array.isArray(p) ? p[0] : p.monday;
      const [a, b] = Array.isArray(p) ? [p[1], p[2]] : p.slots;
      const w = mondays.indexOf(monday), sa = SLOTS.indexOf(a), sb = SLOTS.indexOf(b);
      if (w < 0 || sa < 0 || sb < 0 || sa === sb) throw new Error(`bad designed pair ${JSON.stringify(p)}`);
      waived[w][sa][sb] = waived[w][sb][sa] = true;
      waivedList.push({ monday, slots: [a, b] });
    }
  } else {
    for (let w = 0; w < W; w++) for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      if (pinned[w][a] >= 0 && pinned[w][a] === pinned[w][b]) {
        waived[w][a][b] = waived[w][b][a] = true;
        waivedList.push({ monday: mondays[w], slots: [SLOTS[a], SLOTS[b]], id: ids[pinned[w][a]] });
      }
    }
  }

  // same-week pair cost for holder i (rule 2 when asked)
  const pairCost = (sa, sb, i) => {
    if (!rule2 || !isHardPair(sa, sb)) return PAIR[sa][sb];
    const svcWk = (sa === DC && sb === WK) || (sa === WK && sb === DC);
    return svcWk && flexSet.has(ids[i]) ? lastResort : HARD;
  };
  const crossWkMon = rule2 ? HARD : CROSS.wkMon;
  // ---- per-week exhaustive enumeration: best[dc][mon][wk] over (tue,wed,thu) ----
  const S3 = S * S * S;
  const bestCost = [], bestArg = [];
  let enumerated = 0;
  for (let w = 0; w < W; w++) {
    const o = options[w], wv = waived[w];
    const pc = (sa, sb, a, b) => (a !== E && a === b && !wv[sa][sb] ? pairCost(sa, sb, a) : 0);
    const ec = (a) => (a === E ? EMPTY_COST : 0);
    const bc = new Float64Array(S3).fill(Infinity);
    const ba = new Int32Array(S3).fill(-1);
    for (const dc of o[DC]) for (const mn of o[MON]) for (const wk of o[WK]) {
      const c0 = ec(dc) + ec(mn) + ec(wk) + pc(DC, MON, dc, mn) + pc(DC, WK, dc, wk) + pc(MON, WK, mn, wk);
      const key = (dc * S + mn) * S + wk;
      for (const tu of o[TUE]) {
        const c1 = c0 + ec(tu) + pc(DC, TUE, dc, tu) + pc(MON, TUE, mn, tu) + pc(TUE, WK, tu, wk);
        for (const we of o[WED]) {
          const c2 = c1 + ec(we) + pc(DC, WED, dc, we) + pc(MON, WED, mn, we) + pc(TUE, WED, tu, we) + pc(WED, WK, we, wk);
          for (const th of o[THU]) {
            const c3 = c2 + ec(th) + pc(DC, THU, dc, th) + pc(MON, THU, mn, th) + pc(TUE, THU, tu, th)
              + pc(WED, THU, we, th) + pc(THU, WK, th, wk);
            enumerated++;
            if (c3 < bc[key]) { bc[key] = c3; ba[key] = (tu * S + we) * S + th; }
          }
        }
      }
    }
    bestCost.push(bc); bestArg.push(ba);
  }

  // ---- DP over weeks, state = (dayCall, wknd) of the previous week ----
  const sIdx = (id) => (id != null && idx.has(id) ? idx.get(id) : E);
  const cross = (pdc, pwk, dc, mn) =>
    (pdc !== E && pdc === mn ? CROSS.dcMon : 0) + (pwk !== E && pwk === mn ? crossWkMon : 0) +
    (pwk !== E && pwk === dc ? CROSS.wkDc : 0) + (pdc !== E && pdc === dc ? CROSS.dcDc : 0);
  let dp = new Float64Array(S * S).fill(Infinity);
  dp[sIdx(seed.dayCall) * S + sIdx(seed.wknd)] = 0;
  const backPrev = [], backMon = [];
  for (let w = 0; w < W; w++) {
    const nd = new Float64Array(S * S).fill(Infinity);
    const bp = new Int32Array(S * S).fill(-1), bm = new Int32Array(S * S).fill(-1);
    const o = options[w], bc = bestCost[w];
    for (let ps = 0; ps < S * S; ps++) {
      const base = dp[ps];
      if (base === Infinity) continue;
      const pdc = Math.floor(ps / S), pwk = ps % S;
      for (const dc of o[DC]) for (const mn of o[MON]) {
        const cr = base + cross(pdc, pwk, dc, mn);
        for (const wk of o[WK]) {
          const b = bc[(dc * S + mn) * S + wk];
          if (b === Infinity) continue;
          const v = cr + b, ns = dc * S + wk;
          if (v < nd[ns]) { nd[ns] = v; bp[ns] = ps; bm[ns] = mn; }
        }
      }
    }
    dp = nd; backPrev.push(bp); backMon.push(bm);
  }
  let bestState = -1, cost = Infinity;
  for (let s = 0; s < S * S; s++) if (dp[s] < cost) { cost = dp[s]; bestState = s; }

  // ---- reconstruct ----
  const asg = new Array(W);
  let st = bestState;
  for (let w = W - 1; w >= 0; w--) {
    const dc = Math.floor(st / S), wk = st % S, mn = backMon[w][st];
    const arg = bestArg[w][(dc * S + mn) * S + wk];
    const tu = Math.floor(arg / (S * S)), we = Math.floor(arg / S) % S, th = arg % S;
    asg[w] = [dc, mn, tu, we, th, wk];
    st = backPrev[w][st];
  }

  // ---- independent re-score of the reconstructed assignment (named breakdown) ----
  const perWeek = [];
  let total = 0;
  let pdc = sIdx(seed.dayCall), pwk = sIdx(seed.wknd);
  for (let w = 0; w < W; w++) {
    const a = asg[w], pairs = [];
    let wc = 0;
    for (let s = 0; s < 6; s++) if (a[s] === E) {
      pairs.push({ kind: 'EMPTY', slot: SLOTS[s], cost: EMPTY_COST, label: `EMPTY ${SLOTS[s]} = ${EMPTY_COST}` });
      wc += EMPTY_COST;
    }
    for (let s = 0; s < 6; s++) for (let t = s + 1; t < 6; t++) {
      if (a[s] === E || a[s] !== a[t]) continue;
      if (waived[w][s][t]) continue;
      const pcv = pairCost(s, t, a[s]);
      pairs.push({ kind: 'sameWeek', id: ids[a[s]], slots: [SLOTS[s], SLOTS[t]], cost: pcv,
        label: `${lbl(a[s])} ${SLOTS[s]}+${SLOTS[t]} = ${pcv}` });
      wc += pcv;
    }
    const prevTag = w === 0 ? 'seed' : 'prev wk';
    const xr = [
      [pdc, a[MON], 'dayCall', 'mon', CROSS.dcMon],
      [pwk, a[MON], 'wknd', 'mon', crossWkMon],
      [pwk, a[DC], 'wknd', 'dayCall', CROSS.wkDc],
      [pdc, a[DC], 'dayCall', 'dayCall', CROSS.dcDc],
    ];
    for (const [p, c, ps, cs, v] of xr) {
      if (p === E || p !== c) continue;
      pairs.push({ kind: w === 0 ? 'seam' : 'crossWeek', id: ids[c], slots: [`${ps}(${prevTag})`, cs], cost: v,
        label: `${lbl(c)} ${ps}(${prevTag})+${cs} = ${v}` });
      wc += v;
    }
    perWeek.push({ monday: mondays[w], cost: wc, pairs });
    total += wc;
    pdc = a[DC]; pwk = a[WK];
  }
  if (total !== cost) throw new Error(`internal mismatch: DP ${cost} vs re-score ${total}`);

  const assignment = asg.map((a, w) => {
    const r = { monday: mondays[w] };
    SLOTS.forEach((s, k) => { r[s] = a[k] === E ? null : ids[a[k]]; });
    return r;
  });
  return { cost, perWeek, assignment, pinsKept, pinsDropped, waived: waivedList, stats: { enumerated } };
}

module.exports = { minBendCost, isLegal, SLOTS, PAIR, CROSS, EMPTY_COST, addDays, isHardPair };

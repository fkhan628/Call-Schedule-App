'use strict';
// node fake-weeks-table.test.js   (plain asserts, no framework)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createFakeWeeksTable } = require('./fake-weeks-table.js');

const BASE = 'https://x.supabase.co';
const T = BASE + '/rest/v1/schedule_weeks';
const CLOCK = '2026-10-11T12:00:00.000Z';
const CLOCK_PG = '2026-10-11T12:00:00+00:00';
const REP = { Prefer: 'return=representation' };

// Seeded deliberately out of PK order (heap order = this order).
function seed() {
  return [
    { week_monday: '2026-10-05', data: { zeta: 1, a: 2 }, version: 3, updated_by: 'user-a', updated_at: '2026-10-01T08:00:00.000Z' },
    { week_monday: '2026-09-28', data: { days: [1, 2] }, version: 1, updated_by: null, updated_at: '2026-09-27T08:00:00.000Z' },
    { week_monday: '2026-10-12', data: {}, version: 2, updated_by: 'user-b', updated_at: '2026-10-02T08:00:00.000Z' },
  ];
}
function mk(extra) {
  return createFakeWeeksTable(Object.assign({
    baseUrl: BASE, anonKey: 'ANON', users: { TOK_A: 'user-a', TOK_B: 'user-b' }, rows: seed(), clock: () => CLOCK,
  }, extra || {}));
}
function H(token, extra) {
  const h = { apikey: 'ANON', 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  return Object.assign(h, extra || {});
}
const tok = t => (t === undefined ? 'TOK_A' : t);
const url = qs => T + (qs ? '?' + qs : '');
const get = (t, qs, token, extra) => t.fetch(url(qs), { headers: H(tok(token), extra) });
const patch = (t, qs, body, token, extra) => t.fetch(url(qs), { method: 'PATCH', headers: H(tok(token), extra), body: JSON.stringify(body) });
const post = (t, body, o) => { o = o || {}; return t.fetch(url(o.qs), { method: 'POST', headers: H(tok(o.token), o.headers), body: JSON.stringify(body) }); };
const remove = (t, qs, extra, token) => t.fetch(url(qs), { method: 'DELETE', headers: H(tok(token), extra) });
const json = async p => (await p).json();
const weeks = async p => (await json(p)).map(r => r.week_monday);
const flush = () => new Promise(r => setImmediate(r));
async function expectErr(p, status, code) {
  const r = await p;
  assert.strictEqual(r.status, status, 'status');
  assert.strictEqual(r.ok, false);
  const b = await r.json();
  if (code !== undefined) assert.strictEqual(b.code, code, 'code (' + b.message + ')');
  return b;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --------------------------------------------------------------- module
test('exports via module.exports, and as a global in a bare vm context with no host APIs', async () => {
  assert.strictEqual(typeof createFakeWeeksTable, 'function');
  const src = fs.readFileSync(path.join(__dirname, 'fake-weeks-table.js'), 'utf8');
  const ctx = vm.createContext({});
  assert.strictEqual(vm.runInContext('typeof URL + typeof setTimeout + typeof TextEncoder + typeof module', ctx),
    'undefinedundefinedundefinedundefined');
  vm.runInContext(src, ctx);
  assert.strictEqual(typeof ctx.createFakeWeeksTable, 'function');
  const t = ctx.createFakeWeeksTable({ baseUrl: BASE, anonKey: 'ANON', users: { TOK_A: 'user-a' }, rows: seed(), clock: () => CLOCK });
  const r = await t.fetch(url('week_monday=eq.2026-10-05&version=eq.3'),
    { method: 'PATCH', headers: H('TOK_A', REP), body: JSON.stringify({ data: { b: 1, a: 2 }, version: 4 }) });
  assert.strictEqual(r.status, 200);
  const rows = await r.json(); // vm-realm objects: compare via JSON, not deepStrictEqual
  assert.strictEqual(JSON.stringify(rows), '[{"week_monday":"2026-10-05","data":{"a":2,"b":1},"version":4,"updated_by":"user-a","updated_at":"2026-10-01T08:00:00+00:00"}]');
  await assert.rejects(t.fetch(url('week_monday=eq.2026-10-05'), { method: 'PATCH', headers: H('TOK_A'), body: '{}' }).then(x => x.json()),
    e => e.name === 'SyntaxError');
});

// ------------------------------------------------------------------ GET
test('GET select=* returns every column in table order; order=week_monday.asc sorts; headers', async () => {
  const t = mk();
  const r = await get(t, 'select=*&order=week_monday.asc');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.strictEqual(r.headers.get('content-range'), '0-2/*');
  assert.strictEqual(r.headers.get('x-nope'), null);
  const a = await r.json();
  assert.deepStrictEqual(a.map(x => x.week_monday), ['2026-09-28', '2026-10-05', '2026-10-12']);
  assert.deepStrictEqual(Object.keys(a[0]), ['week_monday', 'data', 'version', 'updated_by', 'updated_at']);
  assert.deepStrictEqual(a[1], { week_monday: '2026-10-05', data: { a: 2, zeta: 1 }, version: 3, updated_by: 'user-a', updated_at: '2026-10-01T08:00:00+00:00' });
  // no select at all == select=*
  assert.deepStrictEqual(await json(get(t, 'order=week_monday.asc')), a);
});

test('GET select=<cols> projects exactly those columns in the requested order (encoded or not); alias; unknown column', async () => {
  const t = mk();
  for (const qs of ['select=week_monday,version,updated_at', 'select=week_monday%2Cversion%2Cupdated_at']) {
    const a = await json(get(t, qs + '&order=week_monday.asc'));
    assert.deepStrictEqual(a[0], { week_monday: '2026-09-28', version: 1, updated_at: '2026-09-27T08:00:00+00:00' });
    assert.deepStrictEqual(Object.keys(a[0]), ['week_monday', 'version', 'updated_at']);
  }
  const b = await json(get(t, 'select=data,version,updated_at&week_monday=eq.2026-10-05'));
  assert.deepStrictEqual(Object.keys(b[0]), ['data', 'version', 'updated_at']);
  assert.deepStrictEqual(b[0].data, { a: 2, zeta: 1 });
  assert.deepStrictEqual(await json(get(t, 'select=v:version&week_monday=eq.2026-10-05')), [{ v: 3 }]);
  await expectErr(get(t, 'select=week_monday,nope'), 400, '42703');
});

test('GET filters: eq, in.() raw/encoded/quoted/empty, not.in, gte, version gt, order desc, limit, offset, count=exact', async () => {
  const t = mk();
  assert.deepStrictEqual(await weeks(get(t, 'week_monday=eq.2026-10-05')), ['2026-10-05']);
  const both = ['2026-09-28', '2026-10-12'];
  assert.deepStrictEqual(await weeks(get(t, 'select=week_monday&week_monday=in.(2026-09-28,2026-10-12)&order=week_monday.asc')), both);
  assert.deepStrictEqual(await weeks(get(t, 'select=week_monday&week_monday=in.%282026-09-28%2C2026-10-12%29&order=week_monday.asc')), both);
  assert.deepStrictEqual(await weeks(get(t, 'week_monday=in.(%222026-10-12%22)')), ['2026-10-12']);
  assert.deepStrictEqual(await weeks(get(t, 'week_monday=in.("2026-10-12")')), ['2026-10-12']);
  assert.deepStrictEqual(await weeks(get(t, 'week_monday=in.()')), []);
  assert.deepStrictEqual(await weeks(get(t, 'week_monday=not.in.(2026-09-28,2026-10-12)')), ['2026-10-05']);
  assert.deepStrictEqual(await weeks(get(t, 'week_monday=gte.2026-10-05&order=week_monday.asc')), ['2026-10-05', '2026-10-12']);
  assert.deepStrictEqual(await weeks(get(t, 'version=gt.1&order=version.desc')), ['2026-10-05', '2026-10-12']);
  assert.deepStrictEqual(await weeks(get(t, 'updated_by=is.null')), ['2026-09-28']);
  assert.deepStrictEqual(await weeks(get(t, 'order=week_monday.desc&limit=2')), ['2026-10-12', '2026-10-05']);
  const r = await get(t, 'order=week_monday.asc&limit=1&offset=1');
  assert.strictEqual(r.headers.get('content-range'), '1-1/*');
  assert.deepStrictEqual((await r.json()).map(x => x.week_monday), ['2026-10-05']);
  const c = await get(t, 'limit=1&order=week_monday.asc', 'TOK_A', { Prefer: 'count=exact' });
  assert.strictEqual(c.headers.get('content-range'), '0-0/3');
  const e = await get(t, 'week_monday=eq.2030-01-07');
  assert.strictEqual(e.headers.get('content-range'), '*/*');
  assert.deepStrictEqual(await e.json(), []);
});

test('GET without order follows heap order: an UPDATE moves the row to the end', async () => {
  const t = mk();
  assert.deepStrictEqual(await weeks(get(t, 'select=week_monday')), ['2026-10-05', '2026-09-28', '2026-10-12']);
  assert.strictEqual((await patch(t, 'week_monday=eq.2026-10-05', { version: 4 })).status, 204);
  assert.deepStrictEqual(await weeks(get(t, 'select=week_monday')), ['2026-09-28', '2026-10-12', '2026-10-05']);
});

test('GET bad input is a 400 like Postgres/PostgREST; a raw "+" in the query decodes to a space', async () => {
  const t = mk();
  await expectErr(get(t, 'version=eq.abc'), 400, '22P02');
  await expectErr(get(t, 'week_monday=eq.2026-13-01'), 400, '22008');
  await expectErr(get(t, 'week_monday=eq.10/05/2026'), 400, '22007');
  await expectErr(get(t, 'week_monday=like.2026*'), 400, 'PGRST100');
  await expectErr(get(t, 'week_monday=2026-10-05'), 400, 'PGRST100');
  await expectErr(get(t, 'nosuch=eq.1'), 400, '42703');
  await expectErr(get(t, 'limit=ten'), 400, 'PGRST100');
  await expectErr(get(t, 'order=week_monday.sideways'), 400, 'PGRST100');
  await expectErr(get(t, 'updated_at=gt.2026-10-01T00:00:00+00:00'), 400, '22007');
  assert.deepStrictEqual(await weeks(get(t, 'updated_at=gt.2026-10-01T00:00:00%2B00:00&order=week_monday.asc')), ['2026-10-05', '2026-10-12']);
});

test('GET with Accept: application/vnd.pgrst.object+json -> one object, or 406 PGRST116', async () => {
  const t = mk();
  const one = await json(get(t, 'select=version&week_monday=eq.2026-10-05', 'TOK_A', { Accept: 'application/vnd.pgrst.object+json' }));
  assert.deepStrictEqual(one, { version: 3 });
  await expectErr(get(t, 'week_monday=gte.2026-01-01', 'TOK_A', { Accept: 'application/vnd.pgrst.object+json' }), 406, 'PGRST116');
});

// ---------------------------------------------------------------- PATCH
test('PATCH + return=representation -> 200 + updated rows; only body fields change (no trigger)', async () => {
  const t = mk();
  const r = await patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { data: { x: 1 }, version: 4 }, 'TOK_A', REP);
  assert.strictEqual(r.status, 200);
  const a = await r.json();
  const expected = { week_monday: '2026-10-05', data: { x: 1 }, version: 4, updated_by: 'user-a', updated_at: '2026-10-01T08:00:00+00:00' };
  assert.deepStrictEqual(a, [expected]);
  assert.deepStrictEqual(t.get('2026-10-05'), expected);
  // select= narrows the representation
  const b = await json(patch(t, 'week_monday=eq.2026-10-05&version=eq.4&select=version', { version: 5 }, 'TOK_A', REP));
  assert.deepStrictEqual(b, [{ version: 5 }]);
  // several rows at once
  const c = await json(patch(t, 'week_monday=in.(2026-09-28,2026-10-12)', { updated_by: 'bulk' }, 'TOK_A', REP));
  assert.deepStrictEqual(c.map(x => [x.week_monday, x.updated_by]), [['2026-09-28', 'bulk'], ['2026-10-12', 'bulk']]);
});

test('PATCH without return=representation -> 204, empty body, json() rejects, text() is ""', async () => {
  const t = mk();
  const r = await patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { version: 4 });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.headers.get('content-type'), null);
  await assert.rejects(r.json(), SyntaxError);
  assert.strictEqual(t.get('2026-10-05').version, 4);
  const r2 = await patch(t, 'week_monday=eq.2026-10-05', { version: 5 }, 'TOK_A', { Prefer: 'return=minimal' });
  assert.strictEqual(r2.status, 204);
  assert.strictEqual(await r2.text(), '');
  assert.strictEqual(t.get('2026-10-05').version, 5);
});

test('PATCH CAS miss (version=eq.<stale>) matches 0 rows: 200 [] / 204, nothing changes, applied=false', async () => {
  const t = mk();
  const before = t.rows();
  const r = await patch(t, 'week_monday=eq.2026-10-05&version=eq.2', { data: { lost: true }, version: 3 }, 'TOK_A', REP);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), []);
  const r2 = await patch(t, 'week_monday=eq.2026-10-05&version=eq.2', { version: 3 });
  assert.strictEqual(r2.status, 204);
  assert.deepStrictEqual(t.rows(), before);
  assert.deepStrictEqual(t.log.map(e => e.applied), [false, false]);
  // missing row: also just 0 rows
  assert.deepStrictEqual(await json(patch(t, 'week_monday=eq.2030-01-07', { version: 1 }, 'TOK_A', REP)), []);
});

test('PATCH errors: no filter 21000, unknown column PGRST204, bad int 22P02, PK collision 409, no Content-Type 415, bad JSON PGRST102', async () => {
  const t = mk();
  const before = t.rows();
  const b = await expectErr(patch(t, '', { version: 9 }), 400, '21000');
  assert.strictEqual(b.message, 'UPDATE requires a WHERE clause');
  await expectErr(patch(t, 'week_monday=eq.2026-10-05', { nope: 1 }), 400, 'PGRST204');
  await expectErr(patch(t, 'week_monday=eq.2026-10-05', { version: 'four' }), 400, '22P02');
  await expectErr(patch(t, 'week_monday=eq.2026-10-05', { version: 2.5 }), 400, '22P02');
  await expectErr(patch(t, 'week_monday=eq.2026-10-05', { version: null }), 400, '23502');
  await expectErr(patch(t, 'week_monday=eq.2026-10-05', { week_monday: '2026-10-12' }), 409, '23505');
  await expectErr(t.fetch(url('week_monday=eq.2026-10-05'), { method: 'PATCH', headers: { apikey: 'ANON', Authorization: 'Bearer TOK_A' }, body: '{"version":9}' }), 415, 'PGRST107');
  await expectErr(t.fetch(url('week_monday=eq.2026-10-05'), { method: 'PATCH', headers: H('TOK_A'), body: 'not json' }), 400, 'PGRST102');
  await expectErr(t.fetch(url('week_monday=eq.2026-10-05'), { method: 'PATCH', headers: H('TOK_A'), body: { version: 9 } }), 400, 'PGRST102');
  await expectErr(t.fetch(url('week_monday=eq.2026-10-05'), { method: 'PATCH', headers: H('TOK_A') }), 400, 'PGRST102');
  await expectErr(patch(t, 'week_monday=eq.2026-10-05', [{ version: 9 }]), 400, 'PGRST102');
  assert.deepStrictEqual(t.rows(), before);
  assert.ok(t.log.every(e => e.applied === false));
  // a non-colliding PK change is fine
  const ok = await json(patch(t, 'week_monday=eq.2026-10-05', { week_monday: '2026-11-30' }, 'TOK_A', REP));
  assert.strictEqual(ok[0].week_monday, '2026-11-30');
  assert.strictEqual(t.get('2026-10-05'), null);
});

// ----------------------------------------------------------------- POST
test('POST insert: 201 + representation (defaults filled); 201 with empty body without it', async () => {
  const t = mk();
  const r = await post(t, { week_monday: '2026-10-19', data: { b: 1 }, version: 1, updated_by: 'user-a', updated_at: '2026-10-11T09:30:00.5Z' }, { headers: REP });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(await r.json(), [{ week_monday: '2026-10-19', data: { b: 1 }, version: 1, updated_by: 'user-a', updated_at: '2026-10-11T09:30:00.5+00:00' }]);
  const r2 = await post(t, { week_monday: '2026-10-26', data: { c: 2 } });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(await r2.text(), '');
  assert.deepStrictEqual(t.get('2026-10-26'), { week_monday: '2026-10-26', data: { c: 2 }, version: 1, updated_by: null, updated_at: CLOCK_PG });
  const r3 = await post(t, [{ week_monday: '2026-11-02', data: {} }, { week_monday: '2026-11-09', data: {} }], { headers: REP });
  assert.deepStrictEqual((await r3.json()).map(x => x.week_monday), ['2026-11-02', '2026-11-09']);
  assert.strictEqual(t.rows().length, 7);
});

test('POST duplicate -> 409 23505; a bulk insert containing one is rolled back entirely', async () => {
  const t = mk();
  const b = await expectErr(post(t, { week_monday: '2026-10-05', data: {}, version: 1 }, { headers: REP }), 409, '23505');
  assert.ok(b.message.indexOf('duplicate key value violates unique constraint') === 0);
  assert.strictEqual(b.details, 'Key (week_monday)=(2026-10-05) already exists.');
  await expectErr(post(t, [{ week_monday: '2026-10-19', data: {} }, { week_monday: '2026-10-05', data: {} }]), 409, '23505');
  assert.strictEqual(t.get('2026-10-19'), null);
  await expectErr(post(t, [{ week_monday: '2026-10-26', data: {} }, { week_monday: '2026-10-26', data: {} }]), 409, '23505');
  assert.strictEqual(t.get('2026-10-26'), null);
  assert.strictEqual(t.get('2026-10-05').version, 3);
  assert.ok(t.log.every(e => e.applied === false));
});

test('POST validation: bulk keys must match, week_monday NOT NULL, unknown column, bad date, columns= unsupported', async () => {
  const t = mk();
  const b = await expectErr(post(t, [{ week_monday: '2026-10-19', data: {} }, { week_monday: '2026-10-26' }]), 400, 'PGRST102');
  assert.strictEqual(b.message, 'All object keys must match');
  await expectErr(post(t, { data: {} }), 400, '23502');
  await expectErr(post(t, { week_monday: '2026-10-19', colour: 'red' }), 400, 'PGRST204');
  await expectErr(post(t, { week_monday: '2026-02-30' }), 400, '22008');
  await expectErr(post(t, { week_monday: '2026-10-19' }, { qs: 'columns=week_monday' }), 400, 'PGRST100');
  assert.strictEqual(t.rows().length, 3);
});

test('POST upsert (resolution=merge-duplicates + on_conflict=week_monday) replaces payload columns and KEEPS version', async () => {
  const t = mk();
  const ts = '2026-10-11T13:00:00Z';
  const r = await post(t, [
    { week_monday: '2026-10-05', data: { blind: true }, updated_by: 'user-b', updated_at: ts },
    { week_monday: '2026-10-19', data: { fresh: 1 }, updated_by: 'user-b', updated_at: ts },
  ], { qs: 'on_conflict=week_monday', token: 'TOK_B', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(await r.text(), '');
  assert.deepStrictEqual(t.get('2026-10-05'), { week_monday: '2026-10-05', data: { blind: true }, version: 3, updated_by: 'user-b', updated_at: '2026-10-11T13:00:00+00:00' });
  assert.deepStrictEqual(t.get('2026-10-19'), { week_monday: '2026-10-19', data: { fresh: 1 }, version: 1, updated_by: 'user-b', updated_at: '2026-10-11T13:00:00+00:00' });
  assert.strictEqual(t.log[0].applied, true);
  // body supplies version -> it is replaced; representation -> 201 + rows
  const a = await json(post(t, { week_monday: '2026-10-05', data: { v: 7 }, version: 7 }, { qs: 'on_conflict=week_monday', headers: { Prefer: 'resolution=merge-duplicates, return=representation' } }));
  assert.deepStrictEqual(a.map(x => [x.week_monday, x.version, x.data]), [['2026-10-05', 7, { v: 7 }]]);
  // on_conflict omitted -> PostgREST defaults to the primary key, still an upsert
  await post(t, { week_monday: '2026-10-05', data: { noOc: 1 } }, { headers: { Prefer: 'resolution=merge-duplicates' } });
  assert.deepStrictEqual([t.get('2026-10-05').version, t.get('2026-10-05').data], [7, { noOc: 1 }]);
  // same key twice in one upsert payload
  await expectErr(post(t, [{ week_monday: '2026-10-12', data: {} }, { week_monday: '2026-10-12', data: {} }], { headers: { Prefer: 'resolution=merge-duplicates' } }), 400, '21000');
  // on_conflict on a non-unique column
  await expectErr(post(t, { week_monday: '2026-10-12', data: {} }, { qs: 'on_conflict=updated_by', headers: { Prefer: 'resolution=merge-duplicates' } }), 400, '42P10');
  // ignore-duplicates leaves the existing row alone
  const ig = await json(post(t, [{ week_monday: '2026-10-12', data: { no: 1 } }, { week_monday: '2026-11-02', data: { yes: 1 } }], { headers: { Prefer: 'resolution=ignore-duplicates,return=representation' } }));
  assert.deepStrictEqual(ig.map(x => x.week_monday), ['2026-11-02']);
  assert.deepStrictEqual(t.get('2026-10-12').data, {});
  // without a resolution preference, on_conflict alone is a plain insert -> 409
  await expectErr(post(t, { week_monday: '2026-10-12', data: {} }, { qs: 'on_conflict=week_monday' }), 409, '23505');
});

// --------------------------------------------------------------- DELETE
test('DELETE: version filter, representation (200 + deleted rows) vs 204, in.() list, no filter -> 400', async () => {
  const t = mk();
  const miss = await remove(t, 'week_monday=eq.2026-10-05&version=eq.2', REP);
  assert.strictEqual(miss.status, 200);
  assert.deepStrictEqual(await miss.json(), []);
  assert.ok(t.get('2026-10-05'));
  const hit = await remove(t, 'week_monday=eq.2026-10-05&version=eq.3', REP);
  assert.strictEqual(hit.status, 200);
  assert.deepStrictEqual(await hit.json(), [{ week_monday: '2026-10-05', data: { a: 2, zeta: 1 }, version: 3, updated_by: 'user-a', updated_at: '2026-10-01T08:00:00+00:00' }]);
  assert.strictEqual(t.get('2026-10-05'), null);
  const b = await expectErr(remove(t, ''), 400, '21000');
  assert.strictEqual(b.message, 'DELETE requires a WHERE clause');
  const many = await remove(t, 'week_monday=in.(2026-09-28,2026-10-12)');
  assert.strictEqual(many.status, 204);
  assert.strictEqual(await many.text(), '');
  assert.deepStrictEqual(t.rows(), []);
  const none = await remove(t, 'week_monday=eq.2026-09-28');
  assert.strictEqual(none.status, 204);
  assert.deepStrictEqual(t.log.map(e => e.applied), [false, true, false, true, false]);
});

// ------------------------------------------------------------- auth/RLS
test('anon (no Authorization, or Bearer anonKey): GET ok; PATCH/DELETE silently match 0 rows; POST 401 42501', async () => {
  const t = mk();
  const before = t.rows();
  const noAuth = { apikey: 'ANON', 'Content-Type': 'application/json' };
  const anonBearer = Object.assign({ Authorization: 'Bearer ANON' }, noAuth);
  for (const h of [noAuth, anonBearer]) {
    const g = await t.fetch(url('order=week_monday.asc'), { headers: h });
    assert.strictEqual(g.status, 200);
    assert.strictEqual((await g.json()).length, 3);
    const p1 = await t.fetch(url('week_monday=eq.2026-10-05&version=eq.3'), { method: 'PATCH', headers: Object.assign({}, h, REP), body: '{"version":4}' });
    assert.strictEqual(p1.status, 200);
    assert.deepStrictEqual(await p1.json(), []);
    const p2 = await t.fetch(url('week_monday=eq.2026-10-05'), { method: 'PATCH', headers: h, body: '{"version":4}' });
    assert.strictEqual(p2.status, 204);
    const d1 = await t.fetch(url('week_monday=eq.2026-10-05'), { method: 'DELETE', headers: Object.assign({}, h, REP) });
    assert.strictEqual(d1.status, 200);
    assert.deepStrictEqual(await d1.json(), []);
    const d2 = await t.fetch(url('week_monday=in.(2026-09-28,2026-10-12)'), { method: 'DELETE', headers: h });
    assert.strictEqual(d2.status, 204);
    const b = await expectErr(t.fetch(url(), { method: 'POST', headers: h, body: '{"week_monday":"2026-10-19","data":{}}' }), 401, '42501');
    assert.ok(/row-level security/.test(b.message));
    await expectErr(t.fetch(url('on_conflict=week_monday'), { method: 'POST', headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, h), body: '[{"week_monday":"2026-10-05","data":{}}]' }), 401, '42501');
  }
  assert.deepStrictEqual(t.rows(), before);
  assert.ok(t.log.every(e => e.role === 'anon' && e.user === null && e.applied === false));
});

test('expired token -> 401 PGRST303 on every method; unknown token -> 401 PGRST301; apikey gate', async () => {
  const t = mk();
  const before = t.rows();
  t.control.expiredTokens.add('TOK_A');
  const calls = [
    get(t, ''),
    patch(t, 'week_monday=eq.2026-10-05', { version: 9 }),
    post(t, { week_monday: '2026-10-19', data: {} }),
    remove(t, 'week_monday=eq.2026-10-05'),
  ];
  for (const c of calls) {
    const r = await c;
    assert.strictEqual(r.status, 401);
    assert.ok(/invalid_token/.test(r.headers.get('WWW-Authenticate')));
    const b = await r.json();
    assert.deepStrictEqual([b.code, b.message], ['PGRST303', 'JWT expired']);
  }
  assert.deepStrictEqual(t.rows(), before);
  assert.strictEqual((await get(t, '', 'TOK_B')).status, 200);
  await expectErr(get(t, '', 'garbage'), 401, 'PGRST301');
  await expectErr(get(t, '', 'undefined'), 401, 'PGRST301');
  const noKey = await json(t.fetch(url(), { headers: { Authorization: 'Bearer TOK_B' } }));
  assert.strictEqual(noKey.message, 'No API key found in request');
  const badKey = await t.fetch(url(), { headers: { apikey: 'WRONG', Authorization: 'Bearer TOK_B' } });
  assert.strictEqual(badKey.status, 401);
  assert.strictEqual((await badKey.json()).message, 'Invalid API key');
  assert.strictEqual((await t.fetch(url('apikey=ANON'), { headers: { Authorization: 'Bearer TOK_B' } })).status, 200);
  const lax = mk({ requireApiKey: false });
  assert.strictEqual((await lax.fetch(url(), { headers: { Authorization: 'Bearer TOK_B' } })).status, 200);
});

// ------------------------------------------------------ failure injection
test('fail 5xx-before: 503 with a text body, nothing applied', async () => {
  const t = mk();
  t.control.fail({ method: 'PATCH', week: '2026-10-05', kind: '5xx-before' });
  const r = await patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { version: 4 }, 'TOK_A', REP);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.headers.get('content-type'), 'text/plain');
  assert.ok((await r.clone().text()).length > 0);
  await assert.rejects(r.json(), SyntaxError);
  assert.strictEqual(t.get('2026-10-05').version, 3);
  assert.deepStrictEqual([t.log[0].status, t.log[0].applied, t.log[0].injected], [503, false, '5xx-before']);
});

test('fail 5xx-after: the write IS applied, then 504 (or the chosen 502) with a text body', async () => {
  const t = mk();
  t.control.fail({ method: 'PATCH', week: '2026-10-05', kind: '5xx-after' });
  const r = await patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { version: 4 }, 'TOK_A', REP);
  assert.strictEqual(r.status, 504);
  assert.ok(/Gateway Time-out/.test(await r.text()));
  assert.strictEqual(t.get('2026-10-05').version, 4);
  assert.deepStrictEqual([t.log[0].status, t.log[0].applied], [504, true]);
  t.control.fail({ method: 'POST', kind: '5xx-after', status: 502 });
  const r2 = await post(t, { week_monday: '2026-10-19', data: { x: 1 } }, { headers: REP });
  assert.strictEqual(r2.status, 502);
  assert.strictEqual(await r2.text(), 'error code: 502');
  assert.deepStrictEqual(t.get('2026-10-19').data, { x: 1 });
  // the client's retry of the insert now 409s against its own committed row
  await expectErr(post(t, { week_monday: '2026-10-19', data: { x: 1 } }), 409, '23505');
});

test('fail throw: rejects TypeError("Failed to fetch"), nothing applied', async () => {
  const t = mk();
  t.control.fail({ method: 'PATCH', week: '2026-10-05', kind: 'throw' });
  await assert.rejects(patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { version: 4 }), e => e instanceof TypeError && e.message === 'Failed to fetch');
  assert.strictEqual(t.get('2026-10-05').version, 3);
  assert.deepStrictEqual([t.log[0].status, t.log[0].applied, t.log[0].error], [0, false, 'TypeError: Failed to fetch']);
  assert.strictEqual((await patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { version: 4 })).status, 204); // count 1 used up
});

test('fail throw-after: the write is applied, then the fetch rejects', async () => {
  const t = mk();
  t.control.fail({ method: 'DELETE', week: '2026-10-12', kind: 'throw-after' });
  await assert.rejects(remove(t, 'week_monday=eq.2026-10-12'), e => e instanceof TypeError && e.message === 'Failed to fetch');
  assert.strictEqual(t.get('2026-10-12'), null);
  assert.deepStrictEqual([t.log[0].status, t.log[0].applied], [0, true]);
});

test('fail 409 / 401 / 403 / 400: canned status + PostgREST-shaped JSON body, nothing applied', async () => {
  const want = { 409: '23505', 401: 'PGRST303', 403: '42501', 400: 'PGRST100' };
  for (const kind of ['409', '401', '403', '400']) {
    const t = mk();
    t.control.fail({ method: 'PATCH', kind });
    const b = await expectErr(patch(t, 'week_monday=eq.2026-10-05', { version: 9 }, 'TOK_A', REP), Number(kind), want[kind]);
    assert.deepStrictEqual(Object.keys(b), ['code', 'details', 'hint', 'message']);
    assert.strictEqual(t.get('2026-10-05').version, 3);
    assert.deepStrictEqual([t.log[0].applied, t.log[0].injected], [false, kind]);
  }
});

test('fail matching: method, week (URL or POST body), count, any-method rules, unknown kind', async () => {
  const t = mk();
  const rule = t.control.fail({ method: 'GET', kind: '5xx-before', count: 2 });
  assert.strictEqual((await get(t, '')).status, 503);
  assert.strictEqual((await get(t, '')).status, 503);
  assert.strictEqual((await get(t, '')).status, 200);
  assert.deepStrictEqual([rule.hits, rule.remaining], [2, 0]);
  t.control.fail({ method: 'PATCH', week: '2026-10-12', kind: '403' });
  t.control.fail({ method: 'DELETE', week: '2026-10-05', kind: '403' });
  assert.strictEqual((await patch(t, 'week_monday=eq.2026-10-05', { version: 4 })).status, 204);
  assert.strictEqual((await patch(t, 'week_monday=in.%282026-09-28%2C2026-10-12%29', { version: 4 })).status, 403);
  t.control.fail({ method: 'post', week: '2026-10-19', kind: 'throw' });
  assert.strictEqual((await post(t, { week_monday: '2026-10-26', data: {} })).status, 201);
  await assert.rejects(post(t, { week_monday: '2026-10-19', data: {} }), TypeError);
  assert.strictEqual(t.get('2026-10-19'), null);
  assert.strictEqual((await post(t, { week_monday: '2026-10-19', data: {} })).status, 201);
  t.control.fail({ kind: '400', count: Infinity });
  assert.strictEqual((await get(t, '')).status, 400);
  assert.strictEqual((await remove(t, 'week_monday=eq.2026-10-12')).status, 400);
  assert.throws(() => t.control.fail({ kind: '418' }), /unknown kind/);
});

// ---------------------------------------------------------------- pause
test('pause/release: a held CAS PATCH is overtaken by a later one and then loses (200 [])', async () => {
  const t = mk();
  const h = t.control.pause({ method: 'PATCH', week: '2026-10-05', count: 1 });
  let aDone = false;
  const pA = patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { data: { by: 'A' }, version: 4 }, 'TOK_A', REP).then(r => { aDone = true; return r; });
  const arrived = await h.arrived;
  assert.strictEqual(arrived, t.log[0]);
  assert.strictEqual(h.held, 1);
  const rB = await patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { data: { by: 'B' }, version: 4 }, 'TOK_B', REP);
  assert.strictEqual((await rB.json()).length, 1);
  await flush();
  assert.strictEqual(aDone, false);
  assert.strictEqual(t.log[0].status, null);
  h.release();
  await h.released;
  const rA = await pA;
  assert.strictEqual(rA.status, 200);
  assert.deepStrictEqual(await rA.json(), []);
  assert.deepStrictEqual(t.get('2026-10-05').data, { by: 'B' });
  assert.deepStrictEqual(t.log.map(e => [e.user, e.applied]), [['user-a', false], ['user-b', true]]);
});

test('pause/release: every matching request is held, nothing applied, then they resume in arrival order', async () => {
  const t = mk();
  const h = t.control.pause({ method: 'PATCH', week: '2026-10-05' });
  const pA = patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { data: { by: 'A' }, version: 4 }, 'TOK_A', REP);
  const pB = patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { data: { by: 'B' }, version: 4 }, 'TOK_B', REP);
  await h.arrived;
  await flush();
  assert.strictEqual(h.held, 2);
  assert.strictEqual(t.get('2026-10-05').version, 3);
  assert.strictEqual((await get(t, 'week_monday=eq.2026-10-05')).status, 200); // other methods flow
  h.release();
  const [rA, rB] = await Promise.all([pA, pB]);
  assert.strictEqual((await rA.json()).length, 1);
  assert.deepStrictEqual(await rB.json(), []);
  assert.deepStrictEqual(t.get('2026-10-05').data, { by: 'A' });
  // after release the pause no longer matches
  assert.strictEqual((await patch(t, 'week_monday=eq.2026-10-05', { version: 5 })).status, 204);
});

test('pause when=after: the write is applied while the response is still held', async () => {
  const t = mk();
  const h = t.control.pause({ method: 'PATCH', week: '2026-10-05', when: 'after' });
  let done = false;
  const pA = patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { version: 4 }, 'TOK_A', REP).then(r => { done = true; return r; });
  await h.arrived;
  assert.strictEqual(t.get('2026-10-05').version, 4);
  assert.deepStrictEqual(await json(get(t, 'select=version&week_monday=eq.2026-10-05', 'TOK_B')), [{ version: 4 }]);
  assert.strictEqual(done, false);
  assert.deepStrictEqual([t.log[0].applied, t.log[0].status], [true, null]);
  h.release();
  const rA = await pA;
  assert.strictEqual(rA.status, 200);
  assert.strictEqual((await rA.json())[0].version, 4);
});

test('AbortSignal: pre-aborted and aborted-while-held requests reject AbortError and apply nothing', async () => {
  const t = mk();
  const ac = new AbortController();
  ac.abort();
  const send = signal => t.fetch(url('week_monday=eq.2026-10-05'), { method: 'PATCH', headers: H('TOK_A'), body: '{"version":99}', signal });
  await assert.rejects(send(ac.signal), e => e.name === 'AbortError');
  const h = t.control.pause({ method: 'PATCH' });
  const ac2 = new AbortController();
  const p = send(ac2.signal);
  await h.arrived;
  ac2.abort();
  await assert.rejects(p, e => e.name === 'AbortError');
  h.release();
  await flush();
  assert.strictEqual(t.get('2026-10-05').version, 3);
  assert.deepStrictEqual(t.log.map(e => [e.status, e.error, e.applied]), [[0, 'AbortError', false], [0, 'AbortError', false]]);
});

// ----------------------------------------------------------------- jsonb
test('jsonb: data returns with keys in jsonb order, recursively; JSON.stringify differs, content is equal; arrays keep order', async () => {
  const t = mk();
  const mine = { zebra: 1, b: { yy: [{ c: 1, a: 2 }], x: null }, aa: 's', list: [3, 1, 2] };
  const back = (await json(patch(t, 'week_monday=eq.2026-10-05', { data: mine }, 'TOK_A', REP)))[0].data;
  assert.notStrictEqual(JSON.stringify(back), JSON.stringify(mine));
  assert.deepStrictEqual(back, mine); // key order is ignored by deepStrictEqual
  assert.deepStrictEqual(Object.keys(back), ['b', 'aa', 'list', 'zebra']);
  assert.deepStrictEqual(Object.keys(back.b), ['x', 'yy']);
  assert.deepStrictEqual(Object.keys(back.b.yy[0]), ['a', 'c']);
  assert.deepStrictEqual(back.list, [3, 1, 2]);
  const viaGet = (await json(get(t, 'select=data&week_monday=eq.2026-10-05')))[0].data;
  assert.strictEqual(JSON.stringify(viaGet), JSON.stringify(back));
  assert.strictEqual(JSON.stringify(t.get('2026-10-05').data), JSON.stringify(back));
  // the seeded rows were normalized too
  assert.strictEqual(JSON.stringify((await json(get(t, 'select=data&week_monday=eq.2026-09-28')))[0].data), '{"days":[1,2]}');
});

test('jsonb: order is UTF-8 byte length then bytes; text() shows jsonb spacing; \\u0000 rejected', async () => {
  const t = mk();
  const data = { 'é': 1, ab: 2, z: 3, B: 4, 10: 5, 9: 6 };
  const r = await patch(t, 'week_monday=eq.2026-10-05&select=data', { data }, 'TOK_A', REP);
  const text = await r.text();
  assert.strictEqual(text, '[{"data":{"9": 6, "B": 4, "z": 3, "10": 5, "ab": 2, "é": 1}}]');
  assert.deepStrictEqual(Object.keys(JSON.parse(text)[0].data), ['9', '10', 'B', 'z', 'ab', 'é']); // JS hoists integer keys
  await expectErr(patch(t, 'week_monday=eq.2026-10-05', { data: { s: 'a\u0000b' } }), 400, '22P05');
});

test('stored data is a deep copy: no aliasing through seed rows, put(), get(), rows() or responses', async () => {
  const s = seed();
  const t = mk({ rows: s });
  s[0].data.zeta = 42;
  assert.strictEqual(t.get('2026-10-05').data.zeta, 1);
  const g = t.get('2026-10-05');
  g.data.zeta = 999;
  t.rows()[0].data.days.push(9);
  assert.strictEqual(t.get('2026-10-05').data.zeta, 1);
  assert.deepStrictEqual(t.get('2026-09-28').data.days, [1, 2]);
  const obj = { week_monday: '2026-11-02', data: { n: [1] } };
  t.put(obj);
  obj.data.n.push(2);
  assert.deepStrictEqual(t.get('2026-11-02').data.n, [1]);
  const a = await json(get(t, 'week_monday=eq.2026-11-02'));
  a[0].data.n.push(3);
  assert.deepStrictEqual((await json(get(t, 'week_monday=eq.2026-11-02')))[0].data.n, [1]);
  // one PATCH body applied to several rows -> independent copies
  await patch(t, 'week_monday=in.(2026-09-28,2026-10-12)', { data: { shared: [1] } });
  t.put({ week_monday: '2026-09-28', data: { shared: [1, 2] } });
  assert.deepStrictEqual(t.get('2026-10-12').data, { shared: [1] });
});

// ------------------------------------------------------------ timestamps
test('timestamptz: updated_at comes back as +00:00 with trimmed micros; offsets converted; bad input 22007; opt-out', async () => {
  const t = mk();
  const at = async v => (await json(patch(t, 'week_monday=eq.2026-10-05&select=updated_at', { updated_at: v }, 'TOK_A', REP)))[0].updated_at;
  assert.strictEqual(await at('2026-10-11T12:34:56.120Z'), '2026-10-11T12:34:56.12+00:00');
  assert.strictEqual(await at('2026-10-11T12:00:00.000Z'), '2026-10-11T12:00:00+00:00');
  assert.strictEqual(await at('2026-10-11T07:00:00-05:00'), '2026-10-11T12:00:00+00:00');
  assert.strictEqual(await at('2026-10-11 12:00:00.1234567+00'), '2026-10-11T12:00:00.123457+00:00');
  assert.strictEqual(await at(null), null);
  await expectErr(patch(t, 'week_monday=eq.2026-10-05', { updated_at: 'yesterday' }), 400, '22007');
  const raw = mk({ timestamptz: false });
  const r = await json(patch(raw, 'week_monday=eq.2026-10-05&select=updated_at', { updated_at: '2026-10-11T12:34:56.120Z' }, 'TOK_A', REP));
  assert.strictEqual(r[0].updated_at, '2026-10-11T12:34:56.120Z');
  assert.strictEqual(raw.get('2026-09-28').updated_at, '2026-09-27T08:00:00.000Z');
});

// ------------------------------------------------------------------- log
test('log: one entry per request with method, url, parsed query, lower-cased headers, parsed body, status, applied', async () => {
  const t = mk();
  await patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { data: { a: 1 }, version: 4 }, 'TOK_A', REP);
  await patch(t, 'week_monday=eq.2026-10-05&version=eq.3', { version: 5 });
  await get(t, 'select=week_monday%2Cversion&week_monday=in.%282026-10-05%2C2026-10-12%29', null);
  assert.strictEqual(t.log.length, 3);
  const e = t.log[0];
  assert.strictEqual(e.method, 'PATCH');
  assert.strictEqual(e.url, T + '?week_monday=eq.2026-10-05&version=eq.3');
  assert.deepStrictEqual(e.query, { week_monday: 'eq.2026-10-05', version: 'eq.3' });
  assert.deepStrictEqual(Object.keys(e.headers).sort(), ['apikey', 'authorization', 'content-type', 'prefer']);
  assert.strictEqual(e.headers.authorization, 'Bearer TOK_A');
  assert.strictEqual(e.headers.prefer, 'return=representation');
  assert.deepStrictEqual(e.body, { data: { a: 1 }, version: 4 });
  assert.deepStrictEqual([e.status, e.applied, e.user, e.role, e.injected, e.seq], [200, true, 'user-a', 'authenticated', null, 1]);
  assert.deepStrictEqual([t.log[1].status, t.log[1].applied], [204, false]);
  const g = t.log[2];
  assert.deepStrictEqual(g.query, { select: 'week_monday,version', week_monday: 'in.(2026-10-05,2026-10-12)' });
  assert.deepStrictEqual([g.method, g.body, g.status, g.applied, g.role], ['GET', undefined, 200, false, 'anon']);
  // repeated query keys become an array; Headers-like and array-of-pairs inits are normalized
  await t.fetch(url('week_monday=gte.2026-10-01&week_monday=lte.2026-10-10'), { headers: [['APIKEY', 'ANON'], ['X-Trace', '1']] });
  assert.deepStrictEqual(t.log[3].query, { week_monday: ['gte.2026-10-01', 'lte.2026-10-10'] });
  assert.deepStrictEqual(t.log[3].headers, { apikey: 'ANON', 'x-trace': '1' });
  assert.strictEqual(t.log[3].status, 200);
});

// ------------------------------------------------------------ fetch realism
test('fetch realism: "patch" (lower-case), PUT, HEAD, unknown path -> 400; GET with body rejects; body readable once; clone()', async () => {
  const t = mk();
  const lower = await expectErr(t.fetch(url('week_monday=eq.2026-10-05'), { method: 'patch', headers: H('TOK_A'), body: '{"version":9}' }), 400, 'PGRST117');
  assert.ok(/patch/.test(lower.message));
  await expectErr(t.fetch(url('week_monday=eq.2026-10-05'), { method: 'PUT', headers: H('TOK_A'), body: '{"version":9}' }), 400);
  assert.strictEqual((await t.fetch(url(), { method: 'head', headers: H('TOK_A') })).status, 400);
  assert.strictEqual(t.log[2].method, 'HEAD');
  await expectErr(t.fetch(BASE + '/rest/v1/other_table', { headers: H('TOK_A') }), 400);
  assert.strictEqual(t.get('2026-10-05').version, 3);
  await assert.rejects(t.fetch(url(), { headers: H('TOK_A'), body: '{}' }), TypeError);
  const r = await get(t, '');
  assert.strictEqual(r.bodyUsed, false);
  const c = r.clone();
  await r.json();
  assert.strictEqual(r.bodyUsed, true);
  await assert.rejects(r.text(), TypeError);
  assert.throws(() => r.clone(), TypeError);
  assert.strictEqual((await c.json()).length, 3);
  // a Request-like first argument
  assert.strictEqual((await t.fetch({ url: url('week_monday=eq.2026-10-05'), method: 'GET', headers: H('TOK_A') })).status, 200);
});

// ------------------------------------------------------------- backdoors
test('backdoors: rows() sorted deep copy; get() null when missing; put() merges without checks; del()', async () => {
  const t = mk();
  assert.deepStrictEqual(t.rows().map(r => r.week_monday), ['2026-09-28', '2026-10-05', '2026-10-12']);
  assert.strictEqual(t.get('2030-01-07'), null);
  t.put({ week_monday: '2026-10-05', version: 10 });
  assert.deepStrictEqual(t.get('2026-10-05'), { week_monday: '2026-10-05', data: { a: 2, zeta: 1 }, version: 10, updated_by: 'user-a', updated_at: '2026-10-01T08:00:00+00:00' });
  t.put({ week_monday: '2026-10-19' });
  assert.deepStrictEqual(t.get('2026-10-19'), { week_monday: '2026-10-19', data: {}, version: 1, updated_by: null, updated_at: CLOCK_PG });
  t.put({ week_monday: '2026-10-26', version: 'not-a-number' }); // no checks
  assert.strictEqual(t.get('2026-10-26').version, 'not-a-number');
  assert.strictEqual(t.del('2026-10-26'), true);
  assert.strictEqual(t.del('2026-10-26'), false);
  assert.strictEqual(t.rows().length, 4);
  assert.strictEqual(t.log.length, 0); // backdoors are not requests
});

test('control.clear(): drops fail rules, releases held requests, empties expiredTokens', async () => {
  const t = mk();
  t.control.fail({ kind: '5xx-before', count: Infinity });
  t.control.expiredTokens.add('TOK_A');
  const h = t.control.pause({ method: 'PATCH' });
  const held = patch(t, 'week_monday=eq.2026-10-05', { version: 4 }, 'TOK_B');
  await h.arrived;
  t.control.clear();
  assert.strictEqual(t.control.rules.length, 0);
  assert.strictEqual(t.control.expiredTokens.size, 0);
  await h.released;
  assert.strictEqual((await held).status, 503); // its rule was claimed on arrival
  assert.strictEqual((await get(t, '')).status, 200);
  assert.strictEqual((await patch(t, 'week_monday=eq.2026-10-05', { version: 4 })).status, 204);
});

// ---------------------------------------------------------------- runner
(async () => {
  process.exitCode = 1; // stays 1 if a hung promise lets the loop drain early
  let passed = 0;
  const failed = [];
  for (const tc of tests) {
    let timer;
    try {
      await Promise.race([
        tc.fn(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out (hung promise?)')), 3000); }),
      ]);
      passed++;
      console.log('ok   ' + tc.name);
    } catch (e) {
      failed.push(tc.name);
      console.log('FAIL ' + tc.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
    } finally {
      clearTimeout(timer);
    }
  }
  console.log('\n' + passed + '/' + tests.length + ' tests passed');
  process.exitCode = failed.length ? 1 : 0;
})();

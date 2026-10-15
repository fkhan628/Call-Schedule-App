/*
 * fake-weeks-table.js
 *
 * In-memory emulation of the Supabase PostgREST endpoint for ONE table,
 * public.schedule_weeks, for exercising a client sync engine.
 *
 * Plain ES2017, no dependencies, and no host APIs (no URL, URLSearchParams,
 * TextEncoder, setTimeout, structuredClone, Headers, Response): it runs in a
 * bare Node `vm` context and in a browser page alike.
 *
 *   const t = createFakeWeeksTable({ baseUrl, anonKey, users, rows, clock });
 *   t.fetch(url, init)  -> Promise<Response-like>
 *   t.rows() / t.get(k) / t.put(row) / t.del(k)   (test backdoors)
 *   t.control  -> fail(), pause(), expiredTokens, users, clear()
 *   t.log      -> one entry per request
 *   t.oldBuild(token, by) / t.recreate(token, k, data, o)  (other clients, through fetch)
 *
 * Realism beyond the basic contract (each mirrors real Supabase/PostgREST/fetch
 * behaviour a sync engine can trip over):
 *   - jsonb `data` comes back with keys in jsonb order (byte length, then bytes).
 *   - updated_at is a timestamptz: returned as "YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00"
 *     (opts.timestamptz === false stores/returns the raw string instead).
 *   - Rows are kept in "heap" order: an UPDATE moves the row to the end, so an
 *     un-ordered GET does not return PK order.
 *   - fetch() only upper-cases DELETE/GET/HEAD/OPTIONS/POST/PUT, so method
 *     "patch" stays lower-case and is rejected (400).
 *   - A string body with no Content-Type is sent as text/plain -> 415.
 *   - UPDATE/DELETE without a filter -> 400 21000 (Supabase's pg-safeupdate).
 *   - A '+' in an un-encoded query string decodes to a space.
 *   - The apikey header (or ?apikey=) is required and must equal anonKey
 *     (opts.requireApiKey === false disables the check).
 *   - A response body can be read once (second text()/json() rejects).
 *   - opts.stampUpdatedAt: the SERVER renders updated_at on every INSERT /
 *     UPDATE (an `updated_at := now()` trigger, from opts.clock), whatever the
 *     body says — so a client can only learn the stored value from a response
 *     or a read. Off by default (the live table stores the client's value).
 *
 * Failure kinds (control.fail): 5xx before / after commit, thrown before /
 * after commit, 409 (23505), 401, 403 (42501), 400 (PGRST100), a gateway's
 * HTML 403, 429 / 408 / 413 (plain text), 400 PGRST204 and 22P02, 404
 * PGRST205 (the table missing from the schema cache), and never-settling
 * requests: 'hang' (nothing applied) and 'hang-after' (applied, the response
 * never comes) — an AbortSignal still rejects them, as with a real fetch.
 *
 * Mixed fleet (design §2.11) — other clients, through fetch() like any request
 * (logged; auth, RLS and failure rules apply): t.oldBuild(token, by).upsert()
 * is an old build's keepalive, a version-PRESERVING merge-duplicates upsert,
 * and .remove(k) its unversioned DELETE; t.recreate(token, k, data) is a clear
 * + regenerate elsewhere — DELETE, then INSERT at v1, so the version repeats
 * and only updated_at tells the rows apart (ABA).
 */
(function (root) {
  'use strict';

  const TABLE = 'schedule_weeks';
  const COLS = ['week_monday', 'data', 'version', 'updated_by', 'updated_at'];
  const RESERVED_PARAMS = ['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'apikey'];
  const FAIL_KINDS = ['5xx-before', '5xx-after', 'throw', 'throw-after', '409', '401', '403', '400', 'html-403', '429', '408', '413', '400-schema', '400-22P02', '404-PGRST205', 'hang', 'hang-after'];
  const BEFORE_KINDS = ['5xx-before', 'throw', '409', '401', '403', '400', 'html-403', '429', '408', '413', '400-schema', '400-22P02', '404-PGRST205', 'hang'];
  const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
    403: 'Forbidden', 404: 'Not Found', 406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict', 413: 'Payload Too Large', 429: 'Too Many Requests',
    415: 'Unsupported Media Type', 500: 'Internal Server Error', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  const JSON_CT = 'application/json; charset=utf-8';
  const CMP_OPS = {
    eq: c => c === 0, neq: c => c !== 0, gt: c => c > 0, gte: c => c >= 0, lt: c => c < 0, lte: c => c <= 0,
  };

  // ------------------------------------------------------------------ utils
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function setOwn(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }
  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function first(v) { return Array.isArray(v) ? v[0] : v; }
  function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise: promise, resolve: resolve };
  }
  function daysInMonth(y, m) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  // ------------------------------------------------------- results / errors
  function jsonResult(status, text, extraHeaders) {
    return { status: status, text: text, headers: Object.assign({ 'content-type': JSON_CT }, extraHeaders || {}) };
  }
  function emptyResult(status, extraHeaders) {
    return { status: status, text: null, headers: Object.assign({}, extraHeaders || {}) };
  }
  function pgBody(code, message, details, hint) {
    return JSON.stringify({
      code: code,
      details: details === undefined ? null : details,
      hint: hint === undefined ? null : hint,
      message: message,
    });
  }
  // A thrown PgError carries the HTTP result PostgREST would send.
  function PgError(status, code, message, details, hint, extraHeaders) {
    const e = new Error(message);
    e.pgResult = jsonResult(status, pgBody(code, message, details, hint), extraHeaders);
    return e;
  }
  function jwtError(code, message) {
    return PgError(401, code, message, null, null, {
      'www-authenticate': 'Bearer error="invalid_token", error_description="' + message + '"',
    });
  }
  function dupKeyError(key) {
    return PgError(409, '23505', 'duplicate key value violates unique constraint "' + TABLE + '_pkey"',
      'Key (week_monday)=(' + key + ') already exists.');
  }
  function notNullError(col) {
    return PgError(400, '23502', 'null value in column "' + col + '" of relation "' + TABLE + '" violates not-null constraint');
  }
  function unknownColumn(name) {
    return PgError(400, '42703', 'column ' + TABLE + '.' + name + ' does not exist');
  }
  function unsupported(what) {
    return PgError(400, 'PGRST100', 'fake-weeks-table: ' + what + ' is not emulated');
  }
  function gatewayResult(status) {
    const bodies = {
      502: 'error code: 502',
      503: 'upstream connect error or disconnect/reset before headers. reset reason: connection termination',
      504: '<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n<center><h1>504 Gateway Time-out</h1></center>\r\n</body>\r\n</html>\r\n',
    };
    const text = bodies[status] || (status + ' ' + (STATUS_TEXT[status] || 'Error'));
    return { status: status, text: text, headers: { 'content-type': status === 504 ? 'text/html' : 'text/plain' } };
  }
  function abortError(signal) {
    if (signal && signal.reason !== undefined) return signal.reason;
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    return e;
  }
  // A request that never answers (a dead radio, a proxy that holds the
  // connection): never settles — except that an AbortSignal rejects it, as it
  // does a real fetch.
  function never(signal) {
    return new Promise((resolve, reject) => {
      if (!signal || typeof signal.addEventListener !== 'function') return;
      if (signal.aborted) { reject(abortError(signal)); return; }
      signal.addEventListener('abort', () => reject(abortError(signal)));
    });
  }

  // ------------------------------------------------------------------ jsonb
  function utf8Bytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  // Postgres jsonb object key order: shorter (UTF-8 byte length) first, then memcmp.
  function jsonbKeyCompare(a, b) {
    const x = utf8Bytes(a), y = utf8Bytes(b);
    if (x.length !== y.length) return x.length - y.length;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }
  function nulError() {
    return PgError(400, '22P05', 'unsupported Unicode escape sequence', '\\u0000 cannot be converted to text.');
  }
  // Deep copy into canonical jsonb form (keys inserted in jsonb order).
  function toJsonb(v) {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'string') { if (v.indexOf('\u0000') !== -1) throw nulError(); return v; }
    if (t === 'number') return isFinite(v) ? v : null;
    if (t === 'boolean') return v;
    if (Array.isArray(v)) return v.map(x => (x === undefined || typeof x === 'function') ? null : toJsonb(x));
    if (t === 'object') {
      const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function');
      keys.sort(jsonbKeyCompare);
      const out = {};
      for (const k of keys) {
        if (k.indexOf('\u0000') !== -1) throw nulError();
        setOwn(out, k, toJsonb(v[k]));
      }
      return out;
    }
    return null;
  }
  // jsonb text output: `{"a": 1, "bb": [1, 2]}`; keys sorted at print time so
  // integer-like keys (which JS always enumerates first) still print in jsonb order.
  function jsonbText(v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return '[' + v.map(jsonbText).join(', ') + ']';
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort(jsonbKeyCompare);
      return '{' + keys.map(k => JSON.stringify(k) + ': ' + jsonbText(v[k])).join(', ') + '}';
    }
    return JSON.stringify(v);
  }

  // -------------------------------------------------------------- scalars
  function scalarText(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
  function coerceDate(v) {
    if (v === null || v === undefined) return null;
    const s = scalarText(v);
    const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(s);
    if (!m) throw PgError(400, '22007', 'invalid input syntax for type date: "' + s + '"');
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      throw PgError(400, '22008', 'date/time field value out of range: "' + s + '"');
    }
    return m[1] + '-' + m[2] + '-' + m[3];
  }
  function coerceInt(v) {
    if (v === null || v === undefined) return null;
    const s = scalarText(v);
    if (!/^\s*[+-]?\d+\s*$/.test(s)) throw PgError(400, '22P02', 'invalid input syntax for type integer: "' + s + '"');
    const n = parseInt(s, 10);
    if (n > 2147483647 || n < -2147483648) throw PgError(400, '22003', 'value "' + s.trim() + '" is out of range for type integer');
    return n;
  }
  function coerceText(v) {
    if (v === null || v === undefined) return null;
    return scalarText(v);
  }
  // Parse an ISO-ish timestamp and render it the way PostgREST renders a
  // timestamptz with TimeZone=UTC. Returns { value } or { code, message }.
  function parseTimestamptz(input) {
    const s = String(input);
    const bad = { code: '22007', message: 'invalid input syntax for type timestamp with time zone: "' + s + '"' };
    const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?\s*$/.exec(s);
    if (!m) return bad;
    const y = +m[1], mo = +m[2], d = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0), se = +(m[6] || 0);
    const fracDigits = m[7] || '';
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 24 || mi > 59 || se > 60 ||
        (h === 24 && (mi || se || /[1-9]/.test(fracDigits)))) {
      return { code: '22008', message: 'date/time field value out of range: "' + s + '"' };
    }
    let micro = fracDigits ? Math.round(+(fracDigits + '000000').slice(0, 7) / 10) : 0;
    let offMin = 0;
    const z = m[8];
    if (z && z !== 'Z' && z !== 'z') {
      const digs = z.slice(1).replace(':', '');
      offMin = (z.charAt(0) === '-' ? -1 : 1) * (+digs.slice(0, 2) * 60 + (digs.length > 2 ? +digs.slice(2, 4) : 0));
    }
    let ms = Date.UTC(y, mo - 1, d, h, mi, se) - offMin * 60000;
    if (micro >= 1000000) { ms += 1000; micro -= 1000000; }
    const iso = new Date(ms).toISOString();
    const frac = micro ? String(micro).padStart(6, '0').replace(/0+$/, '') : '';
    return { value: iso.slice(0, 19) + (frac ? '.' + frac : '') + '+00:00' };
  }

  // ------------------------------------------------------------ url / http
  function decodeComponent(s) {
    // PostgREST (wai) decodes '+' as a space in the query string.
    try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; }
  }
  function parseUrl(u) {
    let s = String(u);
    const hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash);
    const q = s.indexOf('?');
    const path = q >= 0 ? s.slice(0, q) : s;
    const qs = q >= 0 ? s.slice(q + 1) : '';
    const pairs = [];
    const query = {};
    if (qs) {
      for (const part of qs.split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const k = decodeComponent(eq >= 0 ? part.slice(0, eq) : part);
        const v = decodeComponent(eq >= 0 ? part.slice(eq + 1) : '');
        pairs.push([k, v]);
        if (hasOwn(query, k)) {
          if (Array.isArray(query[k])) query[k].push(v); else query[k] = [query[k], v];
        } else setOwn(query, k, v);
      }
    }
    return { path: path, pairs: pairs, query: query };
  }
  function normalizeHeaders(h) {
    const out = {};
    if (!h) return out;
    // Like fetch: names are case-insensitive, values are stringified (so an
    // `undefined` value really is sent as "undefined"), repeats are joined.
    const add = (k, v) => {
      const key = String(k).toLowerCase();
      const val = String(v);
      setOwn(out, key, hasOwn(out, key) ? out[key] + ', ' + val : val);
    };
    if (Array.isArray(h)) h.forEach(p => add(p[0], p[1]));
    else if (typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach((v, k) => add(k, v));
    else Object.keys(h).forEach(k => add(k, h[k]));
    return out;
  }
  function parsePrefer(v) {
    const out = {};
    String(v || '').split(',').forEach(tok => {
      tok = tok.trim();
      if (!tok) return;
      const i = tok.indexOf('=');
      if (i < 0) setOwn(out, tok, true); else setOwn(out, tok.slice(0, i).trim(), tok.slice(i + 1).trim());
    });
    return out;
  }
  function makeResponse(result, url) {
    const hdrs = {};
    Object.keys(result.headers || {}).forEach(k => setOwn(hdrs, k.toLowerCase(), String(result.headers[k])));
    const text = result.text === null || result.text === undefined ? '' : result.text;
    let used = false;
    const consume = () => {
      if (used) return new TypeError('Body is unusable: Body has already been read');
      used = true;
      return null;
    };
    const headers = {
      get(name) { const k = String(name).toLowerCase(); return hasOwn(hdrs, k) ? hdrs[k] : null; },
      has(name) { return hasOwn(hdrs, String(name).toLowerCase()); },
      forEach(cb, thisArg) { Object.keys(hdrs).sort().forEach(k => cb.call(thisArg, hdrs[k], k, headers)); },
    };
    return {
      ok: result.status >= 200 && result.status <= 299,
      status: result.status,
      statusText: STATUS_TEXT[result.status] || '',
      url: url,
      redirected: false,
      type: 'basic',
      headers: headers,
      get bodyUsed() { return used; },
      text() {
        const err = consume();
        return err ? Promise.reject(err) : Promise.resolve(text);
      },
      json() {
        const err = consume();
        if (err) return Promise.reject(err);
        return new Promise((resolve, reject) => {
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        });
      },
      clone() {
        if (used) throw new TypeError('Response.clone: Body has already been consumed.');
        return makeResponse(result, url);
      },
    };
  }

  // ----------------------------------------------------- query grammar
  function parseSelect(raw) {
    if (raw === undefined || raw === null || raw.trim() === '' || raw.trim() === '*') {
      return COLS.map(c => ({ name: c, alias: c }));
    }
    const out = [];
    for (let item of raw.split(',')) {
      item = item.trim();
      if (item === '*') { COLS.forEach(c => out.push({ name: c, alias: c })); continue; }
      let alias = null, name = item;
      const ci = item.indexOf(':');
      if (ci > 0 && item.charAt(ci + 1) !== ':') { alias = item.slice(0, ci).trim(); name = item.slice(ci + 1).trim(); }
      if (COLS.indexOf(name) < 0) throw unknownColumn(name);
      out.push({ name: name, alias: alias || name });
    }
    return out;
  }
  function parseNonNegInt(raw, what) {
    if (raw === undefined) return null;
    if (!/^\d+$/.test(raw)) throw PgError(400, 'PGRST100', '"failed to parse ' + what + ' parameter (' + raw + ')"');
    return parseInt(raw, 10);
  }
  function parseOrder(raw) {
    if (raw === undefined) return null;
    return raw.split(',').map(term => {
      const parts = term.trim().split('.');
      const col = parts[0];
      if (COLS.indexOf(col) < 0) throw unknownColumn(col);
      if (col === 'data') throw unsupported('ordering by data');
      let desc = false, nullsFirst = null;
      for (const p of parts.slice(1)) {
        if (p === 'asc') desc = false;
        else if (p === 'desc') desc = true;
        else if (p === 'nullsfirst') nullsFirst = true;
        else if (p === 'nullslast') nullsFirst = false;
        else throw PgError(400, 'PGRST100', '"failed to parse order (' + raw + ')"');
      }
      return { col: col, desc: desc, nullsFirst: nullsFirst === null ? desc : nullsFirst };
    });
  }
  function parseInList(arg) {
    if (arg.charAt(0) !== '(' || arg.charAt(arg.length - 1) !== ')') return null;
    const inner = arg.slice(1, -1);
    if (inner === '') return [];
    const out = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner.charAt(i);
      if (inQuote) {
        if (c === '\\' && i + 1 < inner.length) cur += inner.charAt(++i);
        else if (c === '"') inQuote = false;
        else cur += c;
      } else if (c === '"') inQuote = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  function compareCol(col, a, b) {
    if (col === 'version') return a - b;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function sortRows(rows, order) {
    return rows.slice().sort((a, b) => {
      for (const o of order) {
        const x = a[o.col], y = b[o.col];
        const xn = x === null || x === undefined, yn = y === null || y === undefined;
        if (xn || yn) {
          if (xn && yn) continue;
          return (xn ? -1 : 1) * (o.nullsFirst ? 1 : -1);
        }
        let c = compareCol(o.col, x, y);
        if (o.desc) c = -c;
        if (c) return c;
      }
      return 0;
    });
  }

  // ================================================================ factory
  function createFakeWeeksTable(opts) {
    opts = opts || {};
    const baseUrl = String(opts.baseUrl || 'https://x.supabase.co').replace(/\/+$/, '');
    const anonKey = opts.anonKey === undefined ? 'ANON' : String(opts.anonKey);
    const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date().toISOString();
    const requireApiKey = opts.requireApiKey !== false;
    const tsMode = opts.timestamptz !== false;
    const defaultVersion = opts.defaultVersion === undefined ? 1 : opts.defaultVersion;
    const stampUpdatedAt = opts.stampUpdatedAt === true;
    const tablePath = baseUrl + '/rest/v1/' + TABLE;

    let heap = [];          // physical ("heap") order; UPDATE moves a row to the end
    const log = [];
    let seq = 0;
    const failRules = [];
    const pauses = [];

    const control = {
      expiredTokens: new Set(),
      users: opts.users || {},
      rules: failRules,
      fail: fail,
      pause: pause,
      clear: clear,
    };

    // ------------------------------------------------------- column types
    function coerceTs(v) {
      if (v === null || v === undefined) return null;
      if (!tsMode) return scalarText(v);
      const r = parseTimestamptz(scalarText(v));
      if (r.code) throw PgError(400, r.code, r.message);
      return r.value;
    }
    function coerceCol(col, v) {
      switch (col) {
        case 'week_monday': return coerceDate(v);
        case 'version': return coerceInt(v);
        case 'data': return toJsonb(v);
        case 'updated_by': return coerceText(v);
        case 'updated_at': return coerceTs(v);
      }
      throw unknownColumn(col);
    }
    function coercePatch(obj) {
      const out = {};
      for (const k of Object.keys(obj)) {
        if (COLS.indexOf(k) < 0) {
          throw PgError(400, 'PGRST204', "Could not find the '" + k + "' column of '" + TABLE + "' in the schema cache");
        }
        setOwn(out, k, coerceCol(k, obj[k]));
      }
      return out;
    }
    function checkNotNull(row) {
      if (row.week_monday === null || row.week_monday === undefined) throw notNullError('week_monday');
      if (row.version === null || row.version === undefined) throw notNullError('version');
    }
    function lenientTs(v) {
      if (v === null || v === undefined) return null;
      if (!tsMode) return v;
      const r = parseTimestamptz(scalarText(v));
      return r.code ? v : r.value;
    }
    function defaultRow(ts) {
      return { week_monday: null, data: {}, version: defaultVersion, updated_by: null, updated_at: ts !== undefined ? ts : lenientTs(clock()) };
    }
    // opts.stampUpdatedAt: the trigger's `updated_at := now()` on a written row.
    function stamp() {
      return stampUpdatedAt ? { updated_at: lenientTs(clock()) } : {};
    }
    function cloneRow(r) {
      let data;
      try { data = toJsonb(r.data); } catch (e) { data = JSON.parse(JSON.stringify(r.data)); }
      return { week_monday: r.week_monday, data: data, version: r.version, updated_by: r.updated_by, updated_at: r.updated_at };
    }
    function findRow(key) {
      for (const r of heap) if (r.week_monday === key) return r;
      return null;
    }

    // ------------------------------------------------------------ filters
    function coerceFilterValue(col, s) {
      if (col === 'version') return coerceInt(s);
      if (col === 'week_monday') return coerceDate(s);
      if (col === 'updated_at') return coerceTs(s);
      return s;
    }
    function buildFilter(col, raw) {
      const parseErr = () => PgError(400, 'PGRST100', '"failed to parse filter (' + raw + ')" (line 1, column 1)');
      let rest = raw, neg = false;
      if (rest.slice(0, 4) === 'not.') { neg = true; rest = rest.slice(4); }
      const dot = rest.indexOf('.');
      if (dot < 0) throw parseErr();
      const op = rest.slice(0, dot), arg = rest.slice(dot + 1);
      if (op === 'is') {
        const a = arg.toLowerCase();
        let t;
        if (a === 'null') t = v => v === null || v === undefined;
        else if (a === 'not_null') t = v => !(v === null || v === undefined);
        else throw parseErr();
        return row => (neg ? !t(row[col]) : t(row[col])); // IS never yields NULL
      }
      let test;
      if (op === 'in') {
        const items = parseInList(arg);
        if (items === null) throw parseErr();
        const list = items.map(x => coerceFilterValue(col, x));
        test = v => list.some(x => compareCol(col, v, x) === 0);
      } else if (hasOwn(CMP_OPS, op)) {
        const x = coerceFilterValue(col, arg);
        test = v => CMP_OPS[op](compareCol(col, v, x));
      } else {
        throw parseErr();
      }
      // SQL three-valued logic: a comparison against NULL is never true, negated or not.
      return row => {
        const v = row[col];
        if (v === null || v === undefined) return false;
        return neg ? !test(v) : test(v);
      };
    }
    function parseFilters(pairs) {
      const out = [];
      for (const pair of pairs) {
        const k = pair[0], v = pair[1];
        if (RESERVED_PARAMS.indexOf(k) >= 0) continue;
        if (k === 'or' || k === 'and' || k === 'not.or' || k === 'not.and') throw unsupported('logical operator "' + k + '"');
        if (COLS.indexOf(k) < 0) throw unknownColumn(k);
        if (k === 'data') throw unsupported('filtering on data');
        out.push(buildFilter(k, v));
      }
      return out;
    }
    function matchAll(filters, row) {
      for (const f of filters) if (!f(row)) return false;
      return true;
    }

    // ------------------------------------------------------ serialization
    function rowText(row, sel) {
      return '{' + sel.map(c => {
        const v = row[c.name];
        return JSON.stringify(c.alias) + ':' + (c.name === 'data' ? jsonbText(v) : JSON.stringify(v === undefined ? null : v));
      }).join(',') + '}';
    }
    function rowsText(rows, sel) {
      return '[' + rows.map(r => rowText(r, sel)).join(',') + ']';
    }
    function wantsRepresentation(prefer) { return prefer['return'] === 'representation'; }

    // ------------------------------------------------------------- auth
    function authenticate(headers) {
      let token = null;
      if (hasOwn(headers, 'authorization')) {
        const m = /^\s*bearer\s+(\S+)\s*$/i.exec(headers.authorization);
        if (m) token = m[1];
      }
      if (token === null) return { role: 'anon', user: null };
      if (control.expiredTokens.has(token)) throw jwtError('PGRST303', 'JWT expired');
      if (hasOwn(control.users, token)) return { role: 'authenticated', user: control.users[token] };
      if (token === anonKey) return { role: 'anon', user: null };
      throw jwtError('PGRST301', 'JWSError JWSInvalidSignature');
    }
    function requireJsonBody(ctx) {
      const ct = hasOwn(ctx.headers, 'content-type') ? ctx.headers['content-type']
        : (ctx.rawBody !== null ? 'text/plain;charset=UTF-8' : null);
      if (ct !== null && !/^\s*application\/json\s*(;|$)/i.test(ct)) {
        throw PgError(415, 'PGRST107', 'Content-Type not acceptable: ' + ct);
      }
      if (ctx.rawBody === null || ctx.rawBody.trim() === '' || !ctx.bodyOk) {
        throw PgError(400, 'PGRST102', 'Empty or invalid json');
      }
      return ctx.body;
    }

    // ---------------------------------------------------------- methods
    function doGet(ctx) {
      const q = ctx.p.query;
      const sel = parseSelect(first(q.select));
      const filters = parseFilters(ctx.p.pairs);
      const order = parseOrder(first(q.order));
      const limit = parseNonNegInt(first(q.limit), 'limit');
      const offset = parseNonNegInt(first(q.offset), 'offset') || 0;
      let rows = heap.filter(r => matchAll(filters, r)); // SELECT policy: everyone
      const total = rows.length;
      if (order) rows = sortRows(rows, order);
      rows = rows.slice(offset, limit === null ? undefined : offset + limit);
      const prefer = parsePrefer(ctx.headers.prefer);
      const totalStr = prefer.count === 'exact' ? String(total) : '*';
      const range = rows.length ? offset + '-' + (offset + rows.length - 1) + '/' + totalStr : '*/' + totalStr;
      const accept = ctx.headers.accept || '';
      if (/application\/vnd\.pgrst\.object\+json/i.test(accept)) {
        if (rows.length !== 1) {
          throw PgError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned',
            'The result contains ' + rows.length + ' rows');
        }
        return jsonResult(200, rowText(rows[0], sel), { 'content-range': range });
      }
      return jsonResult(200, rowsText(rows, sel), { 'content-range': range });
    }

    function doPatch(ctx, auth) {
      const q = ctx.p.query;
      const prefer = parsePrefer(ctx.headers.prefer);
      const sel = parseSelect(first(q.select));
      const filters = parseFilters(ctx.p.pairs);
      const body = requireJsonBody(ctx);
      if (!isPlainObject(body)) throw PgError(400, 'PGRST102', 'Empty or invalid json');
      const patch = coercePatch(body);
      if (!filters.length) throw PgError(400, '21000', 'UPDATE requires a WHERE clause');
      // RLS: the UPDATE policy's USING clause hides every row from anon.
      const visible = auth.role === 'anon' ? [] : heap;
      const matched = visible.filter(r => matchAll(filters, r));
      const updated = matched.map(r => Object.assign({}, r, patch, stamp()));
      updated.forEach(checkNotNull);
      const seen = {};
      for (const u of updated) {
        const clash = heap.some(r => matched.indexOf(r) < 0 && r.week_monday === u.week_monday);
        if (clash || hasOwn(seen, u.week_monday)) throw dupKeyError(u.week_monday);
        setOwn(seen, u.week_monday, true);
      }
      const stored = updated.map(cloneRow);
      heap = heap.filter(r => matched.indexOf(r) < 0).concat(stored);
      ctx.entry.applied = stored.length > 0;
      if (wantsRepresentation(prefer)) return jsonResult(200, rowsText(stored, sel));
      return emptyResult(204);
    }

    function doDelete(ctx, auth) {
      const q = ctx.p.query;
      const prefer = parsePrefer(ctx.headers.prefer);
      const sel = parseSelect(first(q.select));
      const filters = parseFilters(ctx.p.pairs);
      if (!filters.length) throw PgError(400, '21000', 'DELETE requires a WHERE clause');
      const visible = auth.role === 'anon' ? [] : heap;
      const matched = visible.filter(r => matchAll(filters, r));
      heap = heap.filter(r => matched.indexOf(r) < 0);
      ctx.entry.applied = matched.length > 0;
      if (wantsRepresentation(prefer)) return jsonResult(200, rowsText(matched, sel));
      return emptyResult(204);
    }

    function doPost(ctx, auth) {
      const q = ctx.p.query;
      const prefer = parsePrefer(ctx.headers.prefer);
      const sel = parseSelect(first(q.select));
      if (hasOwn(q, 'columns')) throw unsupported('the columns= parameter');
      const body = requireJsonBody(ctx);
      const items = Array.isArray(body) ? body : [body];
      if (!items.every(isPlainObject)) throw PgError(400, 'PGRST102', 'Empty or invalid json');
      if (items.length > 1) {
        const k0 = Object.keys(items[0]).sort().join(',');
        if (!items.every(o => Object.keys(o).sort().join(',') === k0)) {
          throw PgError(400, 'PGRST102', 'All object keys must match');
        }
      }
      const resolution = prefer.resolution === 'merge-duplicates' || prefer.resolution === 'ignore-duplicates'
        ? prefer.resolution : null;
      if (resolution && hasOwn(q, 'on_conflict')) {
        const oc = String(first(q.on_conflict)).split(',').map(s => s.trim()).join(',');
        if (oc !== 'week_monday') {
          throw PgError(400, '42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
        }
      }
      const patches = items.map(coercePatch);
      if (auth.role === 'anon') {
        throw PgError(401, '42501', 'new row violates row-level security policy for table "' + TABLE + '"');
      }
      const ops = [];
      const seen = {};
      for (const pt of patches) {
        const key = hasOwn(pt, 'week_monday') ? pt.week_monday : null;
        if (key === null) throw notNullError('week_monday');
        if (hasOwn(seen, key)) {
          if (resolution === 'merge-duplicates') {
            throw PgError(400, '21000', 'ON CONFLICT DO UPDATE command cannot affect row a second time', null,
              'Ensure that no rows proposed for insertion within the same command have duplicate constrained values.');
          }
          if (resolution === 'ignore-duplicates') continue;
          throw dupKeyError(key);
        }
        setOwn(seen, key, true);
        const existing = findRow(key);
        if (existing) {
          if (resolution === 'ignore-duplicates') continue;
          if (resolution !== 'merge-duplicates') throw dupKeyError(key);
          // ON CONFLICT DO UPDATE SET <payload columns> = EXCLUDED.<...>: columns
          // absent from the payload (typically `version`) keep their value.
          const row = Object.assign({}, existing, pt, stamp());
          checkNotNull(row);
          ops.push({ old: existing, row: row });
        } else {
          const s = stamp();
          const row = Object.assign(defaultRow(s.updated_at), pt, s);
          checkNotNull(row);
          ops.push({ old: null, row: row });
        }
      }
      const written = [];
      for (const op of ops) {
        if (op.old) heap = heap.filter(r => r !== op.old);
        const stored = cloneRow(op.row);
        heap.push(stored);
        written.push(stored);
      }
      ctx.entry.applied = written.length > 0;
      if (wantsRepresentation(prefer)) return jsonResult(201, rowsText(written, sel));
      return emptyResult(201);
    }

    function handle(ctx) {
      const headers = ctx.headers;
      if (requireApiKey) {
        const key = hasOwn(headers, 'apikey') ? headers.apikey
          : (hasOwn(ctx.p.query, 'apikey') ? first(ctx.p.query.apikey) : undefined);
        if (key === undefined) {
          return jsonResult(401, JSON.stringify({ message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' }));
        }
        if (key !== anonKey) {
          return jsonResult(401, JSON.stringify({ message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }));
        }
      }
      const auth = authenticate(headers);
      ctx.entry.role = auth.role;
      ctx.entry.user = auth.user;
      if (ctx.p.path !== tablePath && ctx.p.path !== tablePath + '/') {
        return jsonResult(400, pgBody('PGRST000', 'fake-weeks-table: unsupported path ' + ctx.p.path));
      }
      switch (ctx.method) {
        case 'GET': return doGet(ctx);
        case 'PATCH': return doPatch(ctx, auth);
        case 'POST': return doPost(ctx, auth);
        case 'DELETE': return doDelete(ctx, auth);
      }
      return jsonResult(400, pgBody('PGRST117', 'Unsupported HTTP method: ' + ctx.method));
    }
    function runHandler(ctx) {
      try { return handle(ctx); } catch (e) {
        if (e && e.pgResult) return e.pgResult;
        throw e;
      }
    }

    // ------------------------------------------------- failure injection
    function matchesSpec(spec, method, haystack) {
      if (spec.method && spec.method !== method.toUpperCase()) return false;
      if (spec.week && haystack.indexOf(spec.week) < 0) return false;
      return true;
    }
    function fail(spec) {
      spec = spec || {};
      if (FAIL_KINDS.indexOf(spec.kind) < 0) {
        throw new Error('control.fail: unknown kind "' + spec.kind + '" (expected one of ' + FAIL_KINDS.join(', ') + ')');
      }
      const rule = {
        method: spec.method ? String(spec.method).toUpperCase() : null,
        week: spec.week ? String(spec.week) : null,
        kind: spec.kind,
        status: spec.status || null,
        remaining: spec.count === undefined ? 1 : spec.count,
        hits: 0,
      };
      failRules.push(rule);
      return rule;
    }
    function takeRule(method, haystack) {
      for (const r of failRules) {
        if (r.remaining > 0 && matchesSpec(r, method, haystack)) { r.remaining--; r.hits++; return r; }
      }
      return null;
    }
    function injectedResult(rule) {
      switch (rule.kind) {
        case '5xx-before': return gatewayResult(rule.status || 503);
        case '409': return dupKeyError('injected').pgResult;
        case '401': return jwtError('PGRST303', 'JWT expired').pgResult;
        case '403': return PgError(403, '42501', 'permission denied for table ' + TABLE).pgResult;
        case '400': return PgError(400, 'PGRST100', 'injected bad request (control.fail)').pgResult;
        // Not PostgREST JSON: a gateway / WAF answering instead of the API.
        case 'html-403': return { status: 403, text: '<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>', headers: { 'content-type': 'text/html' } };
        case '429': return { status: 429, text: 'Too Many Requests', headers: { 'content-type': 'text/plain', 'retry-after': '1' } };
        case '408': return { status: 408, text: 'Request Timeout', headers: { 'content-type': 'text/plain' } };
        case '413': return { status: 413, text: 'Payload Too Large', headers: { 'content-type': 'text/plain' } };
        // A schema-cache miss: the client sent a column the table lacks.
        case '400-schema': return PgError(400, 'PGRST204', "Could not find the 'extra' column of 'schedule_weeks' in the schema cache").pgResult;
        // Bad input for a column's type (e.g. a null / non-integer version).
        case '400-22P02': return PgError(400, '22P02', 'invalid input syntax for type integer: "null"').pgResult;
        // The TABLE missing from PostgREST's schema cache (a migration mid-deploy).
        case '404-PGRST205': return PgError(404, 'PGRST205', "Could not find the table 'public." + TABLE + "' in the schema cache").pgResult;
      }
      throw new Error('unreachable');
    }
    function pause(spec) {
      spec = spec || {};
      const rel = deferred(), arr = deferred();
      const p = {
        method: spec.method ? String(spec.method).toUpperCase() : null,
        week: spec.week ? String(spec.week) : null,
        when: spec.when === 'after' ? 'after' : 'before',
        remaining: spec.count === undefined ? Infinity : spec.count,
        active: true,
        held: 0,
        rel: rel,
        arr: arr,
      };
      p.handle = {
        released: rel.promise,
        arrived: arr.promise,
        get held() { return p.held; },
        release() {
          if (!p.active) return;
          p.active = false;
          const i = pauses.indexOf(p);
          if (i >= 0) pauses.splice(i, 1);
          rel.resolve();
        },
      };
      pauses.push(p);
      return p.handle;
    }
    function takePauses(method, haystack) {
      const hit = [];
      for (const p of pauses) {
        if (p.active && p.remaining > 0 && matchesSpec(p, method, haystack)) { p.remaining--; p.held++; hit.push(p); }
      }
      return hit;
    }
    function clear() {
      failRules.length = 0;
      pauses.slice().forEach(p => p.handle.release());
      control.expiredTokens.clear();
    }
    function waitForPauses(list, entry, signal) {
      list.forEach(p => p.arr.resolve(entry));
      const all = Promise.all(list.map(p => p.rel.promise));
      if (!signal || typeof signal.addEventListener !== 'function') return all;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort);
        all.then(() => {
          if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }

    // ---------------------------------------------------------- fetch
    async function run(ctx) {
      const entry = ctx.entry;
      const failNetwork = (msg, err) => { entry.status = 0; entry.error = msg; throw err; };
      await null; // never answer synchronously
      const before = ctx.pauses.filter(p => p.when === 'before');
      const after = ctx.pauses.filter(p => p.when === 'after');
      if (before.length) {
        try { await waitForPauses(before, entry, ctx.signal); } catch (e) { failNetwork('AbortError', e); }
      }
      if (ctx.signal && ctx.signal.aborted) failNetwork('AbortError', abortError(ctx.signal));
      const rule = ctx.rule;
      if (rule && BEFORE_KINDS.indexOf(rule.kind) >= 0) {
        if (rule.kind === 'throw') failNetwork('TypeError: Failed to fetch', new TypeError('Failed to fetch'));
        if (rule.kind === 'hang') { try { await never(ctx.signal); } catch (e) { failNetwork('AbortError', e); } }
        const r = injectedResult(rule);
        entry.status = r.status;
        return makeResponse(r, ctx.url);
      }
      let result = runHandler(ctx);
      if (after.length) {
        try { await waitForPauses(after, entry, ctx.signal); } catch (e) { failNetwork('AbortError', e); }
      }
      if (rule && rule.kind === 'hang-after') { try { await never(ctx.signal); } catch (e) { failNetwork('AbortError', e); } }
      if (rule && rule.kind === 'throw-after') failNetwork('TypeError: Failed to fetch', new TypeError('Failed to fetch'));
      if (rule && rule.kind === '5xx-after') result = gatewayResult(rule.status || 504);
      entry.status = result.status;
      return makeResponse(result, ctx.url);
    }

    function fetchFn(input, init) {
      init = init || {};
      const req = input !== null && typeof input === 'object' ? input : null;
      const url = typeof input === 'string' ? input : (req && typeof req.url === 'string' ? req.url : String(input));
      let method = init.method !== undefined ? String(init.method) : (req && req.method ? String(req.method) : 'GET');
      // fetch normalizes only these six; "patch" goes out lower-case.
      if (/^(delete|get|head|options|post|put)$/i.test(method)) method = method.toUpperCase();
      const headers = normalizeHeaders(init.headers !== undefined ? init.headers : (req ? req.headers : undefined));
      const p = parseUrl(url);
      const rawBody = init.body === undefined || init.body === null ? null
        : (typeof init.body === 'string' ? init.body : String(init.body));
      let body, bodyOk = true;
      if (rawBody !== null) {
        try { body = JSON.parse(rawBody); } catch (e) { bodyOk = false; body = rawBody; }
      }
      const entry = {
        seq: ++seq, method: method, url: url, query: p.query, headers: headers, body: body,
        status: null, applied: false, role: null, user: null, injected: null, error: null,
      };
      log.push(entry);
      if ((method === 'GET' || method === 'HEAD') && rawBody !== null) {
        entry.status = 0;
        entry.error = 'TypeError: Request with GET/HEAD method cannot have body.';
        return Promise.reject(new TypeError('Request with GET/HEAD method cannot have body.'));
      }
      if (init.signal && init.signal.aborted) {
        entry.status = 0;
        entry.error = 'AbortError';
        return Promise.reject(abortError(init.signal));
      }
      // Rules and pauses are claimed at call time, so overlapping requests are
      // matched in the order fetch() was called.
      const haystack = url + '\n' + p.path + '?' + p.pairs.map(kv => kv[0] + '=' + kv[1]).join('&') + '\n' + (rawBody || '');
      const rule = takeRule(method, haystack);
      if (rule) entry.injected = rule.kind;
      const ctx = {
        entry: entry, url: url, method: method, headers: headers, p: p,
        rawBody: rawBody, body: body, bodyOk: bodyOk, signal: init.signal || null,
        rule: rule, pauses: takePauses(method, haystack),
      };
      return run(ctx);
    }

    // ------------------------------------------------------- backdoors
    function rows() {
      return heap.slice().sort((a, b) => compareCol('week_monday', a.week_monday, b.week_monday)).map(cloneRow);
    }
    function get(key) {
      const r = findRow(key);
      return r ? cloneRow(r) : null;
    }
    // Merge `row` over the existing row (or defaults) with no validation; the
    // row moves to the end of heap order like any UPDATE.
    function put(row) {
      row = row || {};
      const existing = findRow(row.week_monday);
      const merged = existing ? Object.assign({}, existing) : defaultRow();
      for (const c of COLS) {
        if (!hasOwn(row, c)) continue;
        merged[c] = c === 'updated_at' ? lenientTs(row[c]) : row[c];
      }
      const stored = cloneRow(merged);
      heap = heap.filter(r => r !== existing);
      heap.push(stored);
      return cloneRow(stored);
    }
    function del(key) {
      const r = findRow(key);
      if (!r) return false;
      heap = heap.filter(x => x !== r);
      return true;
    }

    // -------------------------------------------- mixed fleet (design §2.11)
    // Other clients' writes, sent through fetch() like any request — logged,
    // and subject to auth, RLS and the failure rules — never the backdoors.
    function headersFor(token, extra) {
      const h = { apikey: anonKey, 'Content-Type': 'application/json' };
      if (token) h.Authorization = 'Bearer ' + token;
      return Object.assign(h, extra || {});
    }
    // An old build (pre-v2): its keepalive upsert is POST ?on_conflict=
    // week_monday with merge-duplicates and NO version in the body, so an
    // existing row KEEPS its version while its data and updated_at change
    // (R18); a new week gets the default (v1). Its delete carries no version
    // (R28). weeks: { K: data }.
    function oldBuild(token, by) {
      return {
        upsert(weeks, at) {
          const body = Object.keys(weeks).sort().map(k => ({ week_monday: k, data: weeks[k], updated_by: by === undefined ? null : by, updated_at: at || clock() }));
          return fetchFn(tablePath + '?on_conflict=week_monday', { method: 'POST', headers: headersFor(token, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(body) });
        },
        remove(k) {
          return fetchFn(tablePath + '?week_monday=eq.' + k, { method: 'DELETE', headers: headersFor(token, { Prefer: 'return=minimal' }) });
        },
      };
    }
    // A clear + regenerate on another device, for one week: DELETE, then a
    // plain INSERT at version 1 — the version number repeats, and only
    // updated_at tells the new row from the old (the ABA case A2 closes).
    function recreate(token, k, data, o) {
      o = o || {};
      return fetchFn(tablePath + '?week_monday=eq.' + k, { method: 'DELETE', headers: headersFor(token) }).then(r => {
        if (!r.ok) return r;
        return fetchFn(tablePath, { method: 'POST', headers: headersFor(token, { Prefer: 'return=representation' }),
          body: JSON.stringify({ week_monday: k, data: data, version: 1, updated_by: o.by === undefined ? null : o.by, updated_at: o.at || clock() }) });
      });
    }

    (opts.rows || []).forEach(put);

    return { fetch: fetchFn, rows: rows, get: get, put: put, del: del, control: control, log: log, oldBuild: oldBuild, recreate: recreate };
  }

  if (typeof module !== 'undefined' && module) module.exports = { createFakeWeeksTable: createFakeWeeksTable };
  else root.createFakeWeeksTable = createFakeWeeksTable;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));

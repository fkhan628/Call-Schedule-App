#!/usr/bin/env node
/*
 * DSG Call Schedule — build step (committed; run by CI and reproducible locally).
 *
 * Transpiles the single <script type="text/babel"> block in index-source.html
 * into plain React.createElement JS and writes index.html. Everything else in
 * the HTML is copied byte-for-byte.
 *
 * Hard rules (these are the ones that have broken the app before):
 *   - Classic JSX runtime (global React UMD). NOT automatic react/jsx-runtime.
 *   - development:false (no __self/__source debug props).
 *   - preset-env targeting Safari 11.
 *   - The transpiled body must contain ZERO injected `import` statements.
 *   - No automatic-runtime artifacts (jsx-runtime / _jsx).
 * If any gate fails, the build exits non-zero and writes nothing — so a bad
 * build can never be deployed.
 *
 * Usage: node build.js [sourceFile] [outFile]
 *        defaults: index-source.html -> index.html
 */
const fs = require("fs");
const babel = require("@babel/core");

const SRC = process.argv[2] || "index-source.html";
const OUT = process.argv[3] || "index.html";

const html = fs.readFileSync(SRC, "utf8");

// Locate the babel block (tolerant of attribute spacing).
const OPEN = /<script\s+type=["']text\/babel["']\s*>/i;
const openMatch = html.match(OPEN);
if (!openMatch) {
  console.error('FAIL: no <script type="text/babel"> block found in ' + SRC);
  process.exit(1);
}
const openTag = openMatch[0];
const openIdx = openMatch.index;
const bodyStart = openIdx + openTag.length;
const closeIdx = html.indexOf("</script>", bodyStart);
if (closeIdx === -1) {
  console.error("FAIL: babel block has no closing </script>");
  process.exit(1);
}

const before = html.slice(0, openIdx);
const jsx = html.slice(bodyStart, closeIdx);
const after = html.slice(closeIdx + "</script>".length);

if (OPEN.test(after)) {
  console.error("FAIL: more than one text/babel block — build assumes exactly one.");
  process.exit(1);
}

let result;
try {
  result = babel.transformSync(jsx, {
    babelrc: false,
    configFile: false,
    compact: false,
    comments: false,
    presets: [
      ["@babel/preset-env", { targets: { safari: "11" }, modules: false }],
      ["@babel/preset-react", { runtime: "classic", development: false }],
    ],
  });
} catch (e) {
  console.error("FAIL: Babel transform threw:\n" + (e && e.message ? e.message : e));
  process.exit(1);
}

const code = result.code;
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };

// Gate 1: no injected imports in the transpiled body.
const importLines = code.split("\n").filter((l) => /^\s*import[\s{]/.test(l));
if (importLines.length) fail("transpiled body contains import statements:\n" + importLines.join("\n"));

// Gate 2: classic runtime actually used; no automatic-runtime artifacts.
if (!code.includes("React.createElement")) fail("no React.createElement in output — JSX did not transpile.");
if (code.includes("react/jsx-runtime") || code.includes("_jsxRuntime") || /\b_jsx\b/.test(code)) {
  fail("automatic runtime artifacts present (jsx-runtime/_jsx).");
}

const out = before + '<script type="text/javascript">\n' + code + "\n  </script>" + after;
fs.writeFileSync(OUT, out, "utf8");

const ver = (html.match(/var APP_VERSION = "([^"]+)"/) || [])[1] || "unknown";
const ceCount = (code.match(/React\.createElement/g) || []).length;
console.log("OK  build complete");
console.log("    APP_VERSION         : " + ver);
console.log("    createElement calls : " + ceCount);
console.log("    injected imports    : 0");
console.log("    " + SRC + " -> " + OUT + "  (" + out.length.toLocaleString() + " bytes)");

#!/usr/bin/env node
/*
 * Bumps APP_VERSION in index-source.html, preserving the existing
 *   YYYY.MM.DD<suffix>   scheme (e.g. 2026.06.25e).
 *
 * Rules, matching how it was bumped by hand:
 *   - If the stored version's date is TODAY  -> increment the letter suffix
 *       (no suffix -> a,  a -> b,  z -> aa,  az -> ba, ...).
 *   - If the date is not today (or missing)  -> set to <today>a.
 *
 * Date is the deploy day in America/Chicago (Central), so the version reads the
 * same day you pushed. The only requirement is a unique, monotonic string for
 * cache-busting. Writes the file back in place.
 *
 * Usage: node bump-version.js [file]   (default index-source.html)
 */
const fs = require("fs");

const FILE = process.argv[2] || "index-source.html";
const src = fs.readFileSync(FILE, "utf8");

const VER_RE = /(var APP_VERSION = ")(\d{4}\.\d{2}\.\d{2})([a-z]*)(")/;
const m = src.match(VER_RE);
if (!m) {
  console.error("FAIL: could not find APP_VERSION in " + FILE);
  process.exit(1);
}

// Alphabetic increment: "" -> a, a -> b, z -> aa, az -> ba, zz -> aaa
function nextSuffix(s) {
  if (!s) return "a";
  const chars = s.split("");
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] === "z") { chars[i] = "a"; i--; }
    else { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(""); }
  }
  return "a" + chars.join(""); // rolled over every position
}

// "YYYY-MM-DD" in Central time (en-CA yields ISO-style date parts), then dotted.
const today = new Date()
  .toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
  .replace(/-/g, ".");
const oldDate = m[2];
const oldSuffix = m[3];
const newVer = (oldDate === today) ? (today + nextSuffix(oldSuffix)) : (today + "a");

const out = src.replace(VER_RE, `$1${newVer}$4`);
fs.writeFileSync(FILE, out, "utf8");

console.log(`APP_VERSION: ${oldDate}${oldSuffix} -> ${newVer}`);

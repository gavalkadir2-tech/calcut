const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { extract } = require("./helpers");

const src = extract("  function localDateTimeValue(", "  function openScheduleModal(") +
  extract("  const DEVICE_PREF_KEYS", "  async function saveLocalPrefs(");
const { localDateTimeValue, scheduleQuickTimes, devicePrefsOf } = new Function(
  src + "; return { localDateTimeValue, scheduleQuickTimes, devicePrefsOf };")();

test("scheduled messages: quick picks are in the future, tomorrow 09:00 last", () => {
  const morning = new Date(2026, 9, 30, 8, 0).getTime();
  const picks = scheduleQuickTimes(morning);
  assert.deepStrictEqual(picks.map(p => p.label), ["1 saat sonra", "Bu akşam 20:00", "Yarın 09:00"]);
  assert.strictEqual(localDateTimeValue(picks[2].at), "2026-10-31T09:00");
  assert.strictEqual(localDateTimeValue(picks[1].at), "2026-10-30T20:00");
  // Late evening: no "this evening".
  const late = scheduleQuickTimes(new Date(2026, 9, 30, 22, 30).getTime());
  assert.deepStrictEqual(late.map(p => p.label), ["1 saat sonra", "Yarın 09:00"]);
  assert.ok(late.every(p => p.at > new Date(2026, 9, 30, 22, 30).getTime()));
});

test("settings transfer: every per-device setting, nothing else", () => {
  const out = devicePrefsOf({
    uid: "u", privateKeyJwk: { k: 1 }, pinned: ["a"], wallpapers: { a: "x" }, stickers: [], chatSounds: { a: "b" },
    defaultDisappearing: 0, lockedChats: ["a"],
  });
  assert.deepStrictEqual(out, { pinned: ["a"], wallpapers: { a: "x" }, stickers: [], chatSounds: { a: "b" }, defaultDisappearing: 0, lockedChats: ["a"] });
  assert.deepStrictEqual(devicePrefsOf(null), {});
});

test("persistSession keeps the per-device settings", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const body = app.slice(app.indexOf("  async function persistSession("), app.indexOf("  async function clearPersistedSession("));
  assert.match(body, /\.\.\.devicePrefsOf\(localSessionData\)/);
});

test("Code.gs: a due scheduled message moves in one atomic commit", () => {
  const gs = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
  const body = gs.slice(gs.indexOf("function deliverOne_("), gs.indexOf("/* ---------------- Firebase ID token check"));
  assert.match(body, /currentDocument: \{ exists: false \}/);
  assert.match(body, /delete: doc\.name, currentDocument: \{ exists: true \}/);
  assert.match(gs, /const WORKER_VERSION = 5;/);
});

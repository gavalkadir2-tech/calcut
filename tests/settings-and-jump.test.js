const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

const src = extract("  function autoDlAllowedNow(", "  function maybeAutoDownload(") +
  extract("  function messageForDate(", "  function jumpToDate(");
const { autoDlAllowedNow, messageForDate } = new Function(src + "; return { autoDlAllowedNow, messageForDate };")();

test("auto-download: always, Wi-Fi only (when the browser tells), or never", () => {
  assert.strictEqual(autoDlAllowedNow("always", undefined), true);
  assert.strictEqual(autoDlAllowedNow("wifi", { type: "wifi" }), true);
  assert.strictEqual(autoDlAllowedNow("wifi", { type: "cellular" }), false);
  assert.strictEqual(autoDlAllowedNow("wifi", undefined), false);
  assert.strictEqual(autoDlAllowedNow("off", { type: "wifi" }), false);
});

test("jump to date: first message that day, else the nearest one before", () => {
  const day = d => new Date(2026, 9, d, 12).getTime();
  const msgs = [{ id: "a", ts: day(1) }, { id: "x", ts: day(3), deleted: true }, { id: "b", ts: day(5) }, { id: "c", ts: day(5) + 1000 }];
  assert.strictEqual(messageForDate(msgs, new Date(2026, 9, 5).getTime()).id, "b");
  assert.strictEqual(messageForDate(msgs, new Date(2026, 9, 3).getTime()).id, "b");
  assert.strictEqual(messageForDate(msgs, new Date(2026, 9, 20).getTime()).id, "c");
  assert.strictEqual(messageForDate([], 0), null);
});

const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

const src = extract("  function normalizeQuickKey(", "  function updateQuickPicker(") +
  extract("  function peaksFromSamples(", "  async function voiceWave(") +
  extract("  function markedUnread(", "  async function setMarkedUnread(");
const api = new Function("localSessionData", src + "; return { normalizeQuickKey, quickMatches, peaksFromSamples, markedUnread };")({ markedUnread: ["c1"] });

test("quick replies: a lone /shortcut offers matching replies", () => {
  const list = [{ key: "adres", text: "Atatürk Cd. 5" }, { key: "aksam", text: "Akşam görüşürüz" }, { key: "iban", text: "TR00..." }];
  assert.deepStrictEqual(api.quickMatches("/a", list).map(q => q.key), ["adres", "aksam"]);
  assert.deepStrictEqual(api.quickMatches("/", list).length, 3);
  assert.deepStrictEqual(api.quickMatches("/ib", list).map(q => q.key), ["iban"]);
  assert.deepStrictEqual(api.quickMatches("selam /a", list), []);
  assert.deepStrictEqual(api.quickMatches("/a b", list), []);
  assert.strictEqual(api.normalizeQuickKey(" /Adres Ev! "), "adresev");
  assert.strictEqual(api.normalizeQuickKey("İş"), "iş");
});

test("voice waveform: bars scaled to the loudest, never flat", () => {
  const samples = new Float32Array(400);
  for (let i = 0; i < 400; i++) samples[i] = i < 200 ? 0 : (i % 2 ? 0.5 : -0.5);
  assert.deepStrictEqual(api.peaksFromSamples(samples, 4), [0.08, 0.08, 1, 1]);
  assert.strictEqual(api.peaksFromSamples(new Float32Array(50), 40).length, 40);
});

test("marked unread is per chat", () => {
  assert.strictEqual(api.markedUnread("c1"), true);
  assert.strictEqual(api.markedUnread("c2"), false);
});

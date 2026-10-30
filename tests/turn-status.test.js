const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

const turnProblemText = new Function(extract("  function turnProblemText(", "  // The ICE servers for a new call") + "; return turnProblemText;")();

test("Settings say why TURN isn't on", () => {
  assert.match(turnProblemText({ error: "net" }), /ulaşılamadı/);
  assert.match(turnProblemText({ status: 200, data: { sent: 0, v: 3 } }), /Code\.gs eski/);
  assert.match(turnProblemText({ status: 200, data: { iceServers: null, v: 3 } }), /METERED_APP/);
  assert.match(turnProblemText({ status: 500, data: { error: "TURN 401", v: 3 } }), /anahtarı kabul etmedi/);
  assert.match(turnProblemText({ status: 500, data: { error: "TURN 404", v: 3 } }), /METERED_APP adı/);
  assert.match(turnProblemText({ status: 500, data: { error: "DNS error: x.metered.live", v: 3 } }), /sunucu hata verdi: DNS/);
  assert.strictEqual(turnProblemText({ status: 200, data: { iceServers: [{ urls: ["turn:x"] }] } }), "");
});

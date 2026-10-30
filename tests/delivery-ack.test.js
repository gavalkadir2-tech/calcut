const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");

const gs = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
const fn = name => { const s = gs.indexOf("function " + name + "("); return gs.slice(s, gs.indexOf("\n}\n", s) + 2); };

function load(serviceUrl) {
  const props = {};
  const Utilities = {
    getUuid: () => crypto.randomUUID(),
    computeHmacSha256Signature: (value, key) => [...crypto.createHmac("sha256", key).update(value).digest()],
    base64EncodeWebSafe: bytes => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) };
  const ScriptApp = { getService: () => ({ getUrl: () => serviceUrl }) };
  return new Function("Utilities", "PropertiesService", "ScriptApp",
    ["isId_", "ackSecret_", "ackToken_", "messagePush_", "deliveryAck_"].map(fn).join("\n") +
    "; return { messagePush_, deliveryAck_ };")(Utilities, PropertiesService, ScriptApp);
}

function fakeFs(conv) {
  const writes = [];
  return {
    writes,
    get: p => (p.startsWith("conversations/") && !p.includes("/messages/") ? conv : null),
    patchFields: (p, f) => writes.push(["patch", p, f]),
    setMapField: (p, field, key, v) => writes.push(["map", p, field, key, !!v.timestampValue]),
  };
}

test("a message push carries a signed receipt only the server can make", () => {
  const api = load("https://script.google.com/macros/s/X/exec");
  const push = api.messagePush_("bob", "c1", "m1");
  assert.strictEqual(push.kind, "message");
  assert.deepStrictEqual([push.u, push.c, push.m, push.a], ["bob", "c1", "m1", "https://script.google.com/macros/s/X/exec"]);
  assert.ok(push.t.length >= 20);
  // No address (e.g. run from the editor): a plain push.
  assert.deepStrictEqual(load("").messagePush_("bob", "c1", "m1"), { kind: "message" });
});

test("delivery ack: marks 1:1 messages delivered and group ones per member; forged ones are ignored", () => {
  const api = load("https://script.google.com/macros/s/X/exec");
  const push = api.messagePush_("bob", "c1", "m1");
  const oneToOne = fakeFs({ participants: ["alice", "bob"] });
  assert.strictEqual(api.deliveryAck_(oneToOne, { u: "bob", c: "c1", m: "m1", t: push.t }), true);
  assert.deepStrictEqual(oneToOne.writes, [["patch", "conversations/c1/messages/m1", { delivered: { booleanValue: true } }]]);

  const forged = fakeFs({ participants: ["alice", "bob"] });
  assert.strictEqual(api.deliveryAck_(forged, { u: "bob", c: "c1", m: "m2", t: push.t }), false);
  assert.strictEqual(api.deliveryAck_(forged, { u: "eve", c: "c1", m: "m1", t: push.t }), false);
  assert.strictEqual(api.deliveryAck_(forged, { u: "bob", c: "c1", m: "m1", t: "x" }), false);
  assert.deepStrictEqual(forged.writes, []);

  const gpush = api.messagePush_("carol", "g1", "m9");
  const group = fakeFs({ isGroup: true, participants: ["alice", "bob", "carol"] });
  assert.strictEqual(api.deliveryAck_(group, { u: "carol", c: "g1", m: "m9", t: gpush.t }), true);
  assert.deepStrictEqual(group.writes, [["map", "conversations/g1/messages/m9", "deliveredTo", "carol", true]]);

  const left = fakeFs({ participants: ["alice"] });
  assert.strictEqual(api.deliveryAck_(left, { u: "bob", c: "c1", m: "m1", t: push.t }), false);
});

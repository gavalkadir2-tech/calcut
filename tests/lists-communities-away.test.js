const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { extract } = require("./helpers");

const src = extract("  const MAX_COMMUNITY_GROUPS = 20;", "  async function joinGroupWithCode(") +
  extract("  function chatLists() {", "  async function saveChatLists(") +
  extract("  function chatListMatches(", "  /* ---------------- Communities");
const api = new Function("localSessionData", "threadFilter", src + "; return { parseGroupLinks, chatListMatches, chatLists };")(
  { chatLists: [{ id: "a1", name: "Aile", convIds: ["c1", "c2"] }, { bad: true }] }, "list:a1");

test("communities: linked groups need a valid invite code; at most 20", () => {
  const ok = { convId: "g1", name: "Futbol", code: "abcdefghijklmnop" };
  assert.deepStrictEqual(api.parseGroupLinks([ok, { convId: "g2", code: "short" }, null, "x"]), [ok]);
  assert.strictEqual(api.parseGroupLinks(Array.from({ length: 30 }, () => ok)).length, 20);
  assert.deepStrictEqual(api.parseGroupLinks(undefined), []);
});

test("chat lists: a list filter shows only its chats; broken entries are dropped", () => {
  assert.strictEqual(api.chatLists().length, 1);
  assert.strictEqual(api.chatListMatches({ id: "c1" }), true);
  assert.strictEqual(api.chatListMatches({ id: "c9" }), false);
});

const gs = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
const fn = name => { const s = gs.indexOf("function " + name + "("); return gs.slice(s, gs.indexOf("\n}\n", s) + 2); };

test("Code.gs: translate checks its input", () => {
  const calls = [];
  const translate = new Function("LanguageApp", fn("translate_") + "; return translate_;")({ translate: (t, from, to) => { calls.push(to); return "[" + to + "]" + t; } });
  assert.deepStrictEqual(translate("", "tr"), { error: "bad text" });
  assert.deepStrictEqual(translate("x".repeat(5001), "tr"), { error: "bad text" });
  assert.deepStrictEqual(translate("hello", "en"), { text: "[en]hello" });
  assert.deepStrictEqual(translate("hello", "<script>"), { text: "[tr]hello" });
});

test("Code.gs: auto-reply copies the owner's encrypted reply, at most every 6 hours", () => {
  const commits = [];
  const pushes = [];
  let lastSent = null;
  const fsMock = {
    getRaw: () => ({ name: "projects/p/databases/(default)/documents/awayReplies/owner", fields: {
      on: { booleanValue: true },
      replies: { mapValue: { fields: { c1: { mapValue: { fields: { iv: { stringValue: "IV" }, ciphertext: { stringValue: "CT" }, wrappedKeys: { mapValue: { fields: {} } } } } } } } },
      ...(lastSent ? { lastSent: { mapValue: { fields: { c1: { integerValue: String(lastSent) } } } } } : {}),
    } }),
    get: () => ({ blocked: {} }),
    name: p => "N/" + p,
    commit: w => { commits.push(w); return true; },
  };
  const autoReply = new Function("Utilities", "pushToUser_", "AWAY_EVERY_MS",
    fn("autoReply_") + "; return autoReply_;")({ getUuid: () => "1234-5678-90ab-cdef-0000" }, (fs, sa, to, from) => pushes.push(to + "<-" + from), 6 * 3600e3);
  autoReply(fsMock, {}, "owner", "friend", "c1");
  assert.strictEqual(commits.length, 1);
  const msg = commits[0][0].update.fields;
  assert.strictEqual(msg.from.stringValue, "owner");
  assert.strictEqual(msg.ciphertext.stringValue, "CT");
  assert.strictEqual(msg.autoReply.booleanValue, true);
  assert.deepStrictEqual(commits[0][1].transform.fieldTransforms[1], { fieldPath: "unreadCount.`friend`", increment: { integerValue: "1" } });
  assert.deepStrictEqual(pushes, ["friend<-owner"]);
  lastSent = Date.now() - 3600e3;
  autoReply(fsMock, {}, "owner", "friend", "c1");
  assert.strictEqual(commits.length, 1, "not again within 6 hours");
  autoReply(fsMock, {}, "owner", "friend", "c2");
  assert.strictEqual(commits.length, 1, "no reply prepared for that chat");
});

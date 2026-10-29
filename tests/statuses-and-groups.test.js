const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

function load() {
  const src = extract("  function statusAudience() {", "  function startStatusListeners() {");
  const ctx = {
    conversations: new Map(), myBlocked: {}, myUid: "me", myNickname: "ben", statusDocs: new Map(),
    privacy: { mode: "all", uids: [] }, statusPrivacy() { return ctx.privacy; },
  };
  const fn = new Function("ctx", `with (ctx) { ${src}; return { statusAudience, nicknameOf, liveStatuses }; }`);
  return { ctx, ...fn(ctx) };
}

test("status audience is 1:1 contacts, minus blocked ones, deduplicated", () => {
  const { ctx, statusAudience } = load();
  ctx.conversations.set("a", { isGroup: false, participants: ["me", "bob"], participantNicknames: {} });
  ctx.conversations.set("b", { isGroup: false, participants: ["me", "carol"], participantNicknames: {} });
  ctx.conversations.set("c", { isGroup: false, participants: ["bob", "me"], participantNicknames: {} });
  ctx.conversations.set("g", { isGroup: true, participants: ["me", "dave", "erin"], participantNicknames: {} });
  ctx.myBlocked.carol = true;
  assert.deepStrictEqual(statusAudience(), ["bob"]);
});

test("nicknameOf finds a name in any conversation", () => {
  const { ctx, nicknameOf } = load();
  ctx.conversations.set("g", { isGroup: true, participants: ["me", "dave"], participantNicknames: { dave: "dave1" } });
  assert.strictEqual(nicknameOf("dave"), "dave1");
  assert.strictEqual(nicknameOf("me"), "ben");
  assert.strictEqual(nicknameOf("zed"), "?");
});

test("liveStatuses drops expired ones and sorts oldest first", () => {
  const { ctx, liveStatuses } = load();
  const now = Date.now();
  ctx.statusDocs.set("1", { id: "1", from: "bob", ts: now - 2000, expiresAt: now + 1000 });
  ctx.statusDocs.set("2", { id: "2", from: "bob", ts: now - 5000, expiresAt: now + 1000 });
  ctx.statusDocs.set("3", { id: "3", from: "bob", ts: now - 9000, expiresAt: now - 1 });
  ctx.statusDocs.set("4", { id: "4", from: "carol", ts: now, expiresAt: now + 1000 });
  assert.deepStrictEqual(liveStatuses("bob").map(s => s.id), ["2", "1"]);
});

test("status privacy: all except some, or only some", () => {
  const { ctx, statusAudience } = load();
  ["bob", "carol", "dave"].forEach(u => ctx.conversations.set(u, { isGroup: false, participants: ["me", u], participantNicknames: {} }));
  ctx.privacy = { mode: "except", uids: ["carol"] };
  assert.deepStrictEqual(statusAudience(), ["bob", "dave"]);
  ctx.privacy = { mode: "only", uids: ["dave", "zed"] };
  assert.deepStrictEqual(statusAudience(), ["dave"]);
});

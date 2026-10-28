// Pinned chats (pinnedConvIds / togglePin / sortThreads in app.js): pins
// live in the encrypted local session and sort first.
const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

function load(session) {
  const saved = [];
  const api = new Function("session", "saved", `
    let localSessionData = session, currentLocalKey = session ? "key" : null;
    const renderThreadList = () => {};
    const sealSession = async d => ({ sealed: JSON.parse(JSON.stringify(d)) });
    const saveLocalBlob = async (key, d) => { saved.push(d); };
    ${extract("  function pinnedConvIds()", "  const LONG_PRESS_MS")}
    return { pinnedConvIds, togglePin, sortThreads, session: () => localSessionData };
  `)(session, saved);
  return { api, saved };
}

const convs = () => [
  { id: "old", lastTs: 100 },
  { id: "new", lastTs: 300 },
  { id: "mid", lastTs: 200 },
];

test("without pins, chats sort by last activity", () => {
  const { api } = load({});
  assert.deepStrictEqual(api.sortThreads(convs(), []).map(c => c.id), ["new", "mid", "old"]);
});

test("pinned chats come first, most recently pinned on top", async () => {
  const { api } = load({});
  await api.togglePin("old");
  await api.togglePin("mid");
  assert.deepStrictEqual(api.pinnedConvIds(), ["mid", "old"]);
  assert.deepStrictEqual(api.sortThreads(convs(), api.pinnedConvIds()).map(c => c.id), ["mid", "old", "new"]);
});

test("pinning again unpins", async () => {
  const { api } = load({ pinned: ["old"] });
  await api.togglePin("old");
  assert.deepStrictEqual(api.pinnedConvIds(), []);
});

test("pins are saved into the sealed local session", async () => {
  const { api, saved } = load({ uid: "u1" });
  await api.togglePin("new");
  assert.deepStrictEqual(saved.at(-1), { sealed: { uid: "u1", pinned: ["new"] } });
});

test("while locked (no session) pinning does nothing", async () => {
  const { api, saved } = load(null);
  await api.togglePin("new");
  assert.deepStrictEqual(api.pinnedConvIds(), []);
  assert.strictEqual(saved.length, 0);
});

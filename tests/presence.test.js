// Online / last seen text (presenceText in app.js).
const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

function load(myProfile) {
  return new Function("myProfile", `
    const myUid = "me";
    const PRESENCE_ONLINE_MS = 75 * 1000;
    const profiles = new Map([["me", myProfile]]);
    ${extract("  function myHidePresence()", "  function watchProfile(")}
    ${extract("  function presenceText(", "  function avatarColor(")}
    return { presenceText, profiles };
  `)(myProfile);
}

test("seen within the last 75 seconds counts as online", () => {
  const { presenceText, profiles } = load({});
  profiles.set("bob", { lastSeen: Date.now() - 30 * 1000 });
  assert.strictEqual(presenceText("bob"), "çevrimiçi");
});

test("seen earlier today shows the time", () => {
  const { presenceText, profiles } = load({});
  const seen = new Date();
  seen.setMinutes(seen.getMinutes() - 10);
  if (seen.toDateString() !== new Date().toDateString()) return; // just after midnight
  profiles.set("bob", { lastSeen: seen.getTime() });
  assert.match(presenceText("bob"), /^son görülme: bugün \d\d:\d\d$/);
});

test("seen yesterday says dün", () => {
  const { presenceText, profiles } = load({});
  const seen = new Date();
  seen.setDate(seen.getDate() - 1);
  profiles.set("bob", { lastSeen: seen.getTime() });
  assert.match(presenceText("bob"), /^son görülme: dün /);
});

test("nothing is shown when they hide it, or when I hide mine", () => {
  const recent = Date.now() - 1000;
  let { presenceText, profiles } = load({});
  profiles.set("bob", { lastSeen: recent, hidePresence: true });
  assert.strictEqual(presenceText("bob"), null);
  ({ presenceText, profiles } = load({ hidePresence: true }));
  profiles.set("bob", { lastSeen: recent });
  assert.strictEqual(presenceText("bob"), null);
});

test("no lastSeen yet shows nothing", () => {
  const { presenceText, profiles } = load({});
  profiles.set("bob", { lastSeen: null });
  assert.strictEqual(presenceText("bob"), null);
});

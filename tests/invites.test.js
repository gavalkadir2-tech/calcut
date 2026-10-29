const test = require("node:test");
const assert = require("node:assert");
const { webcrypto } = require("node:crypto");
const { extract } = require("./helpers");

const src = extract("  const INVITE_PREFIX", "  async function shareInvite(") +
  extract("  function parseInvite(", '  document.getElementById("group-join-btn")');
const { randomInviteCode, parseInvite, INVITE_PREFIX } = new Function("crypto",
  src + "; return { randomInviteCode, parseInvite, INVITE_PREFIX };")(webcrypto);

test("invite codes fit firestore.rules (16-64 chars) and parse back", () => {
  const code = randomInviteCode();
  assert.match(code, /^[a-z0-9]{16}$/);
  assert.notStrictEqual(code, randomInviteCode());
  const pasted = "Gruba katılmak için bu kodu yapıştır:\n" + INVITE_PREFIX + "Gx7Abc123." + code;
  assert.deepStrictEqual(parseInvite(pasted), { convId: "Gx7Abc123", code });
});

test("anything else is not an invite", () => {
  assert.strictEqual(parseInvite("merhaba"), null);
  assert.strictEqual(parseInvite("calcut-davet:abc.kısa"), null);
  assert.strictEqual(parseInvite("calcut-davet:../x.abcdefghijklmnop"), null);
});

const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

const ns = new Function(`
  ${extract("  const SYNTHETIC_EMAIL_DOMAIN", "  const authTitle")}
  ${extract("  function normalizeNickname(raw) {", "  authBackBtn.addEventListener")}
  return { nicknameToSyntheticEmail, normalizeNickname };
`)();

test("Turkish letters are kept and lowercased", () => {
  // "I" stays "i" as before, so existing nicknames still match.
  assert.strictEqual(ns.normalizeNickname("  ÇağRI_Şenöz 1! "), "çağri_şenöz1");
  assert.strictEqual(ns.normalizeNickname("İlkÜ"), "ilkü");
  assert.strictEqual(ns.normalizeNickname("ılık"), "ılık");
  assert.strictEqual(ns.normalizeNickname("Ali-Veli"), "aliveli");
  // Decomposed input (c + combining cedilla) matches the composed letter.
  assert.strictEqual(ns.normalizeNickname("çay"), "çay");
});

test("ASCII nicknames keep their old auth email; Turkish ones get a distinct ASCII one", () => {
  assert.strictEqual(ns.nicknameToSyntheticEmail("ali_1"), "ali_1@calcut.local");
  const e = ns.nicknameToSyntheticEmail("çağrı");
  assert.strictEqual(e, "u-00e7a-011fr-0131@calcut.local");
  assert.match(e, /^[\x21-\x7e]+$/);
  assert.notStrictEqual(ns.nicknameToSyntheticEmail("ılık"), ns.nicknameToSyntheticEmail("ilik"));
});

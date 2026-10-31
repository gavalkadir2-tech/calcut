const test = require("node:test");
const assert = require("node:assert");
const { webcrypto } = require("node:crypto");
const { extract, b64Helpers } = require("./helpers");

const src = extract("  async function deriveKeyFromSecret(", "\n  }\n") + "\n  }\n" +
  extract("  const TWO_STEP_SEP", "  function updateTwoStepButton(") +
  extract("  function parseCallLink(", "  async function createCallLink(");

test("two-step: the key opens with password + PIN only, and back with the password", async () => {
  const pair = await webcrypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  const api = new Function("crypto", "myPrivateKey", b64Helpers + src +
    "; return { twoStepSecret, validTwoStepPin, unlocksPrivateKey, wrapPrivateKey, parseCallLink };")(webcrypto, pair.privateKey);
  const data = { pkSalt: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64") };
  data.encPrivateKey = await api.wrapPrivateKey(data, api.twoStepSecret("parola123", "482915"));
  assert.strictEqual(await api.unlocksPrivateKey(data, api.twoStepSecret("parola123", "482915")), true);
  assert.strictEqual(await api.unlocksPrivateKey(data, "parola123"), false);
  assert.strictEqual(await api.unlocksPrivateKey(data, api.twoStepSecret("parola123", "000000")), false);
  data.encPrivateKey = await api.wrapPrivateKey(data, "parola123");
  assert.strictEqual(await api.unlocksPrivateKey(data, "parola123"), true);
  assert.strictEqual(api.validTwoStepPin("123456"), true);
  assert.strictEqual(api.validTwoStepPin("12345"), false);
  assert.strictEqual(api.validTwoStepPin("12345a"), false);
  assert.strictEqual(api.parseCallLink("katıl: calcut-arama:AbCdEfGhIjKlMnOpQrSt bekliyorum"), "AbCdEfGhIjKlMnOpQrSt");
  assert.strictEqual(api.parseCallLink("calcut-arama:kisa"), null);
});

// The Android app's biometric layer (sealSession / openBioLayer /
// attemptUnlock in app.js): the PIN opens the outer blob, the fingerprint
// the session inside it. Runs the real code with a stubbed plugin.
const test = require("node:test");
const assert = require("node:assert");
const { extract, b64Helpers, memoryLocalStorage } = require("./helpers");

const PIN = "1234";
const DURESS_PIN = "9999";

async function setup() {
  const localStorage = memoryLocalStorage();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const plugin = { mode: "ok", prompts: 0 };
  const window = { Capacitor: { isNativePlatform: () => true, Plugins: { BiometricKey: {
    unlock: async () => {
      plugin.prompts++;
      if (plugin.mode === "ok") return { secret };
      const e = new Error(plugin.mode); e.code = plugin.mode; throw e;
    },
    remove: async () => {},
  } } } };
  const code = [
    extract("  const STORAGE_SALT", "  function vaultExists()"),
    extract("  function vaultExists()", "  /* ---------------- Duress"),
    extract("  function duressPinExists()", "  function clearDuressPin()"),
    extract("  const STORAGE_BIO_SEALED", "  async function verifyBiometricIfEnabled()"),
    extract("  // Returns \"real\"", "  function openDuressScreen()"),
  ].join("\n");
  const api = new Function("localStorage", "window", "secret",
    b64Helpers + "let currentLocalKey = null, localSessionData = null;\n" + code + `
    return {
      attemptUnlock, sealSession, saveLocalBlob, loadLocalBlob, deriveLocalKey, setDuressPin,
      setBioKey: async on => { currentBioKey = on ? await bioKeyFromSecret(secret) : null; },
      state: () => ({ currentLocalKey, localSessionData }),
    };`)(localStorage, window, secret);

  assert.strictEqual(await api.attemptUnlock(PIN), "real"); // creates the vault
  await api.setDuressPin(DURESS_PIN);
  const session = { uid: "u1", privateKeyJwk: "PRIVATE-KEY" };
  // Turn the biometric layer on, as the Settings button does.
  await api.setBioKey(true);
  localStorage.setItem("calcut_vault_bio_sealed", "sealed");
  await api.saveLocalBlob(api.state().currentLocalKey, await api.sealSession(session));
  await api.setBioKey(false);
  return { api, plugin };
}

test("the PIN alone yields only the sealed layer, never the private key", async () => {
  const { api } = await setup();
  const outer = await api.loadLocalBlob(await api.deriveLocalKey(PIN));
  assert.ok(outer.bioLayer);
  assert.ok(!JSON.stringify(outer).includes("PRIVATE-KEY"));
});

test("PIN plus fingerprint opens the session", async () => {
  const { api } = await setup();
  assert.strictEqual(await api.attemptUnlock(PIN), "real");
  assert.strictEqual(api.state().localSessionData.privateKeyJwk, "PRIVATE-KEY");
});

test("a cancelled or invalidated fingerprint keeps the vault closed", async () => {
  const { api, plugin } = await setup();
  for (const mode of ["cancelled", "invalidated"]) {
    plugin.mode = mode;
    assert.strictEqual(await api.attemptUnlock(PIN), "biofail");
  }
});

test("a wrong PIN fails without asking for the fingerprint", async () => {
  const { api, plugin } = await setup();
  assert.strictEqual(await api.attemptUnlock("0000"), "fail");
  assert.strictEqual(plugin.prompts, 0);
});

test("the duress PIN opens the decoy without asking for the fingerprint", async () => {
  const { api, plugin } = await setup();
  assert.strictEqual(await api.attemptUnlock(DURESS_PIN), "duress");
  assert.strictEqual(plugin.prompts, 0);
});

test("after turning the layer off, the PIN alone opens the session again", async () => {
  const { api, plugin } = await setup();
  await api.attemptUnlock(PIN);
  await api.setBioKey(false);
  await api.saveLocalBlob(api.state().currentLocalKey, await api.sealSession(api.state().localSessionData));
  plugin.mode = "cancelled";
  assert.strictEqual(await api.attemptUnlock(PIN), "real");
  assert.strictEqual(api.state().localSessionData.privateKeyJwk, "PRIVATE-KEY");
});

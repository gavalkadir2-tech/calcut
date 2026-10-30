const test = require("node:test");
const assert = require("node:assert");
const { webcrypto } = require("node:crypto");
const { extract, b64Helpers, memoryLocalStorage } = require("./helpers");

const panicSrc = extract("  function makePanicDetector(", "  let panicFeed = null;");
const makePanicDetector = new Function(panicSrc + "; return makePanicDetector;")();

function run(detector, samples) {
  return samples.map(detector).filter(Boolean);
}
const still = (t, z = 9.81) => ({ x: 0, y: 0, z, t });

test("panic: three hard jolts within a second is a shake", () => {
  const d = makePanicDetector("shake");
  assert.deepStrictEqual(run(d, [still(0), { x: 30, y: 0, z: 9.8, t: 100 }, still(200), { x: -30, y: 0, z: 9.8, t: 400 }, still(500), { x: 28, y: 5, z: 9, t: 700 }]), ["shake"]);
});

test("panic: walking, one bump or slow jolts are not a shake", () => {
  const d = makePanicDetector("shake");
  const walk = Array.from({ length: 50 }, (_, i) => ({ x: 2 * Math.sin(i), y: 3, z: 9.8 + 3 * Math.cos(i), t: i * 50 }));
  assert.deepStrictEqual(run(d, walk), []);
  assert.deepStrictEqual(run(d, [{ x: 30, y: 0, z: 0, t: 3000 }, { x: 30, y: 0, z: 0, t: 4500 }, { x: 30, y: 0, z: 0, t: 6000 }]), []);
});

test("panic: lying face down for most of a second; face up does nothing", () => {
  const d = makePanicDetector("facedown");
  const down = Array.from({ length: 12 }, (_, i) => still(i * 100, -9.8));
  assert.deepStrictEqual(run(d, down), ["facedown"]);
  const d2 = makePanicDetector("facedown");
  assert.deepStrictEqual(run(d2, Array.from({ length: 20 }, (_, i) => still(i * 100))), []);
  // Shake mode ignores face down.
  assert.deepStrictEqual(run(makePanicDetector("shake"), down), []);
});

test("intruder photo: encrypted to the vault's key, only that key opens it", async () => {
  const src = extract("  function intruderEnabled(", "  function updateIntruderButton(") +
    extract("  async function recordIntruder(", "  async function showIntruderReport(");
  const localStorage = memoryLocalStorage();
  const photo = "data:image/jpeg;base64,/9j/AAAA";
  const api = new Function("crypto", "localStorage", "INTRUDER_PUB_KEY", "INTRUDER_LOG_KEY", "INTRUDER_MAX",
    b64Helpers + "let intruderBusy = false; async function grabFrontPhoto() { return " + JSON.stringify(photo) + "; }" + src +
    "; return { recordIntruder, intruderLog, openIntruderEntry };")(webcrypto, localStorage, "pub", "log", 10);
  await api.recordIntruder();
  assert.deepStrictEqual(api.intruderLog(), [], "off until a key is set up");

  const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  localStorage.setItem("pub", Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"));
  await api.recordIntruder();
  const [entry] = api.intruderLog();
  assert.ok(entry.ts && entry.box && !entry.box.includes("/9j/"));
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  assert.strictEqual(await api.openIntruderEntry(entry, jwk), photo);
  const other = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  await assert.rejects(api.openIntruderEntry(entry, await webcrypto.subtle.exportKey("jwk", other.privateKey)));
});

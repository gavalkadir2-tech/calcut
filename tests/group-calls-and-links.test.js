const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { webcrypto } = crypto;
const { extract, b64Helpers } = require("./helpers");

const src = extract("  function canPostIn(", "  function updateComposerAccess(") +
  extract("  function gcPairId(", "  function gcName(") +
  extract("  async function linkAesKey(", "  function stopLinkPoll(") +
  extract("  function parseLinkQr(", "  // On the phone");
const { canPostIn, gcPairId, gcFresh, linkAesKey, parseLinkQr } = new Function("crypto", "myUid", "GC_STALE_MS",
  b64Helpers + src + "; return { canPostIn, gcPairId, gcFresh, linkAesKey, parseLinkQr };")(webcrypto, "me", 90000);

test("channels and admin-only groups: only admins can post", () => {
  assert.strictEqual(canPostIn(null), true);
  assert.strictEqual(canPostIn({ isGroup: false }), true);
  assert.strictEqual(canPostIn({ isGroup: true, admins: [] }), true);
  assert.strictEqual(canPostIn({ isGroup: true, isChannel: true, admins: ["x"] }), false);
  assert.strictEqual(canPostIn({ isGroup: true, onlyAdmins: true, admins: ["x"] }), false);
  assert.strictEqual(canPostIn({ isGroup: true, isChannel: true, admins: ["me"] }), true);
});

test("group calls: one pair doc per pair, stale participants drop out", () => {
  assert.strictEqual(gcPairId("b", "a"), "a_b");
  assert.strictEqual(gcPairId("a", "b"), gcPairId("b", "a"));
  const ts = ms => ({ toMillis: () => ms });
  const now = Date.now();
  assert.deepStrictEqual(gcFresh({ a: ts(now - 1000), b: ts(now - 200000), c: null }), ["a"]);
  assert.deepStrictEqual(gcFresh(undefined), []);
});

test("linked devices: the QR code parses and both sides derive the same key", async () => {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const pub = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");
  const id = "0123456789abcdef0123456789abcdef";
  const link = parseLinkQr("calcut-baglan:" + id + ":" + pub);
  assert.deepStrictEqual(link, { linkId: id, pub });
  assert.strictEqual(parseLinkQr("calcut-baglan:xyz:" + pub), null);
  assert.strictEqual(parseLinkQr("calcut-kisi:" + id), null);

  const phone = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const phonePub = Buffer.from(await webcrypto.subtle.exportKey("raw", phone.publicKey)).toString("base64");
  const kPhone = await linkAesKey(phone.privateKey, link.pub);
  const kDesk = await linkAesKey(pair.privateKey, phonePub);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const box = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, kPhone, new TextEncoder().encode("token"));
  const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, kDesk, box);
  assert.strictEqual(new TextDecoder().decode(plain), "token");
});

test("push server: link token is a Firebase custom token signed by the service account", async () => {
  const w = fs.readFileSync(path.join(__dirname, "..", "worker", "_worker.js"), "utf8");
  const pick = name => { const s = w.indexOf(name); return w.slice(s, w.indexOf("\n}\n", s) + 2); };
  const customToken = new Function("crypto", "atob",
    ["function b64urlEncode(", "function b64urlEncodeText(", "async function customToken("].map(pick).join("\n") + "; return customToken;")(webcrypto, atob);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = { client_email: "sa@x.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const jwt = await customToken(sa, "uid123");
  const [h, c, s] = jwt.split(".");
  assert.ok(crypto.verify("sha256", Buffer.from(h + "." + c), publicKey, Buffer.from(s, "base64url")));
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.strictEqual(claims.uid, "uid123");
  assert.strictEqual(claims.iss, sa.client_email);
  assert.match(claims.aud, /identitytoolkit/);
  assert.ok(claims.exp - claims.iat <= 3600);
});

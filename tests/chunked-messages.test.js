// Large photos/files are split over chunk documents (sendEncryptedTo /
// decryptMessage in app.js). Runs the real code with real WebCrypto against
// an in-memory Firestore that enforces Firestore's size limits.
const test = require("node:test");
const assert = require("node:assert");
const { extract, b64Helpers } = require("./helpers");

const DOC_LIMIT = 1048576;   // Firestore: 1 MiB per document
const BATCH_LIMIT = 10485760; // Firestore: 10 MiB per batch request

function fakeFirestore() {
  const store = new Map();
  let autoId = 0;
  const check = d => {
    const n = Buffer.byteLength(JSON.stringify(d));
    if (n > DOC_LIMIT) throw new Error("document too large: " + n);
  };
  const docRef = p => ({
    path: p,
    id: p.split("/").pop(),
    get: async () => ({ exists: store.has(p), data: () => store.get(p) }),
    delete: async () => { store.delete(p); },
  });
  const col = p => ({
    doc: id => docRef(p + "/" + (id || "auto" + ++autoId)),
    add: async d => { check(d); const r = docRef(p + "/auto" + ++autoId); store.set(r.path, d); return r; },
  });
  const fbDb = {
    collection: c => ({ doc: id => ({ collection: s => col(c + "/" + id + "/" + s), update: async () => {} }) }),
    batch: () => {
      const ops = [];
      return {
        set: (r, d) => ops.push([r, d]),
        commit: async () => {
          let total = 0;
          for (const [, d] of ops) { check(d); total += Buffer.byteLength(JSON.stringify(d)); }
          if (total > BATCH_LIMIT) throw new Error("batch too large: " + total);
          for (const [r, d] of ops) store.set(r.path, d);
        },
      };
    },
  };
  return { fbDb, store };
}

async function load() {
  const { fbDb, store } = fakeFirestore();
  const keys = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["encrypt", "decrypt"]);
  const firebase = { firestore: { FieldValue: { serverTimestamp: () => "TS", increment: () => 1 }, Timestamp: { fromMillis: m => m } } };
  const code =
    extract("  const CHUNK_CHARS", "  function renderMessages(") +
    extract("  async function wrapAesKeyForPublicKey(", "  async function sendEncrypted(payloadText") +
    extract("  async function sendEncryptedTo(", "  document.getElementById(\"message-send-btn\")");
  const api = new Function("fbDb", "firebase", "env",
    b64Helpers +
    "let { myUid, myPublicKey, myPrivateKey, myBlocked, conversations, getPublicKeyForUid, requestPush } = env;\n" +
    code + "\nreturn { sendEncryptedTo, decryptMessage, deleteChunks };")(fbDb, firebase, {
    myUid: "me", myPublicKey: keys.publicKey, myPrivateKey: keys.privateKey, myBlocked: {},
    conversations: new Map(), getPublicKeyForUid: async () => keys.publicKey, requestPush: () => {},
  });
  return { api, store };
}

function filePayload(size) {
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(65536))).toString("base64");
  const body = random.repeat(Math.ceil((size * 4) / 3 / random.length) + 1).slice(0, Math.ceil((size * 4) / 3));
  return JSON.stringify({ name: "x.bin", mime: "", size, dataUrl: "data:application/octet-stream;base64," + body });
}

for (const [label, size, chunked] of [["1 KB", 1024, false], ["600 KB", 600 * 1024, true], ["10 MB", 10 * 1024 * 1024, true]]) {
  test(`a ${label} file round-trips${chunked ? " through chunk documents" : " in one document"}`, async () => {
    const { api, store } = await load();
    const payload = filePayload(size);
    await api.sendEncryptedTo("conv1", ["other"], payload, "file");
    const message = [...store.values()].find(d => d.ts);
    const chunkDocs = [...store.values()].filter(d => d.chunkOf);
    assert.strictEqual(!!message.chunked, chunked);
    assert.strictEqual(chunkDocs.length, chunked ? message.chunked.n : 0);
    // Chunk documents must stay invisible to the ts-ordered queries.
    assert.ok(chunkDocs.every(d => !("ts" in d)));
    assert.strictEqual(await api.decryptMessage(message), payload);
    if (chunked) {
      await api.deleteChunks(message.chunked);
      assert.strictEqual([...store.values()].filter(d => d.chunkOf).length, 0);
    }
  });
}

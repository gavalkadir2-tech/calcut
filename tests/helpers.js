// app.js is one browser IIFE with no exports, so the tests cut the pieces
// they need out of the real source by their surrounding markers and run
// them with stand-ins for the browser and Firebase. A marker that moves
// fails the test loudly instead of silently testing stale code.
const fs = require("fs");
const path = require("path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function extract(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found in app.js: " + startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error("marker not found in app.js: " + endMarker);
  return appSource.slice(start, end);
}

const b64Helpers = `
function b64encode(buf) { return Buffer.from(new Uint8Array(buf)).toString("base64"); }
function b64decode(s) { const b = Buffer.from(s, "base64"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }
`;

function memoryLocalStorage() {
  const store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
}

const DOC_LIMIT = 1048576;   // Firestore: 1 MiB per document
const BATCH_LIMIT = 10485760; // Firestore: 10 MiB per batch request

// Stand-in for firebase.firestore.Blob (bytes fields).
class FakeBytes {
  constructor(u8) { this.u8 = u8; }
  static fromUint8Array(u8) { return new FakeBytes(u8); }
  toUint8Array() { return this.u8; }
  toJSON() { return { bytes: this.u8.length }; }
}

function docSize(d) {
  let n = Buffer.byteLength(JSON.stringify(d));
  for (const v of Object.values(d)) if (v instanceof FakeBytes) n += v.u8.length;
  return n;
}

// In-memory Firestore enforcing Firestore's document and batch size limits.
function fakeFirestore() {
  const store = new Map();
  let autoId = 0;
  const check = d => {
    const n = docSize(d);
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
          for (const [, d] of ops) { check(d); total += docSize(d); }
          if (total > BATCH_LIMIT) throw new Error("batch too large: " + total);
          for (const [r, d] of ops) store.set(r.path, d);
        },
      };
    },
  };
  return { fbDb, store };
}

// The real message encryption/sending code from app.js, with me as both
// sender and recipient (my key pair stands in for the other side too).
async function loadMessaging() {
  const { fbDb, store } = fakeFirestore();
  const keys = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["encrypt", "decrypt"]);
  const firebase = { firestore: {
    FieldValue: { serverTimestamp: () => "TS", increment: () => 1 },
    Timestamp: { fromMillis: m => m },
    Blob: FakeBytes,
  } };
  const code =
    extract("  const CHUNK_CHARS", "  /* ---------------- Replies") +
    extract("  async function wrapAesKeyForPublicKey(", "  async function sendEncrypted(payloadText") +
    extract("  async function sendEncryptedTo(", "  document.getElementById(\"message-send-btn\")");
  const api = new Function("fbDb", "firebase", "env",
    b64Helpers +
    "let { myUid, myPublicKey, myPrivateKey, myBlocked, conversations, getPublicKeyForUid, requestPush } = env;\n" +
    code + "\nreturn { sendEncryptedTo, decryptMessage, deleteChunks, sendLargeFileTo, downloadLargeFile, chunkIv, BIN_CHUNK_BYTES, LARGE_FILE_MAX };")(fbDb, firebase, {
    myUid: "me", myPublicKey: keys.publicKey, myPrivateKey: keys.privateKey, myBlocked: {},
    conversations: new Map(), getPublicKeyForUid: async () => keys.publicKey, requestPush: () => {},
  });
  return { api, store, docSize };
}

module.exports = { extract, b64Helpers, memoryLocalStorage, loadMessaging, DOC_LIMIT };

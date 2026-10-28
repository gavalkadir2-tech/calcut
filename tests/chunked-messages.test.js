// Large photos/files are split over chunk documents (sendEncryptedTo /
// decryptMessage in app.js). Runs the real code with real WebCrypto against
// an in-memory Firestore that enforces Firestore's size limits.
const test = require("node:test");
const assert = require("node:assert");

const { loadMessaging: load } = require("./helpers");

function filePayload(size) {
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(65536))).toString("base64");
  const body = random.repeat(Math.ceil((size * 4) / 3 / random.length) + 1).slice(0, Math.ceil((size * 4) / 3));
  return JSON.stringify({ name: "x.bin", mime: "", size, dataUrl: "data:application/octet-stream;base64," + body });
}

for (const [label, size, chunked] of [["1 KB", 1024, false], ["600 KB", 600 * 1024, true], ["10 MB", 10 * 1024 * 1024, true], ["50 MB (the send limit)", 50 * 1024 * 1024, true]]) {
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

test("a reply stores only the replied-to id, unencrypted, next to the ciphertext", async () => {
  const { api, store } = await load();
  await api.sendEncryptedTo("conv1", ["other"], "evet, yarın", "text", { replyTo: "msg42" });
  const message = [...store.values()].find(d => d.ts);
  assert.strictEqual(message.replyTo, "msg42");
  assert.strictEqual(message.from, "me");
  assert.ok(!JSON.stringify(message).includes("yarın")); // the text itself stays encrypted
  assert.strictEqual(await api.decryptMessage(message), "evet, yarın");
});

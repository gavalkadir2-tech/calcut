// Large files (videos) as encrypted byte chunks: sendLargeFileTo /
// downloadLargeFile in app.js, against an in-memory Firestore that
// enforces Firestore's size limits.
const test = require("node:test");
const assert = require("node:assert");
const { loadMessaging, DOC_LIMIT } = require("./helpers");

function randomFile(size, name, type) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, size)));
  return { file: new File([bytes], name, { type }), bytes };
}

test("a 30 MB video round-trips through byte chunks, each under the document limit", async () => {
  const { api, store, docSize } = await loadMessaging();
  const { file, bytes } = randomFile(30 * 1024 * 1024, "klip.mp4", "video/mp4");
  const progress = [];
  await api.sendLargeFileTo("c1", ["other"], file, { replyTo: "m9" }, p => progress.push(p));
  const message = [...store.values()].find(d => d.ts);
  const chunks = [...store.values()].filter(d => d.chunkOf);
  assert.strictEqual(message.type, "file");
  assert.strictEqual(message.replyTo, "m9");
  assert.ok(message.chunked.bin);
  assert.strictEqual(chunks.length, Math.ceil(file.size / api.BIN_CHUNK_BYTES));
  assert.ok(chunks.every(c => docSize(c) < DOC_LIMIT && !("ts" in c)));
  assert.strictEqual(progress.at(-1), 1);
  // Stored ~1x the file, not ~1.8x like base64 chunks.
  const stored = chunks.reduce((n, c) => n + docSize(c), 0);
  assert.ok(stored < file.size * 1.05, "stored " + stored);
  // The message itself only holds the encrypted metadata.
  const meta = JSON.parse(await api.decryptMessage(message));
  assert.deepStrictEqual(meta, { name: "klip.mp4", mime: "video/mp4", size: file.size, binary: true });
  const blob = await api.downloadLargeFile(message.wrappedKeys.me, message.chunked, meta.mime);
  assert.strictEqual(blob.type, "video/mp4");
  assert.deepStrictEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test("no two chunks share an IV", async () => {
  const { api } = await loadMessaging();
  const base = crypto.getRandomValues(new Uint8Array(12));
  const ivs = new Set();
  for (let i = 0; i < 300; i++) ivs.add(Buffer.from(api.chunkIv(base, i)).toString("hex"));
  assert.strictEqual(ivs.size, 300);
});

test("a tampered chunk fails to decrypt instead of returning bad data", async () => {
  const { api, store } = await loadMessaging();
  const { file } = randomFile(2 * 1024 * 1024, "a.bin", "");
  await api.sendLargeFileTo("c1", ["other"], file);
  const message = [...store.values()].find(d => d.ts);
  const chunk = [...store.values()].find(d => d.chunkOf && d.idx === 1);
  chunk.bin.u8[10] ^= 1;
  await assert.rejects(api.downloadLargeFile(message.wrappedKeys.me, message.chunked, ""));
});

test("deleting removes every byte chunk", async () => {
  const { api, store } = await loadMessaging();
  const { file } = randomFile(3 * 1024 * 1024, "b.bin", "");
  await api.sendLargeFileTo("c1", ["other"], file);
  const message = [...store.values()].find(d => d.ts);
  await api.deleteChunks(message.chunked);
  assert.strictEqual([...store.values()].filter(d => d.chunkOf).length, 0);
});

test("the limit is 200 MB", async () => {
  const { api } = await loadMessaging();
  assert.strictEqual(api.LARGE_FILE_MAX, 200 * 1024 * 1024);
});

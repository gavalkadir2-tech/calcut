const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { extract } = require("./helpers");

const parseJsonSrc = extract("  function parseJson(", "\n  }\n") + "\n  }\n";
const src = parseJsonSrc +
  extract("  const ALBUM_MAX = 10;", "  const albumModal") +
  extract("  function albumChunks(", "  // Resolves with { hd }") +
  extract("  function parseAlbum(", "  /* ---------------- Video notes") +
  extract("  function parseVideoNote(", "  function renderVideoNote(") +
  extract("  function splitEmoji(", "  function recentEmojis(") +
  extract("  function draftOf(", "  // Keeps the composer's text");
const api = new Function("localSessionData", src +
  "; return { ALBUM_MAX, albumChunks, parseAlbum, parseVideoNote, splitEmoji, draftOf };")({ drafts: { c1: "yarım kalan", c2: 5 } });

test("albums: split into messages of up to ten photos; only image data URLs kept", () => {
  assert.deepStrictEqual(api.albumChunks([1, 2, 3]).map(g => g.length), [3]);
  assert.deepStrictEqual(api.albumChunks(Array.from({ length: 23 }, (_, i) => i)).map(g => g.length), [10, 10, 3]);
  const jpg = "data:image/jpeg;base64,AAAA";
  assert.deepStrictEqual(api.parseAlbum(JSON.stringify({ images: [jpg, "javascript:alert(1)", 5, "data:text/html;base64,AA"] })), [jpg]);
  assert.strictEqual(api.parseAlbum(JSON.stringify({ images: [] })), null);
  assert.strictEqual(api.parseAlbum("not json"), null);
});

test("video notes: only video data URLs", () => {
  assert.ok(api.parseVideoNote(JSON.stringify({ dataUrl: "data:video/webm;base64,AA", duration: 3 })));
  assert.ok(api.parseVideoNote(JSON.stringify({ dataUrl: "data:video/mp4;base64,AA" })));
  assert.strictEqual(api.parseVideoNote(JSON.stringify({ dataUrl: "https://x/v.mp4" })), null);
  assert.strictEqual(api.parseVideoNote(JSON.stringify({ dataUrl: "data:text/html,<b>" })), null);
});

test("emoji: flags, skin tones and joined emoji stay one each", () => {
  assert.deepStrictEqual(api.splitEmoji("😀👍🏽❤️😮‍💨🇹🇷"), ["😀", "👍🏽", "❤️", "😮‍💨", "🇹🇷"]);
});

test("drafts: per chat, text only", () => {
  assert.strictEqual(api.draftOf("c1"), "yarım kalan");
  assert.strictEqual(api.draftOf("c2"), "");
  assert.strictEqual(api.draftOf("nope"), "");
});

test("Code.gs: GIFs only from Tenor's media host", () => {
  const gs = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
  const start = gs.indexOf("function gifFetch_(");
  const body = gs.slice(start, gs.indexOf("\n}\n", start) + 2);
  const fetched = [];
  const gifFetch = new Function("UrlFetchApp", "Utilities", body + "; return gifFetch_;")(
    { fetch: url => { fetched.push(url); return { getResponseCode: () => 200, getContent: () => [71, 73, 70] }; } },
    { base64Encode: b => Buffer.from(b).toString("base64") });
  assert.deepStrictEqual(gifFetch("https://evil.example/a.gif"), { error: "bad url" });
  assert.deepStrictEqual(gifFetch("https://media.tenor.com.evil.example/a.gif"), { error: "bad url" });
  assert.deepStrictEqual(gifFetch("https://media.tenor.com/abc/x.gif"), { dataUrl: "data:image/gif;base64,R0lG" });
  assert.deepStrictEqual(fetched, ["https://media.tenor.com/abc/x.gif"]);
});

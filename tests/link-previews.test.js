const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { extract } = require("./helpers");

const src = extract("  const LINK_RE", "\n") + "\n" + extract("  function parseJson(", "\n  }\n") + "\n  }\n" +
  extract("  function firstLink(", "  async function shrinkPreviewImage(");
const { parseLinkPreview, firstLink, linkHost } = new Function(src + "; return { parseLinkPreview, firstLink, linkHost };")();

test("link previews: only short texts, an http(s) link and a small JPEG", () => {
  const jpg = "data:image/jpeg;base64,AAAA";
  assert.deepStrictEqual(parseLinkPreview(JSON.stringify({ url: "https://ornek.com/a", title: " Başlık ", desc: "Açıklama", image: jpg })),
    { url: "https://ornek.com/a", title: "Başlık", desc: "Açıklama", image: jpg });
  assert.strictEqual(parseLinkPreview({ url: "javascript:alert(1)", title: "x" }), null);
  assert.strictEqual(parseLinkPreview({ url: "https://a.b", title: "", desc: "" }), null);
  assert.strictEqual(parseLinkPreview({ url: "https://a.b", title: "t", image: "data:image/svg+xml;base64,AA" }).image, null);
  assert.strictEqual(parseLinkPreview({ url: "https://a.b", title: "x".repeat(500) }).title.length, 200);
  assert.strictEqual(parseLinkPreview(null), null);
});

test("link previews: the first link in a message, and its host", () => {
  assert.strictEqual(firstLink("bak https://www.ornek.com/x?y=1, sonra http://b.c"), "https://www.ornek.com/x?y=1");
  assert.strictEqual(firstLink("bağlantı yok"), null);
  assert.strictEqual(linkHost("https://www.ornek.com/x"), "ornek.com");
});

test("Code.gs: reads og: tags, falls back to <title>, decodes entities, fetches the image", () => {
  const gs = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
  const fn = name => { const s = gs.indexOf("function " + name + "("); return gs.slice(s, gs.indexOf("\n}\n", s) + 2); };
  const pages = {
    "https://haber.example/a": { type: "text/html; charset=utf-8", body: '<html><head><meta property="og:title" content="Büyük &amp; önemli haber"><meta content="Kısa özet" name="description"><meta property="og:image" content="/img/k.jpg"></head></html>' },
    "https://haber.example/img/k.jpg": { type: "image/jpeg", bytes: [1, 2, 3] },
    "https://sade.example/": { type: "text/html", body: "<title>Sade sayfa</title>" },
    "https://dosya.example/a.zip": { type: "application/zip", body: "" },
  };
  const UrlFetchApp = { fetch: url => {
    const p = pages[url];
    if (!p) throw new Error("dns");
    return { getResponseCode: () => 200, getHeaders: () => ({ "Content-Type": p.type }), getContentText: () => p.body, getContent: () => p.bytes || [] };
  } };
  const linkPreview = new Function("UrlFetchApp", "Utilities", fn("linkPreview_") + fn("metaContent_") + fn("decodeHtml_") + "; return linkPreview_;")(
    UrlFetchApp, { base64Encode: b => Buffer.from(b).toString("base64") });
  assert.deepStrictEqual(linkPreview("https://haber.example/a"), { title: "Büyük & önemli haber", desc: "Kısa özet", image: "data:image/jpeg;base64,AQID" });
  assert.deepStrictEqual(linkPreview("https://sade.example/"), { title: "Sade sayfa", desc: "", image: null });
  assert.deepStrictEqual(linkPreview("https://dosya.example/a.zip"), { error: "not html" });
  assert.deepStrictEqual(linkPreview("https://yok.example/"), { error: "unreachable" });
  assert.deepStrictEqual(linkPreview("ftp://x"), { error: "bad url" });
});

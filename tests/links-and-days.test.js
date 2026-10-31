// Link detection (LINK_RE) and chat day separators (dayLabel) in app.js.
const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

const { LINK_RE, dayLabel } = new Function(`
  ${extract("  const LINK_RE", "  // Plain text with http(s) links made tappable.")}
  ${extract("  function dayLabel(", "  function renderMessages(")}
  return { LINK_RE, dayLabel };
`)();

const links = text => [...text.matchAll(LINK_RE)].map(m => m[0]);

test("finds http(s) links and drops trailing punctuation", () => {
  assert.deepStrictEqual(links("bak: https://ornek.com/a?b=1. sonra"), ["https://ornek.com/a?b=1"]);
  assert.deepStrictEqual(links("(http://x.org/y)"), ["http://x.org/y"]);
  assert.deepStrictEqual(links("iki: https://a.com, https://b.com!"), ["https://a.com", "https://b.com"]);
});

test("ignores anything that isn't http(s)", () => {
  assert.deepStrictEqual(links("javascript:alert(1) data:text/html,x ftp://a.b www.a.com"), []);
});

test("day labels: Bugün, Dün, then a date", () => {
  const now = new Date();
  assert.strictEqual(dayLabel(now.getTime()), "Bugün");
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  assert.strictEqual(dayLabel(y.getTime()), "Dün");
  const old = new Date(now.getFullYear() - 1, 2, 5, 12);
  assert.match(dayLabel(old.getTime()), /5 Mart \d{4}/);
});

test("locations open in the phone's own maps app", () => {
  const { extract } = require("./helpers");
  const { mapUrl, webMapUrl } = new Function(extract("  function mapUrl(", "  function renderLocation(") + "; return { mapUrl, webMapUrl };")();
  assert.strictEqual(mapUrl(41.01, 28.97, "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130"), "geo:41.01,28.97?q=41.01,28.97(Konum)");
  assert.strictEqual(mapUrl(41.01, 28.97, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "https://maps.apple.com/?q=41.01,28.97");
  assert.strictEqual(mapUrl(41.01, 28.97, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), webMapUrl(41.01, 28.97));
  assert.strictEqual(webMapUrl(41.01, 28.97), "https://www.google.com/maps/search/?api=1&query=41.01,28.97");
});

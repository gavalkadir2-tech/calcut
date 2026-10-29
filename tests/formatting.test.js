const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("./helpers");

// Tiny DOM stand-in: renders nodes back to an HTML-ish string.
function fakeDocument() {
  const el = tag => ({ tag, children: [], textContent: "", appendChild(c) { this.children.push(c); } });
  return {
    createTextNode: t => ({ text: t }),
    createElement: tag => el(tag),
    root: () => el("div"),
  };
}
function html(n) {
  if ("text" in n) return n.text;
  if (n.tag === "a") return "<a>" + n.textContent + "</a>";
  const inner = n.children.length ? n.children.map(html).join("") : n.textContent;
  return n.tag === "div" ? inner : `<${n.tag}>${inner}</${n.tag}>`;
}

const src = extract("  const LINK_RE", "  function appendHighlightedText(");
const document = fakeDocument();
const { appendLinkified } = new Function("document", src + "; return { appendLinkified };")(document);
const render = text => { const root = document.root(); appendLinkified(root, text); return html(root); };

test("bold, italic, strike and code", () => {
  assert.strictEqual(render("*kalın* _italik_ ~çizik~ `kod`"), "<strong>kalın</strong> <em>italik</em> <s>çizik</s> <code>kod</code>");
  assert.strictEqual(render("bu *çok önemli*!"), "bu <strong>çok önemli</strong>!");
  assert.strictEqual(render("*_ikisi_*"), "<strong><em>ikisi</em></strong>");
  assert.strictEqual(render("`*değil*`"), "<code>*değil*</code>");
});

test("markers inside words or around spaces stay as typed", () => {
  assert.strictEqual(render("2*3*4"), "2*3*4");
  assert.strictEqual(render("dosya_adi_1"), "dosya_adi_1");
  assert.strictEqual(render("* değil *"), "* değil *");
  assert.strictEqual(render("tek *yıldız"), "tek *yıldız");
});

test("links are not formatted", () => {
  assert.strictEqual(render("bak https://ornek.com/a_b_c ve _bu_"), "bak <a>https://ornek.com/a_b_c</a> ve <em>bu</em>");
});

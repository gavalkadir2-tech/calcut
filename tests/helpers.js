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

module.exports = { extract, b64Helpers, memoryLocalStorage };

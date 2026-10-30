const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "worker", "_worker.js"), "utf8");
const start = src.indexOf("function cleanIceServers(");
const end = src.indexOf("\n}\n", start) + 2;
const cleanIceServers = new Function(src.slice(start, end) + "; return cleanIceServers;")();

test("TURN servers: port 53 URLs (blocked by browsers) are dropped", () => {
  const out = cleanIceServers([{
    urls: [
      "stun:stun.cloudflare.com:3478",
      "stun:stun.cloudflare.com:53",
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:53?transport=udp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
    ],
    username: "u", credential: "c",
  }]);
  assert.deepStrictEqual(out, [{
    urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
    username: "u", credential: "c",
  }]);
});

test("TURN servers: a single object (older API) works too, empty entries go", () => {
  assert.deepStrictEqual(cleanIceServers({ urls: "turn:x:53", username: "u" }), []);
  assert.strictEqual(cleanIceServers({ urls: "turn:x:3478", username: "u", credential: "c" }).length, 1);
});

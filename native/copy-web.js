// Copies the web app from the repo root into www/ so Capacitor can bundle it.
// The web app stays the single source of truth; www/ is generated.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(__dirname, "www");
const files = ["index.html", "app.js", "style.css", "firebase-config.js", "manifest.json", "sw.js"];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.cpSync(path.join(root, "icons"), path.join(out, "icons"), { recursive: true });
console.log("Copied web app into", out);

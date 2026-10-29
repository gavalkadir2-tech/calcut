// Publishes firestore.rules to the Firebase project, like "firebase deploy
// --only firestore:rules", with only Node's own modules. Run by CI on main
// (.github/workflows/tests.yml) once the rules tests pass.
//
//   FIREBASE_SERVICE_ACCOUNT='<service account JSON>' node tools/deploy-firestore-rules.js
//
// The service account is the one from Firebase console > Project settings >
// Service accounts (the same JSON the push server uses).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RULES_FILE = path.join(__dirname, "..", "firestore.rules");

function b64url(data) {
  return Buffer.from(data).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(crypto.sign("RSA-SHA256", Buffer.from(header + "." + claims), sa.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: header + "." + claims + "." + signature,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("token: " + JSON.stringify(data));
  return data.access_token;
}

async function api(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  const sa = JSON.parse(raw);
  const project = sa.project_id;
  const base = "https://firebaserules.googleapis.com/v1/projects/" + project;
  const token = await accessToken(sa);

  const ruleset = await api(token, "POST", base + "/rulesets", {
    source: { files: [{ name: "firestore.rules", content: fs.readFileSync(RULES_FILE, "utf8") }] },
  });
  if (!ruleset.ok) throw new Error("ruleset (" + ruleset.status + "): " + JSON.stringify(ruleset.data));
  const rulesetName = ruleset.data.name;

  const releaseName = "projects/" + project + "/releases/cloud.firestore";
  let release = await api(token, "PATCH", "https://firebaserules.googleapis.com/v1/" + releaseName, {
    release: { name: releaseName, rulesetName },
  });
  if (release.status === 404) {
    release = await api(token, "POST", base + "/releases", { name: releaseName, rulesetName });
  }
  if (!release.ok) throw new Error("release (" + release.status + "): " + JSON.stringify(release.data));
  console.log("Published " + rulesetName + " to " + releaseName);
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});

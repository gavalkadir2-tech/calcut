// calcut push Worker (Cloudflare, free plan).
//
// Runs as-is either as a Worker (paste into "Edit code") or as a Cloudflare
// Pages project in advanced mode: a Pages project connected to this repo with
// build output directory "worker" serves this _worker.js. Pages (*.pages.dev)
// matters because some Turkish ISPs block *.workers.dev.
//
// The app POSTs here after sending a message or while a call is ringing:
//   { kind: "message", convId, msgId } | { kind: "call" | "call-missed", callId }
//   | { kind: "test" } (pushes to the caller's own devices, from Settings)
//   | { kind: "register-token" | "unregister-token", token } (saves / removes this
//     device's FCM token under users/{uid}.fcmTokens; done here with the service
//     account so the Firestore security rules don't need to allow it)
// with the Firebase ID token as "idToken" in the (text/plain) JSON body, or as
// "Authorization: Bearer <token>" from older app versions. The Worker verifies the
// token, checks in Firestore that this user really sent that message / placed
// that call, then sends a data-only FCM push to the recipients' devices
// (users/{uid}.fcmTokens). sw.js turns it into the disguised "Alarm" notification.
//
// Needs one secret: SERVICE_ACCOUNT = the whole JSON of a Firebase service
// account key (Firebase console > Project settings > Service accounts >
// "Generate new private key").

// Bumped when the app needs a newer Worker; the Settings test button checks it.
const WORKER_VERSION = 4;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return reply(405, "method not allowed");
    try {
      const sa = JSON.parse(env.SERVICE_ACCOUNT);
      const body = await request.json();
      const auth = request.headers.get("Authorization") || "";
      const idToken = body.idToken || auth.replace(/^Bearer\s+/i, "");
      const uid = await verifyIdToken(idToken, sa.project_id).catch(() => null);
      if (!uid) return reply(401, "unauthorized");
      if (body.kind === "ice-servers") return reply(200, { iceServers: await turnIceServers(env), v: WORKER_VERSION });
      if (body.kind === "link-token") return reply(200, { token: await customToken(sa, uid), v: WORKER_VERSION });
      const sent = await handle(body, uid, sa);
      return reply(200, { sent, v: WORKER_VERSION });
    } catch (e) {
      return reply(500, String(e && e.message || e));
    }
  },
};

// TURN credentials for calls between phones that can't reach each other
// directly (different mobile networks, strict NAT). Either Cloudflare
// Realtime (secrets TURN_KEY_ID + TURN_KEY_TOKEN) or Metered / Open Relay,
// which needs no credit card (secrets METERED_APP = the "xyz" of
// xyz.metered.live, and METERED_API_KEY). Without either the app keeps
// using STUN only.
async function turnIceServers(env) {
  if (env.METERED_APP && env.METERED_API_KEY && !(env.TURN_KEY_ID && env.TURN_KEY_TOKEN)) {
    const res = await fetch(`https://${encodeURIComponent(env.METERED_APP)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`);
    if (!res.ok) throw new Error("TURN " + res.status);
    return cleanIceServers(await res.json());
  }
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return null;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.TURN_KEY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 86400 }),
  });
  if (!res.ok) throw new Error("TURN " + res.status);
  return cleanIceServers((await res.json()).iceServers);
}

// Browsers block port 53, so those URLs would only time out.
function cleanIceServers(list) {
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map(s => ({
    ...s,
    urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === "string" && !/:53(\?|$)/.test(u)),
  })).filter(s => s.urls.length);
}

function reply(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS),
  });
}

async function handle(body, uid, sa) {
  const fs = new Firestore(sa);
  if (body.kind === "test") return pushToUser(fs, sa, uid, uid, { kind: "test" });
  if (body.kind === "register-token" || body.kind === "unregister-token") {
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_:-]{20,4096}$/.test(body.token)) {
      throw new Error("invalid token");
    }
    if (body.kind === "register-token") {
      await fs.setMapField(`users/${uid}`, "fcmTokens", body.token, { timestampValue: new Date().toISOString() });
    } else {
      await fs.deleteField(`users/${uid}`, "fcmTokens", body.token);
    }
    return 1;
  }
  if (body.kind === "message") {
    if (!isId(body.convId) || !isId(body.msgId)) return 0;
    const msg = await fs.get(`conversations/${body.convId}/messages/${body.msgId}`);
    if (!msg || msg.from !== uid || msg.type === "call") return 0;
    const conv = await fs.get(`conversations/${body.convId}`);
    if (!conv || !Array.isArray(conv.participants) || !conv.participants.includes(uid)) return 0;
    const muted = conv.muted || {};
    // Someone @mentioned in a group is told even if they muted it.
    const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
    const recipients = conv.participants.filter(u => u !== uid && (!muted[u] || mentions.includes(u)));
    let sent = 0;
    for (const r of recipients) sent += await pushToUser(fs, sa, r, uid, { kind: "message" });
    return sent;
  }
  if (body.kind === "call" || body.kind === "call-missed") {
    if (!isId(body.callId)) return 0;
    const call = await fs.get(`calls/${body.callId}`);
    if (!call || call.from !== uid || !call.to) return 0;
    if (body.kind === "call" && call.status !== "ringing") return 0;
    if (body.kind === "call-missed" && (call.status !== "ended" || call.answer)) return 0;
    const data = body.kind === "call" ? { kind: "call", media: call.media || "audio" } : { kind: "call-missed" };
    return pushToUser(fs, sa, call.to, uid, data);
  }
  return 0;
}

function isId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
}

async function pushToUser(fs, sa, toUid, fromUid, data) {
  const user = await fs.get(`users/${toUid}`);
  if (!user) return 0;
  if (user.blocked && user.blocked[fromUid]) return 0;
  const tokens = Object.keys(user.fcmTokens || {});
  const accessToken = await getAccessToken(sa);
  let sent = 0;
  for (const token of tokens) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
      body: JSON.stringify({
        message: {
          token,
          data,
          webpush: { headers: { Urgency: "high", TTL: data.kind === "call" ? "45" : "86400" } },
          // The Android app gets these through native FCM; without "high" Android
          // holds them back while the phone sleeps.
          android: { priority: "high", ttl: data.kind === "call" ? "45s" : "86400s" },
        },
      }),
    });
    if (res.ok) {
      sent++;
    } else if (res.status === 404 || res.status === 400) {
      // UNREGISTERED / invalid token: the device uninstalled or revoked permission.
      await fs.deleteField(`users/${toUid}`, "fcmTokens", token).catch(() => {});
    }
  }
  return sent;
}

/* ---------------- Firebase ID token verification ---------------- */

let jwksCache = null; // { keys, expires }

async function getJwks() {
  if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
  const res = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  const json = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "");
  jwksCache = { keys: json.keys, expires: Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : 3600000) };
  return json.keys;
}

async function verifyIdToken(idToken, projectId) {
  const parts = (idToken || "").split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(b64urlDecodeText(parts[0]));
  const payload = JSON.parse(b64urlDecodeText(parts[1]));
  if (header.alg !== "RS256") return null;
  const jwk = (await getJwks()).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  const now = Math.floor(Date.now() / 1000);
  if (!ok || payload.aud !== projectId || payload.iss !== "https://securetoken.google.com/" + projectId ||
      !payload.exp || payload.exp < now || !payload.sub) {
    return null;
  }
  return payload.sub;
}

/* ---------------- Service account OAuth token ---------------- */

// A Firebase custom token for this user, so a device being linked (see
// "Linked devices" in app.js) can sign in. The phone encrypts it, with the
// keys, to that device's one-time key before handing it over.
async function customToken(sa, uid) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncodeText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlEncodeText(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now,
    exp: now + 3600,
    uid,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(header + "." + claims));
  return header + "." + claims + "." + b64urlEncode(new Uint8Array(sig));
}

let accessTokenCache = null; // { token, expires }

async function getAccessToken(sa) {
  if (accessTokenCache && accessTokenCache.expires > Date.now() + 60000) return accessTokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncodeText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlEncodeText(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(header + "." + claims));
  const assertion = header + "." + claims + "." + b64urlEncode(new Uint8Array(sig));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + assertion,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error("oauth: " + JSON.stringify(json));
  accessTokenCache = { token: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

/* ---------------- Minimal Firestore REST client ---------------- */

class Firestore {
  constructor(sa) {
    this.sa = sa;
    this.base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/`;
  }

  async get(path) {
    const res = await fetch(this.base + path, {
      headers: { "Authorization": "Bearer " + await getAccessToken(this.sa) },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("firestore get " + res.status);
    const doc = await res.json();
    return decodeFields(doc.fields || {});
  }

  // PATCH only doc.mapField.key: a field listed in updateMask but absent
  // from the body is deleted, one present in the body is set.
  async patchMapField(path, mapField, key, fields) {
    const fieldPath = mapField + ".`" + key.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
    const url = this.base + path + "?updateMask.fieldPaths=" + encodeURIComponent(fieldPath) +
      "&currentDocument.exists=true";
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + await getAccessToken(this.sa) },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error("firestore patch " + res.status + ": " + (await res.text()).slice(0, 300));
  }

  deleteField(path, mapField, key) {
    return this.patchMapField(path, mapField, key, {});
  }

  setMapField(path, mapField, key, value) {
    return this.patchMapField(path, mapField, key, { [mapField]: { mapValue: { fields: { [key]: value } } } });
  }
}

function decodeValue(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  return true; // references, bytes, geo points: only presence matters here
}

function decodeFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = decodeValue(fields[k]);
  return out;
}

/* ---------------- base64url helpers ---------------- */

function b64urlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function b64urlDecodeText(str) {
  return new TextDecoder().decode(b64urlDecode(str));
}
function b64urlEncode(bytes) {
  let bin = "";
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeText(str) {
  return b64urlEncode(new TextEncoder().encode(str));
}

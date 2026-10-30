// calcut push server on Google Apps Script (free, no card).
//
// Same job as worker/_worker.js, but served from script.google.com, which
// Turkish ISPs don't block (they block *.workers.dev and *.pages.dev).
//
// The app POSTs a text/plain JSON body (a "simple" request, so the browser
// sends no CORS preflight, which Apps Script can't answer):
//   { idToken, kind: "message", convId, msgId } | { idToken, kind: "call" | "call-missed", callId }
//   | { idToken, kind: "test" } | { idToken, kind: "register-token" | "unregister-token", token }
// The ID token is checked with Google (Identity Toolkit accounts:lookup), the
// sender is verified in Firestore, then a data-only FCM push goes to the
// recipients' devices (users/{uid}.fcmTokens).
//
// Apps Script always answers HTTP 200, so failures come back as { error }.
//
// Setup: Project Settings > Script properties > SERVICE_ACCOUNT = the whole
// JSON of a Firebase service account key; then Deploy > New deployment >
// Web app, Execute as: Me, Who has access: Anyone.

const WORKER_VERSION = 3;
// The Firebase web API key (public, same as in firebase-config.js); only used
// to ask Google whether an ID token is valid.
const FIREBASE_API_KEY = "AIzaSyB0JTRgod2uk5KtYtnd4OLiG0LQ5qwxEwI";

function doGet() {
  return json_({ error: "method not allowed", v: WORKER_VERSION });
}

function doPost(e) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty("SERVICE_ACCOUNT");
    if (!raw) return json_({ error: "SERVICE_ACCOUNT script property is missing", v: WORKER_VERSION });
    const sa = JSON.parse(raw);
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const uid = verifyIdToken_(body.idToken);
    if (!uid) return json_({ error: "unauthorized", v: WORKER_VERSION });
    if (body.kind === "ice-servers") return json_({ iceServers: turnIceServers_(), v: WORKER_VERSION });
    const sent = handle_(body, uid, sa);
    return json_({ sent: sent, v: WORKER_VERSION });
  } catch (err) {
    return json_({ error: String((err && err.message) || err), v: WORKER_VERSION });
  }
}

// Short-lived TURN credentials from Cloudflare Realtime, for calls between
// phones that can't reach each other directly. Needs the script properties
// TURN_KEY_ID and TURN_KEY_TOKEN; without them the app uses STUN only.
function turnIceServers_() {
  const props = PropertiesService.getScriptProperties();
  const keyId = props.getProperty("TURN_KEY_ID");
  const token = props.getProperty("TURN_KEY_TOKEN");
  if (!keyId || !token) return null;
  const res = UrlFetchApp.fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + keyId + "/credentials/generate-ice-servers", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ ttl: 86400 }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error("TURN " + res.getResponseCode());
  const list = JSON.parse(res.getContentText()).iceServers;
  // Browsers block port 53, so those URLs would only time out.
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map(function (s) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(function (u) {
      return typeof u === "string" && !/:53(\?|$)/.test(u);
    });
    return { urls: urls, username: s.username, credential: s.credential };
  }).filter(function (s) { return s.urls.length; });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(body, uid, sa) {
  const fs = new Firestore_(sa);
  if (body.kind === "test") return pushToUser_(fs, sa, uid, uid, { kind: "test" });
  if (body.kind === "register-token" || body.kind === "unregister-token") {
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_:-]{20,4096}$/.test(body.token)) {
      throw new Error("invalid token");
    }
    if (body.kind === "register-token") {
      fs.setMapField(`users/${uid}`, "fcmTokens", body.token, { timestampValue: new Date().toISOString() });
    } else {
      fs.deleteField(`users/${uid}`, "fcmTokens", body.token);
    }
    return 1;
  }
  if (body.kind === "message") {
    if (!isId_(body.convId) || !isId_(body.msgId)) return 0;
    const msg = fs.get(`conversations/${body.convId}/messages/${body.msgId}`);
    if (!msg || msg.from !== uid || msg.type === "call") return 0;
    const conv = fs.get(`conversations/${body.convId}`);
    if (!conv || !Array.isArray(conv.participants) || conv.participants.indexOf(uid) < 0) return 0;
    const muted = conv.muted || {};
    // Someone @mentioned in a group is told even if they muted it.
    const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
    let sent = 0;
    conv.participants
      .filter(u => u !== uid && (!muted[u] || mentions.indexOf(u) >= 0))
      .forEach(r => { sent += pushToUser_(fs, sa, r, uid, { kind: "message" }); });
    return sent;
  }
  if (body.kind === "call" || body.kind === "call-missed") {
    if (!isId_(body.callId)) return 0;
    const call = fs.get(`calls/${body.callId}`);
    if (!call || call.from !== uid || !call.to) return 0;
    if (body.kind === "call" && call.status !== "ringing") return 0;
    if (body.kind === "call-missed" && (call.status !== "ended" || call.answer)) return 0;
    const data = body.kind === "call" ? { kind: "call", media: call.media || "audio" } : { kind: "call-missed" };
    return pushToUser_(fs, sa, call.to, uid, data);
  }
  return 0;
}

function isId_(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
}

function pushToUser_(fs, sa, toUid, fromUid, data) {
  const user = fs.get(`users/${toUid}`);
  if (!user) return 0;
  if (user.blocked && user.blocked[fromUid]) return 0;
  const tokens = Object.keys(user.fcmTokens || {});
  if (!tokens.length) return 0;
  const accessToken = getAccessToken_(sa);
  const requests = tokens.map(token => ({
    url: `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + accessToken },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      message: {
        token: token,
        data: data,
        webpush: { headers: { Urgency: "high", TTL: data.kind === "call" ? "45" : "86400" } },
        // The Android app gets these through native FCM; without "high" Android
        // holds them back while the phone sleeps.
        android: { priority: "high", ttl: data.kind === "call" ? "45s" : "86400s" },
      },
    }),
  }));
  let sent = 0;
  UrlFetchApp.fetchAll(requests).forEach((res, i) => {
    const code = res.getResponseCode();
    if (code === 200) {
      sent++;
    } else if (code === 404 || code === 400) {
      // UNREGISTERED / invalid token: the device uninstalled or revoked permission.
      try { fs.deleteField(`users/${toUid}`, "fcmTokens", tokens[i]); } catch (e) {}
    }
  });
  return sent;
}

/* ---------------- Firebase ID token check ---------------- */

// Google validates the token (signature, expiry, project) and returns the user.
// Results are cached for a few minutes so ringing re-pushes stay fast.
function verifyIdToken_(idToken) {
  if (typeof idToken !== "string" || idToken.split(".").length !== 3) return null;
  const cache = CacheService.getScriptCache();
  const cacheKey = "idt_" + hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const res = UrlFetchApp.fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_API_KEY,
    { method: "post", contentType: "application/json", payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return null;
  const users = JSON.parse(res.getContentText()).users || [];
  const uid = users.length ? users[0].localId : null;
  if (uid) cache.put(cacheKey, uid, 300);
  return uid;
}

function hex_(bytes) {
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}

/* ---------------- Service account OAuth token ---------------- */

function getAccessToken_(sa) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("access_token");
  if (cached) return cached;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url_(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url_(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signature = Utilities.computeRsaSha256Signature(header + "." + claims, sa.private_key);
  const assertion = header + "." + claims + "." + Utilities.base64EncodeWebSafe(signature).replace(/=+$/, "");
  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion },
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText());
  if (!json.access_token) throw new Error("oauth: " + res.getContentText());
  // Cache a bit shorter than the token lives.
  cache.put("access_token", json.access_token, Math.max(60, Math.min(3000, json.expires_in - 300)));
  return json.access_token;
}

function b64url_(str) {
  return Utilities.base64EncodeWebSafe(str, Utilities.Charset.UTF_8).replace(/=+$/, "");
}

/* ---------------- Minimal Firestore REST client ---------------- */

class Firestore_ {
  constructor(sa) {
    this.sa = sa;
    this.base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/`;
  }

  get(path) {
    const res = UrlFetchApp.fetch(this.base + path, {
      headers: { Authorization: "Bearer " + getAccessToken_(this.sa) },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 404) return null;
    if (res.getResponseCode() !== 200) throw new Error("firestore get " + res.getResponseCode());
    return decodeFields_(JSON.parse(res.getContentText()).fields || {});
  }

  // PATCH only doc.mapField.key: a field listed in updateMask but absent
  // from the body is deleted, one present in the body is set.
  patchMapField(path, mapField, key, fields) {
    const fieldPath = mapField + ".`" + key.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
    const url = this.base + path + "?updateMask.fieldPaths=" + encodeURIComponent(fieldPath) +
      "&currentDocument.exists=true";
    const res = UrlFetchApp.fetch(url, {
      method: "patch",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + getAccessToken_(this.sa) },
      payload: JSON.stringify({ fields: fields }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error("firestore patch " + res.getResponseCode() + ": " + res.getContentText().slice(0, 300));
    }
  }

  deleteField(path, mapField, key) {
    this.patchMapField(path, mapField, key, {});
  }

  setMapField(path, mapField, key, value) {
    this.patchMapField(path, mapField, key, { [mapField]: { mapValue: { fields: { [key]: value } } } });
  }
}

function decodeValue_(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields_(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue_);
  return true; // references, bytes, geo points: only presence matters here
}

function decodeFields_(fields) {
  const out = {};
  Object.keys(fields).forEach(k => { out[k] = decodeValue_(fields[k]); });
  return out;
}

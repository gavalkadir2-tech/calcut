// calcut push server on Google Apps Script (free, no card).
//
// Same job as worker/_worker.js, but served from script.google.com, which
// Turkish ISPs don't block (they block *.workers.dev and *.pages.dev).
//
// The app POSTs a text/plain JSON body (a "simple" request, so the browser
// sends no CORS preflight, which Apps Script can't answer):
//   { idToken, kind: "message", convId, msgId } | { idToken, kind: "call" | "call-missed", callId }
//   | { idToken, kind: "test" } | { idToken, kind: "register-token" | "unregister-token", token }
//   | { idToken, kind: "schedule" } (starts the every-minute delivery of scheduled messages)
//   | { idToken, kind: "gif-search", q } | { idToken, kind: "gif-fetch", url } (Tenor, script property TENOR_KEY)
//   | { idToken, kind: "translate", text, to, toName?, natural? } (Google Translate, no key needed;
//     natural: Gemini with script property GEMINI_KEY, keeping idioms and slang)
//   | { idToken, kind: "link-preview", url } (title, description and image of a page)
//   | { kind: "ack", u, c, m, t } (no idToken: a phone saying a message push reached it,
//     signed by this server in the push itself; marks the message delivered)
// The ID token is checked with Google (Identity Toolkit accounts:lookup), the
// sender is verified in Firestore, then a data-only FCM push goes to the
// recipients' devices (users/{uid}.fcmTokens).
//
// Apps Script always answers HTTP 200, so failures come back as { error }.
//
// Setup: Project Settings > Script properties > SERVICE_ACCOUNT = the whole
// JSON of a Firebase service account key; then Deploy > New deployment >
// Web app, Execute as: Me, Who has access: Anyone. For scheduled messages,
// run setup() once from the editor (▶ Run) and allow it: that lets the
// script start its own every-minute timer.

const WORKER_VERSION = 10;
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
    if (body.kind === "ack") return json_({ ok: deliveryAck_(new Firestore_(sa), body), v: WORKER_VERSION });
    const uid = verifyIdToken_(body.idToken);
    if (!uid) return json_({ error: "unauthorized", v: WORKER_VERSION });
    if (body.kind === "ice-servers") return json_({ iceServers: turnIceServers_(), v: WORKER_VERSION });
    if (body.kind === "link-token") return json_({ token: customToken_(sa, uid), v: WORKER_VERSION });
    if (body.kind === "link-preview") return json_(Object.assign(linkPreview_(body.url), { v: WORKER_VERSION }));
    if (body.kind === "translate") return json_(Object.assign(translate_(body.text, body.to, body.natural ? body.toName : null), { v: WORKER_VERSION }));
    if (body.kind === "gif-search") return json_(Object.assign(gifSearch_(body.q), { v: WORKER_VERSION }));
    if (body.kind === "gif-fetch") return json_(Object.assign(gifFetch_(body.url), { v: WORKER_VERSION }));
    if (body.kind === "schedule") {
      try {
        ensureScheduleTrigger_();
      } catch (err) {
        return json_({ scheduled: false, error: "run setup() once in the Apps Script editor: " + String((err && err.message) || err), v: WORKER_VERSION });
      }
      return json_({ scheduled: true, v: WORKER_VERSION });
    }
    const sent = handle_(body, uid, sa);
    return json_({ sent: sent, v: WORKER_VERSION });
  } catch (err) {
    return json_({ error: String((err && err.message) || err), v: WORKER_VERSION });
  }
}

// TURN credentials for calls between phones that can't reach each other
// directly. Either Cloudflare Realtime (script properties TURN_KEY_ID +
// TURN_KEY_TOKEN) or Metered / Open Relay, which needs no credit card
// (METERED_APP = the "xyz" of xyz.metered.live, and METERED_API_KEY).
// Without either the app uses STUN only.
function turnIceServers_() {
  const props = PropertiesService.getScriptProperties();
  const keyId = props.getProperty("TURN_KEY_ID");
  const token = props.getProperty("TURN_KEY_TOKEN");
  const meteredApp = props.getProperty("METERED_APP");
  const meteredKey = props.getProperty("METERED_API_KEY");
  let list;
  if (keyId && token) {
    const res = UrlFetchApp.fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + keyId + "/credentials/generate-ice-servers", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({ ttl: 86400 }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) throw new Error("TURN " + res.getResponseCode());
    list = JSON.parse(res.getContentText()).iceServers;
  } else if (meteredApp && meteredKey) {
    const res = UrlFetchApp.fetch("https://" + encodeURIComponent(meteredApp) + ".metered.live/api/v1/turn/credentials?apiKey=" +
      encodeURIComponent(meteredKey), { muteHttpExceptions: true });
    if (res.getResponseCode() >= 300) throw new Error("TURN " + res.getResponseCode());
    list = JSON.parse(res.getContentText());
  } else {
    return null;
  }
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
      .forEach(r => { sent += pushToUser_(fs, sa, r, uid, messagePush_(r, body.convId, body.msgId)); });
    if (!conv.isGroup && conv.participants.length === 2 && !msg.autoReply) {
      const other = conv.participants.filter(u => u !== uid)[0];
      try { autoReply_(fs, sa, other, uid, body.convId); } catch (e) { Logger.log("auto-reply: " + e); }
    }
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

/* ---------------- Delivery receipts from the push ----------------
   A message push carries who it is for, which message, a signature and
   this server's address; the phone that gets it (CalcutMessagingService,
   sw.js) posts them back as { kind: "ack" }, and the message gets its
   "delivered" (two ticks) as soon as the push arrives, before the app is
   opened. The signature (HMAC with ACK_SECRET, made on first use) means
   nobody else can mark messages delivered. */

function ackSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty("ACK_SECRET");
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("ACK_SECRET", secret);
  }
  return secret;
}

function ackToken_(uid, convId, msgId) {
  const sig = Utilities.computeHmacSha256Signature(uid + "|" + convId + "|" + msgId, ackSecret_());
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, "").slice(0, 32);
}

function messagePush_(toUid, convId, msgId) {
  const data = { kind: "message" };
  if (!isId_(convId) || !isId_(msgId)) return data;
  let url = "";
  try { url = ScriptApp.getService().getUrl() || ""; } catch (e) {}
  if (!/^https:\/\/script\.google\.com\//.test(url)) return data;
  return Object.assign(data, { u: toUid, c: convId, m: msgId, t: ackToken_(toUid, convId, msgId), a: url });
}

function deliveryAck_(fs, body) {
  if (!isId_(body.u) || !isId_(body.c) || !isId_(body.m) || typeof body.t !== "string") return false;
  if (body.t !== ackToken_(body.u, body.c, body.m)) return false;
  const conv = fs.get(`conversations/${body.c}`);
  if (!conv || !Array.isArray(conv.participants) || conv.participants.indexOf(body.u) < 0) return false;
  const path = `conversations/${body.c}/messages/${body.m}`;
  if (conv.isGroup) {
    fs.setMapField(path, "deliveredTo", body.u, { timestampValue: new Date().toISOString() });
  } else {
    fs.patchFields(path, { delivered: { booleanValue: true } });
  }
  return true;
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

/* ---------------- Link previews ----------------
   The page's og: / twitter: / <title> tags and a small image, so the app
   can send them (encrypted) with a message that has a link. */

function linkPreview_(url) {
  if (typeof url !== "string" || url.length > 2000 || !/^https?:\/\/[^\s/]+/.test(url)) return { error: "bad url" };
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { "Accept-Language": "tr,en;q=0.8" } });
  } catch (e) {
    return { error: "unreachable" };
  }
  if (res.getResponseCode() >= 400) return { error: "http " + res.getResponseCode() };
  const type = String(res.getHeaders()["Content-Type"] || res.getHeaders()["content-type"] || "");
  if (type && !/html/i.test(type)) return { error: "not html" };
  const html = res.getContentText().slice(0, 300000);
  const title = metaContent_(html, ["og:title", "twitter:title"]) || ((/<title[^>]*>([^<]{1,300})<\/title>/i.exec(html) || [])[1] || "");
  const desc = metaContent_(html, ["og:description", "twitter:description", "description"]);
  let image = null;
  const imageUrl = metaContent_(html, ["og:image", "og:image:url", "twitter:image"]);
  if (imageUrl) {
    try {
      const abs = /^https?:\/\//.test(imageUrl) ? imageUrl
        : imageUrl.indexOf("//") === 0 ? "https:" + imageUrl
        : url.replace(/^(https?:\/\/[^/]+).*$/, "$1") + (imageUrl.charAt(0) === "/" ? "" : "/") + imageUrl;
      const img = UrlFetchApp.fetch(abs, { muteHttpExceptions: true, followRedirects: true });
      const imgType = String(img.getHeaders()["Content-Type"] || img.getHeaders()["content-type"] || "").split(";")[0];
      const bytes = img.getContent();
      if (img.getResponseCode() === 200 && /^image\/(jpeg|png|gif|webp)$/.test(imgType) && bytes.length <= 600000) {
        image = "data:" + imgType + ";base64," + Utilities.base64Encode(bytes);
      }
    } catch (e) { /* no image */ }
  }
  if (!title && !desc) return { error: "no preview" };
  return { title: decodeHtml_(title).slice(0, 200), desc: decodeHtml_(desc || "").slice(0, 300), image: image };
}

function metaContent_(html, names) {
  for (let i = 0; i < names.length; i++) {
    const n = names[i].replace(/[.:]/g, "\\$&");
    const m = new RegExp("<meta[^>]+(?:property|name)=[\"']" + n + "[\"'][^>]*content=[\"']([^\"']*)[\"']", "i").exec(html) ||
      new RegExp("<meta[^>]+content=[\"']([^\"']*)[\"'][^>]*(?:property|name)=[\"']" + n + "[\"']", "i").exec(html);
    if (m && m[1].trim()) return m[1].trim();
  }
  return "";
}

function decodeHtml_(s) {
  return String(s).replace(/&#(\d+);/g, (m, c) => String.fromCharCode(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (m, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/* ---------------- Translation ---------------- */

// naturalName (e.g. "German (Deutsch)"): translate like a native speaker
// would write it, with Gemini (free key from aistudio.google.com, script
// property GEMINI_KEY; GEMINI_MODEL optional); else Google Translate.
function translate_(text, to, naturalName) {
  if (typeof text !== "string" || !text.trim() || text.length > 5000) return { error: "bad text" };
  const target = typeof to === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(to) ? to : "tr";
  const key = PropertiesService.getScriptProperties().getProperty("GEMINI_KEY");
  if (key && typeof naturalName === "string" && /^[\p{L} ()]{2,40}$/u.test(naturalName)) {
    try {
      const out = geminiTranslate_(key, text, naturalName);
      if (out) return { text: out, engine: "gemini" };
    } catch (e) { /* fall back to Google Translate */ }
  }
  return { text: LanguageApp.translate(text, "", target), engine: "google" };
}

function geminiTranslate_(key, text, languageName) {
  const model = PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL") || "gemini-2.5-flash";
  const prompt = "You translate chat messages between friends. Translate the message below into " + languageName +
    " the way a native speaker would naturally write it in a casual chat: keep the tone, emotion and emojis; " +
    "replace idioms, slang and jokes with natural equivalents in that language instead of translating them word for word; " +
    "keep names, @mentions, links and numbers as they are. If it is already in that language, return it unchanged. " +
    "Reply with only the translated message, nothing else.\n\nMessage:\n" + text;
  const res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) +
    ":generateContent?key=" + encodeURIComponent(key), {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4 } }),
  });
  if (res.getResponseCode() !== 200) throw new Error("gemini " + res.getResponseCode());
  const c = (JSON.parse(res.getContentText()).candidates || [])[0];
  const parts = c && c.content && c.content.parts;
  const out = parts ? parts.map(p => p.text || "").join("").trim() : "";
  return out.length <= 8000 ? out : "";
}

/* ---------------- Auto-reply (away) ----------------
   awayReplies/{owner}: { on, replies: { convId: { iv, ciphertext, wrappedKeys } } },
   made and encrypted by the owner's app. When someone writes in a 1:1
   chat, the reply for that chat is copied in as a message from the
   owner, at most every AWAY_EVERY_MS per chat. */

const AWAY_EVERY_MS = 6 * 3600 * 1000;

function autoReply_(fs, sa, owner, toUid, convId) {
  const doc = fs.getRaw(`awayReplies/${owner}`);
  const f = doc && doc.fields;
  if (!f || !f.on || f.on.booleanValue !== true) return;
  const reply = f.replies && f.replies.mapValue && f.replies.mapValue.fields && f.replies.mapValue.fields[convId];
  const r = reply && reply.mapValue && reply.mapValue.fields;
  if (!r || !r.iv || !r.ciphertext || !r.wrappedKeys) return;
  const last = f.lastSent && f.lastSent.mapValue && f.lastSent.mapValue.fields && f.lastSent.mapValue.fields[convId];
  if (last && Date.now() - Number(last.integerValue || 0) < AWAY_EVERY_MS) return;
  const ownerUser = fs.get(`users/${owner}`);
  if (ownerUser && ownerUser.blocked && ownerUser.blocked[toUid]) return;
  const quote = k => "`" + k.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
  const id = Utilities.getUuid().replace(/-/g, "").slice(0, 20);
  fs.commit([
    { update: { name: fs.name(`conversations/${convId}/messages/${id}`), fields: {
        from: { stringValue: owner }, type: { stringValue: "text" }, iv: r.iv, ciphertext: r.ciphertext,
        wrappedKeys: r.wrappedKeys, read: { booleanValue: false }, autoReply: { booleanValue: true } } },
      currentDocument: { exists: false },
      updateTransforms: [{ fieldPath: "ts", setToServerValue: "REQUEST_TIME" }] },
    { transform: { document: fs.name(`conversations/${convId}`), fieldTransforms: [
      { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
      { fieldPath: "unreadCount." + quote(toUid), increment: { integerValue: "1" } }] } },
    { update: { name: doc.name, fields: { lastSent: { mapValue: { fields: { [convId]: { integerValue: String(Date.now()) } } } } } },
      updateMask: { fieldPaths: ["lastSent." + quote(convId)] } },
  ]);
  pushToUser_(fs, sa, toUid, owner, messagePush_(toUid, convId, id));
}

/* ---------------- GIF search (Tenor) ----------------
   Script property TENOR_KEY: a Google Cloud API key with the Tenor API
   enabled (free). The search goes through here, and so does the chosen
   GIF, which the app then sends encrypted like a photo. */

function gifSearch_(q) {
  const key = PropertiesService.getScriptProperties().getProperty("TENOR_KEY");
  if (!key) return { error: "TENOR_KEY script property is missing" };
  const query = typeof q === "string" ? q.trim().slice(0, 80) : "";
  const params = "key=" + encodeURIComponent(key) + "&client_key=calcut&limit=24&media_filter=gif,tinygif&locale=tr_TR&contentfilter=medium";
  const url = query
    ? "https://tenor.googleapis.com/v2/search?q=" + encodeURIComponent(query) + "&" + params
    : "https://tenor.googleapis.com/v2/featured?" + params;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { error: "tenor " + res.getResponseCode() };
  const results = (JSON.parse(res.getContentText()).results || []).map(r => {
    const f = r.media_formats || {};
    const big = f.gif && f.gif.size && f.gif.size <= 2500000 ? f.gif : f.tinygif;
    return f.tinygif && big ? { preview: f.tinygif.url, url: big.url } : null;
  }).filter(Boolean);
  return { results: results };
}

function gifFetch_(url) {
  if (typeof url !== "string" || !/^https:\/\/media\.tenor\.com\/[A-Za-z0-9_\-\/.]+\.gif$/.test(url)) return { error: "bad url" };
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { error: "tenor " + res.getResponseCode() };
  const bytes = res.getContent();
  if (bytes.length > 4000000) return { error: "too big" };
  return { dataUrl: "data:image/gif;base64," + Utilities.base64Encode(bytes) };
}

/* ---------------- Scheduled messages ----------------
   The app leaves a scheduled message, already encrypted, in
   scheduled/{id}: { from, convId, sendAt, ttlMs, msg }. Once it is due it
   moves to conversations/{convId}/messages/{id} in one atomic write that
   also deletes it (so it is sent once, even if the sender's app delivers
   it at the same moment), and the recipients get a push. The timer runs
   only while something is waiting. */

// Run once from the editor (select "setup", ▶ Run) so Google asks for the
// permission to manage this script's timers.
function setup() {
  ensureScheduleTrigger_();
  deliverScheduled();
  Logger.log("ok: scheduled messages are delivered every minute while any are waiting");
}

function ensureScheduleTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === "deliverScheduled");
  if (!has) ScriptApp.newTrigger("deliverScheduled").timeBased().everyMinutes(1).create();
}

function deliverScheduled() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const sa = JSON.parse(PropertiesService.getScriptProperties().getProperty("SERVICE_ACCOUNT"));
    const fs = new Firestore_(sa);
    const due = fs.query("scheduled", "sendAt", "LESS_THAN_OR_EQUAL", { timestampValue: new Date().toISOString() }, 50);
    due.forEach(doc => {
      try { deliverOne_(fs, sa, doc); } catch (e) { Logger.log("scheduled " + doc.name + ": " + e); }
    });
    if (!due.length && !fs.query("scheduled", "sendAt", "GREATER_THAN", { timestampValue: "1970-01-01T00:00:00Z" }, 1).length) {
      ScriptApp.getProjectTriggers()
        .filter(t => t.getHandlerFunction() === "deliverScheduled")
        .forEach(t => ScriptApp.deleteTrigger(t));
    }
  } finally {
    lock.releaseLock();
  }
}

function deliverOne_(fs, sa, doc) {
  const f = doc.fields || {};
  const id = doc.name.split("/").pop();
  const from = f.from && f.from.stringValue;
  const convId = f.convId && f.convId.stringValue;
  const msg = f.msg && f.msg.mapValue && f.msg.mapValue.fields;
  const conv = isId_(convId) ? fs.get(`conversations/${convId}`) : null;
  const participants = conv && Array.isArray(conv.participants) ? conv.participants : [];
  const admins = Array.isArray(conv && conv.admins) ? conv.admins : [conv && conv.createdBy];
  const allowed = msg && from && participants.indexOf(from) >= 0 && msg.from && msg.from.stringValue === from &&
    !((conv.onlyAdmins || conv.isChannel) && admins.indexOf(from) < 0);
  if (!allowed) { // left the group, lost the right to post, or malformed
    fs.commit([{ delete: doc.name, currentDocument: { exists: true } }]);
    return;
  }
  const fields = Object.assign({}, msg);
  const ttlMs = f.ttlMs ? Number(f.ttlMs.integerValue || 0) : 0;
  if (ttlMs > 0) fields.expiresAt = { timestampValue: new Date(Date.now() + ttlMs).toISOString() };
  const recipients = participants.filter(u => u !== from);
  const quote = k => "`" + k.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
  const ok = fs.commit([
    { update: { name: fs.name(`conversations/${convId}/messages/${id}`), fields: fields },
      currentDocument: { exists: false },
      updateTransforms: [{ fieldPath: "ts", setToServerValue: "REQUEST_TIME" }] },
    { delete: doc.name, currentDocument: { exists: true } },
    { transform: { document: fs.name(`conversations/${convId}`), fieldTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      .concat(recipients.map(u => ({ fieldPath: "unreadCount." + quote(u), increment: { integerValue: "1" } }))) } },
  ]);
  if (!ok) return; // the sender's app got there first
  const muted = conv.muted || {};
  const mentions = msg.mentions && msg.mentions.arrayValue ? (msg.mentions.arrayValue.values || []).map(v => v.stringValue) : [];
  recipients
    .filter(u => !muted[u] || mentions.indexOf(u) >= 0)
    .forEach(r => pushToUser_(fs, sa, r, from, messagePush_(r, convId, id)));
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

// A Firebase custom token for this user, so a device being linked can sign
// in. The phone encrypts it, with the keys, to that device's one-time key.
function customToken_(sa, uid) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url_(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url_(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now,
    exp: now + 3600,
    uid: uid,
  }));
  const signature = Utilities.computeRsaSha256Signature(header + "." + claims, sa.private_key);
  return header + "." + claims + "." + Utilities.base64EncodeWebSafe(signature).replace(/=+$/, "");
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

  // The REST document ({ name, fields }), or null.
  getRaw(path) {
    const res = UrlFetchApp.fetch(this.base + path, {
      headers: { Authorization: "Bearer " + getAccessToken_(this.sa) },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 404) return null;
    if (res.getResponseCode() !== 200) throw new Error("firestore get " + res.getResponseCode());
    return JSON.parse(res.getContentText());
  }

  name(path) {
    return `projects/${this.sa.project_id}/databases/(default)/documents/${path}`;
  }

  // Raw documents (REST encoded) of a collection where field op value.
  query(collection, field, op, value, limit) {
    const res = UrlFetchApp.fetch(this.base.replace(/\/$/, "") + ":runQuery", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + getAccessToken_(this.sa) },
      payload: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: op, value: value } },
        limit: limit,
      } }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error("firestore query " + res.getResponseCode() + ": " + res.getContentText().slice(0, 300));
    return JSON.parse(res.getContentText()).filter(r => r.document).map(r => r.document);
  }

  // Atomic writes; false if a precondition failed.
  commit(writes) {
    const res = UrlFetchApp.fetch(this.base.replace(/\/documents\/$/, "/documents:commit"), {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + getAccessToken_(this.sa) },
      payload: JSON.stringify({ writes: writes }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) return true;
    if (code === 400 || code === 404 || code === 409) return false;
    throw new Error("firestore commit " + code + ": " + res.getContentText().slice(0, 300));
  }

  // PATCH only the given top-level fields of an existing document.
  patchFields(path, fields) {
    const mask = Object.keys(fields).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
    const res = UrlFetchApp.fetch(this.base + path + "?" + mask + "&currentDocument.exists=true", {
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

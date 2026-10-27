// Background push for calcut. Messages are end-to-end encrypted, so pushes
// only carry a "kind"; sw.js turns them into a disguised "Alarm" notification.

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

// Must match the Firestore database location
// (nam5 -> "us-central1", eur3 -> "europe-west1"); see Firebase console > Firestore.
setGlobalOptions({ region: "us-central1" });

initializeApp();
const db = getFirestore();

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

// Must stay in step with CALL_RING_TIMEOUT_MS in app.js.
const CALL_RING_TIMEOUT_MS = 45000;
const RE_RING_INTERVAL_MS = 8000;

async function pushToUser(uid, data, { fromUid } = {}) {
  const userRef = db.collection("users").doc(uid);
  const user = (await userRef.get()).data() || {};
  if (fromUid && user.blocked && user.blocked[fromUid]) return;
  const tokens = Object.keys(user.fcmTokens || {});
  if (!tokens.length) return;

  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data,
    webpush: { headers: { Urgency: "high", TTL: data.kind === "call" ? "45" : "86400" } },
  });

  const stale = [];
  res.responses.forEach((r, i) => {
    if (!r.success && r.error && INVALID_TOKEN_CODES.has(r.error.code)) stale.push(tokens[i]);
  });
  if (stale.length) {
    const updates = [];
    stale.forEach(t => updates.push(new FieldPath("fcmTokens", t), FieldValue.delete()));
    await userRef.update(...updates);
  }
}

exports.notifyNewMessage = onDocumentCreated("conversations/{convId}/messages/{msgId}", async (event) => {
  const msg = event.data && event.data.data();
  if (!msg || msg.type === "call") return; // call log entries; the call itself already rang

  const conv = (await db.collection("conversations").doc(event.params.convId).get()).data();
  if (!conv || !Array.isArray(conv.participants)) return;

  const recipients = conv.participants.filter(uid => uid !== msg.from && !(conv.muted && conv.muted[uid]));
  await Promise.all(recipients.map(uid => pushToUser(uid, { kind: "message" }, { fromUid: msg.from })));
});

exports.notifyIncomingCall = onDocumentCreated(
  { document: "calls/{callId}", timeoutSeconds: 120 },
  async (event) => {
    const call = event.data && event.data.data();
    if (!call || call.status !== "ringing" || !call.to) return;
    const data = { kind: "call", media: call.media || "audio" };
    await pushToUser(call.to, data, { fromUid: call.from });

    // A web notification can't loop a ringtone, so re-push every few seconds
    // while the call is still ringing to keep the phone sounding like a call.
    const callRef = db.collection("calls").doc(event.params.callId);
    for (let elapsed = RE_RING_INTERVAL_MS; elapsed < CALL_RING_TIMEOUT_MS; elapsed += RE_RING_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, RE_RING_INTERVAL_MS));
      const current = (await callRef.get()).data();
      if (!current || current.status !== "ringing") return;
      await pushToUser(call.to, data, { fromUid: call.from });
    }
  }
);

// Caller hung up or the call timed out before it was answered: replace the
// ringing notification with a "missed" one.
exports.notifyMissedCall = onDocumentUpdated("calls/{callId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!before || !after || before.status !== "ringing" || after.status !== "ended") return;
  await pushToUser(after.to, { kind: "call-missed" }, { fromUid: after.from });
});

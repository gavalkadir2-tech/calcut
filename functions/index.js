// Sends a push notification to the recipient whenever a new message document is created.
// Message contents are end-to-end encrypted, so the notification only says that something arrived.

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

// The trigger region must match the Firestore database location
// (nam5 -> "us-central1", eur3 -> "europe-west1"); see Firebase console > Firestore.
exports.notifyNewMessage = onDocumentCreated(
  { document: "conversations/{convId}/messages/{msgId}", region: "us-central1" },
  async (event) => {
    const msg = event.data && event.data.data();
    if (!msg) return;

    const db = getFirestore();
    const convSnap = await db.collection("conversations").doc(event.params.convId).get();
    const conv = convSnap.data();
    if (!conv || !Array.isArray(conv.participants)) return;

    const recipients = conv.participants.filter(uid => uid !== msg.from);
    for (const uid of recipients) {
      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      const tokens = Object.keys((userSnap.data() || {}).fcmTokens || {});
      if (!tokens.length) continue;

      const res = await getMessaging().sendEachForMulticast({
        tokens,
        data: {
          title: "Hesap Makinesi",
          body: "Yeni bir bildirimin var",
          tag: "calcut-" + event.params.convId,
        },
        webpush: {
          headers: { Urgency: "high", TTL: "86400" },
        },
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
  }
);

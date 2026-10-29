// Firestore security rules (../../firestore.rules), run against the Firebase
// emulator: npm ci && npm test in this folder (needs Java).
import test from "node:test";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, getDoc, getDocs, query, where, serverTimestamp, Timestamp, deleteField, deleteDoc, addDoc, collection, arrayUnion } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "demo-calcut",
  firestore: { rules: fs.readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8089 },
});
const JPEG = "data:image/jpeg;base64," + "A".repeat(4000);

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/alice"), { nickname: "alice", status: "approved", blocked: {}, lastSeen: Timestamp.fromMillis(1000) });
    await setDoc(doc(db, "users/bob"), { nickname: "bob", status: "approved", blocked: {} });
    await setDoc(doc(db, "conversations/c1"), { participants: ["alice", "bob"] });
    await setDoc(doc(db, "conversations/c1/messages/m1"), { from: "alice", type: "text", ciphertext: "x", iv: "y", wrappedKeys: {}, ts: Timestamp.now() });
    await setDoc(doc(db, "conversations/c1/messages/p1"), { from: "alice", type: "poll", ciphertext: "x", iv: "y", wrappedKeys: {}, ts: Timestamp.now() });
    await setDoc(doc(db, "users/carol"), { nickname: "carol", status: "approved", blocked: {} });
    await setDoc(doc(db, "users/dave"), { nickname: "dave", status: "approved", blocked: {} });
    // An older group (no admins field: its creator is the admin) and a newer one.
    await setDoc(doc(db, "conversations/g_old"), { isGroup: true, groupName: "eski", createdBy: "alice", participants: ["alice", "bob", "carol"] });
    await setDoc(doc(db, "conversations/g1"), { isGroup: true, groupName: "grup", createdBy: "alice", admins: ["alice"], participants: ["alice", "bob", "carol"] });
    await setDoc(doc(db, "statuses/s1"), { from: "alice", audience: ["bob"], expiresAt: Timestamp.fromMillis(Date.now() + 3600e3), ciphertext: "x" });
  });
}
const as = uid => env.authenticatedContext(uid).firestore();

test("existing: nickname change still works with an old lastSeen on the doc", async () => {
  await seed(); await assertSucceeds(updateDoc(doc(as("alice"), "users/alice"), { nickname: "alice2" }));
});
test("existing: blocking still works", async () => {
  await seed(); await assertSucceeds(updateDoc(doc(as("alice"), "users/alice"), { blocked: { bob: true } }));
});
test("set own avatar (small JPEG data URL)", async () => {
  await seed(); await assertSucceeds(updateDoc(doc(as("alice"), "users/alice"), { avatar: JPEG }));
});
test("avatar that is a remote URL is rejected", async () => {
  await seed(); await assertFails(updateDoc(doc(as("alice"), "users/alice"), { avatar: "https://evil.example/x.jpg" }));
});
test("oversized avatar is rejected", async () => {
  await seed(); await assertFails(updateDoc(doc(as("alice"), "users/alice"), { avatar: "data:image/jpeg;base64," + "A".repeat(120000) }));
});
test("remove own avatar", async () => {
  await seed(); await assertSucceeds(updateDoc(doc(as("alice"), "users/alice"), { avatar: deleteField() }));
});
test("lastSeen = server time is allowed", async () => {
  await seed(); await assertSucceeds(updateDoc(doc(as("alice"), "users/alice"), { lastSeen: serverTimestamp() }));
});
test("a made-up lastSeen is rejected", async () => {
  await seed(); await assertFails(updateDoc(doc(as("alice"), "users/alice"), { lastSeen: Timestamp.fromMillis(Date.now() + 3600e3) }));
});
test("hiding presence (bool + delete lastSeen) is allowed", async () => {
  await seed(); await assertSucceeds(updateDoc(doc(as("alice"), "users/alice"), { hidePresence: true, lastSeen: deleteField() }));
});
test("hidePresence must be a bool", async () => {
  await seed(); await assertFails(updateDoc(doc(as("alice"), "users/alice"), { hidePresence: "yes" }));
});
test("cannot change someone else's profile", async () => {
  await seed(); await assertFails(updateDoc(doc(as("bob"), "users/alice"), { avatar: JPEG }));
});
test("cannot set other fields (e.g. role) on yourself", async () => {
  await seed(); await assertFails(updateDoc(doc(as("alice"), "users/alice"), { role: "admin", avatar: JPEG }));
});
test("existing: chunk docs can be created by the sender", async () => {
  await seed(); await assertSucceeds(setDoc(doc(as("alice"), "conversations/c1/messages/g_0"), { from: "alice", chunkOf: "g", idx: 0, data: "abc" }));
});
test("existing: delete for everyone erases ciphertext (sender only)", async () => {
  await seed();
  const erase = { deleted: true, ciphertext: deleteField(), iv: deleteField(), wrappedKeys: deleteField() };
  await assertFails(updateDoc(doc(as("bob"), "conversations/c1/messages/m1"), erase));
  await assertSucceeds(updateDoc(doc(as("alice"), "conversations/c1/messages/m1"), erase));
});
test("existing: a reply (replyTo) message can be created", async () => {
  await seed(); await assertSucceeds(addDoc(collection(as("bob"), "conversations/c1/messages"), { from: "bob", type: "text", replyTo: "m1", ts: serverTimestamp() }));
});

// ---- delivered ticks, reactions, polls
test("recipient marks delivered / read; the sender can't", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/c1/messages/m1"), { delivered: true }));
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/c1/messages/m1"), { read: true }));
  await seed(); // a no-op write is always allowed, so start from an unmarked message
  await assertFails(updateDoc(doc(as("alice"), "conversations/c1/messages/m1"), { delivered: true }));
});
test("reactions: only your own entry", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/c1/messages/m1"), { "reactions.bob": "👍" }));
  await assertFails(updateDoc(doc(as("bob"), "conversations/c1/messages/m1"), { "reactions.alice": "👎" }));
});
test("poll votes: only your own, an int, only on polls", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/c1/messages/p1"), { "votes.bob": 1 }));
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/c1/messages/p1"), { "votes.bob": deleteField() }));
  await assertFails(updateDoc(doc(as("bob"), "conversations/c1/messages/p1"), { "votes.alice": 0 }));
  await assertFails(updateDoc(doc(as("bob"), "conversations/c1/messages/p1"), { "votes.bob": "zero" }));
  await assertFails(updateDoc(doc(as("bob"), "conversations/c1/messages/m1"), { "votes.bob": 0 }));
});

// ---- group management
test("admin renames the group, adds and removes members, makes admins", async () => {
  await seed();
  const db = as("alice");
  await assertSucceeds(updateDoc(doc(db, "conversations/g1"), { groupName: "yeni ad" }));
  await assertSucceeds(updateDoc(doc(db, "conversations/g1"), { participants: ["alice", "bob", "carol", "dave"], "participantNicknames.dave": "dave", "unreadCount.dave": 0 }));
  await assertSucceeds(updateDoc(doc(db, "conversations/g1"), { participants: ["alice", "bob", "dave"] }));
  await assertSucceeds(updateDoc(doc(db, "conversations/g1"), { admins: ["alice", "bob"] }));
  await assertSucceeds(updateDoc(doc(db, "conversations/g1"), { groupAvatar: JPEG }));
});
test("creator of an older group (no admins field) is its admin", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("alice"), "conversations/g_old"), { groupName: "x", admins: ["alice"] }));
  await assertFails(updateDoc(doc(as("bob"), "conversations/g_old"), { groupName: "y" }));
});
test("non-admins can't rename, add or remove others", async () => {
  await seed();
  const db = as("bob");
  await assertFails(updateDoc(doc(db, "conversations/g1"), { groupName: "ele geçirildi" }));
  await assertFails(updateDoc(doc(db, "conversations/g1"), { participants: ["alice", "bob", "carol", "dave"] }));
  await assertFails(updateDoc(doc(db, "conversations/g1"), { participants: ["alice", "bob"] }));
  await assertFails(updateDoc(doc(db, "conversations/g1"), { admins: ["alice", "bob"] }));
});
test("admins must stay members, at least one admin, max 20 members, valid photo", async () => {
  await seed();
  const db = as("alice");
  await assertFails(updateDoc(doc(db, "conversations/g1"), { admins: ["dave"] }));
  await assertFails(updateDoc(doc(db, "conversations/g1"), { admins: [] }));
  await assertFails(updateDoc(doc(db, "conversations/g1"), { participants: Array.from({ length: 21 }, (_, i) => "u" + i).concat(["alice"]) }));
  await assertFails(updateDoc(doc(db, "conversations/g1"), { groupAvatar: "https://evil.example/x.jpg" }));
});
test("anyone may leave; only themselves", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/g1"), { participants: ["alice", "carol"] }));
  await seed();
  await assertFails(updateDoc(doc(as("bob"), "conversations/g1"), { participants: ["alice"] }));
  await assertFails(updateDoc(doc(as("bob"), "conversations/g1"), { participants: ["alice", "carol"], admins: ["carol"] }));
});
test("a leaving admin may hand admin to a remaining member", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("alice"), "conversations/g1"), { participants: ["bob", "carol"], admins: ["bob"] }));
});
test("existing: non-group conversation updates (unread, typing) still work; 1:1 can't get group fields", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/c1"), { "unreadCount.bob": 0, "typing.bob": serverTimestamp() }));
  await assertFails(updateDoc(doc(as("alice"), "conversations/c1"), { participants: ["alice", "bob", "carol"] }));
});

// ---- statuses
test("status: audience and author can read, others can't", async () => {
  await seed();
  await assertSucceeds(getDoc(doc(as("bob"), "statuses/s1")));
  await assertSucceeds(getDoc(doc(as("alice"), "statuses/s1")));
  await assertFails(getDoc(doc(as("carol"), "statuses/s1")));
});
test("status: audience queries are allowed", async () => {
  await seed();
  await assertSucceeds(getDocs(query(collection(as("bob"), "statuses"), where("audience", "array-contains", "bob"))));
  await assertSucceeds(getDocs(query(collection(as("alice"), "statuses"), where("from", "==", "alice"))));
  await assertFails(getDocs(collection(as("bob"), "statuses")));
});
test("status: create only as yourself, expiring within a day", async () => {
  await seed();
  const db = as("alice");
  await assertSucceeds(addDoc(collection(db, "statuses"), { from: "alice", audience: ["bob"], expiresAt: Timestamp.fromMillis(Date.now() + 24 * 3600e3), ciphertext: "x" }));
  await assertFails(addDoc(collection(db, "statuses"), { from: "bob", audience: ["bob"], expiresAt: Timestamp.fromMillis(Date.now() + 3600e3) }));
  await assertFails(addDoc(collection(db, "statuses"), { from: "alice", audience: ["bob"], expiresAt: Timestamp.fromMillis(Date.now() + 72 * 3600e3) }));
});
test("status: viewers add only themselves; only the author deletes", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("bob"), "statuses/s1"), { "viewers.bob": serverTimestamp() }));
  await assertFails(updateDoc(doc(as("bob"), "statuses/s1"), { "viewers.carol": serverTimestamp() }));
  await assertFails(updateDoc(doc(as("bob"), "statuses/s1"), { ciphertext: "y" }));
  await assertFails(deleteDoc(doc(as("bob"), "statuses/s1")));
  await assertSucceeds(deleteDoc(doc(as("alice"), "statuses/s1")));
});

test("callee marks an incoming call as ringing; others can't", async () => {
  await seed();
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), "calls/k1"), { from: "alice", to: "bob", status: "ringing" }));
  await assertSucceeds(updateDoc(doc(as("bob"), "calls/k1"), { ringing: true }));
  await assertFails(updateDoc(doc(as("carol"), "calls/k1"), { ringing: false }));
});

test.after(async () => { await env.cleanup(); });

test("read receipts setting: own, bool only", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("alice"), "users/alice"), { hideReadReceipts: true }));
  await assertFails(updateDoc(doc(as("alice"), "users/alice"), { hideReadReceipts: "yes" }));
  await assertFails(updateDoc(doc(as("bob"), "users/alice"), { hideReadReceipts: false }));
});
test("voice message played: recipient only", async () => {
  await seed();
  await assertFails(updateDoc(doc(as("alice"), "conversations/c1/messages/m1"), { played: true }));
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/c1/messages/m1"), { played: true }));
});
test("pin a message: any participant, an id string; unpin", async () => {
  await seed();
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/c1"), { pinnedMessage: "m1" }));
  await assertSucceeds(updateDoc(doc(as("alice"), "conversations/c1"), { pinnedMessage: deleteField() }));
  await assertSucceeds(updateDoc(doc(as("carol"), "conversations/g1"), { pinnedMessage: "x" }));
  await assertFails(updateDoc(doc(as("alice"), "conversations/c1"), { pinnedMessage: 5 }));
  await assertFails(updateDoc(doc(as("alice"), "conversations/c1"), { pinnedMessage: "a".repeat(65) }));
  await assertFails(updateDoc(doc(as("dave"), "conversations/c1"), { pinnedMessage: "m1" }));
});
test("a message with mentions can be created", async () => {
  await seed();
  await assertSucceeds(addDoc(collection(as("bob"), "conversations/g1/messages"), { from: "bob", type: "text", mentions: ["alice"], ts: serverTimestamp() }));
});

test("group receipts: each member adds only their own time", async () => {
  await seed();
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), "conversations/g1/messages/gm1"), { from: "alice", type: "text", ts: Timestamp.now() }));
  await assertSucceeds(updateDoc(doc(as("bob"), "conversations/g1/messages/gm1"), { "readBy.bob": serverTimestamp(), "deliveredTo.bob": serverTimestamp() }));
  await assertFails(updateDoc(doc(as("bob"), "conversations/g1/messages/gm1"), { "readBy.carol": serverTimestamp() }));
  await assertFails(updateDoc(doc(as("carol"), "conversations/g1/messages/gm1"), { "readBy.carol": true }));
  await assertFails(updateDoc(doc(as("alice"), "conversations/g1/messages/gm1"), { "readBy.alice": serverTimestamp() }));
});

test("joining a group with its invite code", async () => {
  await seed();
  const code = "abcdefghijklmnop1234";
  await assertFails(updateDoc(doc(as("dave"), "conversations/g1"), { participants: arrayUnion("dave"), joinCode: code }));
  await assertSucceeds(updateDoc(doc(as("alice"), "conversations/g1"), { inviteCode: code }));
  await assertFails(updateDoc(doc(as("bob"), "conversations/g1"), { inviteCode: "x".repeat(20) }));
  await assertFails(updateDoc(doc(as("dave"), "conversations/g1"), { participants: arrayUnion("dave"), joinCode: "wrongwrongwrongwrong" }));
  await assertFails(updateDoc(doc(as("dave"), "conversations/g1"), { participants: arrayUnion("dave", "erin"), joinCode: code }));
  await assertFails(updateDoc(doc(as("dave"), "conversations/g1"), { participants: arrayUnion("dave"), groupName: "x", joinCode: code }));
  await assertSucceeds(updateDoc(doc(as("dave"), "conversations/g1"), {
    participants: arrayUnion("dave"), "participantNicknames.dave": "dave", "unreadCount.dave": 0, joinCode: code,
  }));
  await assertSucceeds(getDoc(doc(as("dave"), "conversations/g1")));
  await assertFails(updateDoc(doc(as("dave"), "conversations/c1"), { participants: arrayUnion("dave"), joinCode: code }));
});

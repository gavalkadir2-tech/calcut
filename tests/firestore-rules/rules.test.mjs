// Firestore security rules (../../firestore.rules), run against the Firebase
// emulator: npm ci && npm test in this folder (needs Java).
import test from "node:test";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, serverTimestamp, Timestamp, deleteField, deleteDoc, addDoc, collection } from "firebase/firestore";

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
test.after(async () => { await env.cleanup(); });

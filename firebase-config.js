const firebaseConfig = {
  apiKey: "AIzaSyB0JTRgod2uk5KtYtnd4OLiG0LQ5qwxEwI",
  authDomain: "calcut-f989a.firebaseapp.com",
  projectId: "calcut-f989a",
  storageBucket: "calcut-f989a.firebasestorage.app",
  messagingSenderId: "23323528845",
  appId: "1:23323528845:web:1e4c8a8fc1996d82331cc4",
  measurementId: "G-YVBT18GHW4"
};

firebase.initializeApp(firebaseConfig);
window.fbAuth = firebase.auth();
window.fbDb = firebase.firestore();

// Web Push certificate key: Firebase console > Project settings > Cloud Messaging >
// Web Push certificates > "Generate key pair", then paste the public key here.
window.FCM_VAPID_KEY = "BE6LNp9930MgkDdY3n1e8yBbGnAbZ_5CregfzuLVsXZ-HI-UM9GIco3aTzfE5DvC7nqHBHvIbgh0HrBRr0m6AJ8";

// URL of the push Worker (worker/push-worker.js) deployed on Cloudflare,
// e.g. "https://calcut-push.ADIN.workers.dev". Empty = no background push.
window.PUSH_URL = "https://calcut-bildirim.gavalkadir2.workers.dev";

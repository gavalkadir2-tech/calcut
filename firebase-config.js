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

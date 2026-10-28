(() => {
  "use strict";

  // The Android app (native/) bundles these files itself, so it needs no
  // offline cache, and a service worker there would sit in front of the
  // app's own file server.
  const IS_NATIVE_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  if ("serviceWorker" in navigator && !IS_NATIVE_APP) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  /* ---------------- Calculator logic ---------------- */

  const exprEl = document.getElementById("calc-expression");
  const resultEl = document.getElementById("calc-result");
  const calcView = document.getElementById("calculator-view");
  const vaultView = document.getElementById("vault-view");

  let currentInput = "0";
  let previousValue = null;
  let pendingOp = null;
  let justEvaluated = false;
  let hadOperator = false;

  function formatNumber(n) {
    if (!isFinite(n)) return "Hata";
    const s = n.toString();
    if (s.length > 12) return n.toPrecision(8).replace(/\.?0+$/, "");
    return s;
  }

  function renderCalc() {
    resultEl.textContent = currentInput;
    if (pendingOp && previousValue !== null) {
      const opSymbol = { "+": "+", "-": "−", "*": "×", "/": "÷" }[pendingOp];
      exprEl.textContent = `${formatNumber(previousValue)} ${opSymbol}`;
    } else {
      exprEl.textContent = "";
    }
  }

  function inputNumber(d) {
    if (justEvaluated) {
      currentInput = "0";
      previousValue = null;
      pendingOp = null;
      hadOperator = false;
      justEvaluated = false;
    }
    if (d === "." ) {
      if (currentInput.includes(".")) return;
      currentInput += ".";
      return;
    }
    if (currentInput === "0") currentInput = d;
    else currentInput += d;
  }

  function applyOp(a, b, op) {
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? NaN : a / b;
      default: return b;
    }
  }

  function inputOp(op) {
    hadOperator = true;
    if (pendingOp && previousValue !== null && !justEvaluated) {
      previousValue = applyOp(previousValue, parseFloat(currentInput), pendingOp);
    } else {
      previousValue = parseFloat(currentInput);
    }
    pendingOp = op;
    currentInput = "0";
    justEvaluated = false;
  }

  function clearAll() {
    currentInput = "0";
    previousValue = null;
    pendingOp = null;
    hadOperator = false;
    justEvaluated = false;
  }

  async function equals() {
    const rawTyped = currentInput;
    if (pendingOp && previousValue !== null) {
      const value = applyOp(previousValue, parseFloat(currentInput), pendingOp);
      currentInput = formatNumber(value);
      previousValue = null;
      pendingOp = null;
    }
    justEvaluated = true;
    renderCalc();

    // Secret trigger: a plain number (no operator used this expression) typed then "="
    // is tried as the vault PIN.
    if (!hadOperator && /^[0-9]{3,12}$/.test(rawTyped)) {
      hadOperator = false;
      const ok = await tryAutoUnlock(rawTyped);
      if (ok) return;
    }
    hadOperator = false;
  }

  function signToggle() {
    if (currentInput === "0") return;
    currentInput = currentInput.startsWith("-") ? currentInput.slice(1) : "-" + currentInput;
  }

  function percent() {
    currentInput = formatNumber(parseFloat(currentInput) / 100);
  }

  // Secret gesture: pressing the keys 1,9,2,3,=,+ in that order opens the hidden
  // vault lock screen directly, regardless of the account PIN.
  const SECRET_SEQUENCE = "1923=+";
  let secretBuffer = "";
  let secretTimer = null;
  function trackSecretKey(key) {
    clearTimeout(secretTimer);
    secretTimer = setTimeout(() => { secretBuffer = ""; }, 3000);
    secretBuffer = (secretBuffer + key).slice(-SECRET_SEQUENCE.length);
    if (secretBuffer === SECRET_SEQUENCE) {
      secretBuffer = "";
      clearTimeout(secretTimer);
      openVaultLockScreen();
    }
  }

  document.querySelectorAll(".btn[data-num]").forEach(btn => {
    btn.addEventListener("click", () => { inputNumber(btn.dataset.num); trackSecretKey(btn.dataset.num); renderCalc(); });
  });
  document.querySelectorAll(".btn[data-op]").forEach(btn => {
    btn.addEventListener("click", () => { inputOp(btn.dataset.op); trackSecretKey(btn.dataset.op); renderCalc(); });
  });
  document.querySelectorAll(".btn[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "clear") clearAll();
      else if (action === "sign") signToggle();
      else if (action === "percent") percent();
      else if (action === "equals") { trackSecretKey("="); equals(); return; }
      renderCalc();
    });
  });

  // Secret gesture: triple-tap the result display opens the hidden vault lock screen directly.
  let tapCount = 0;
  let tapTimer = null;
  resultEl.addEventListener("click", () => {
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { tapCount = 0; }, 1200);
    if (tapCount >= 3) {
      tapCount = 0;
      clearTimeout(tapTimer);
      openVaultLockScreen();
    }
  });

  renderCalc();

  /* ---------------- Generic crypto helpers ---------------- */

  function b64encode(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function b64decode(str) {
    const bin = atob(str);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }

  /* ---------------- Local device lock (PIN) ---------------- */
  // The local PIN only gates the UI on this device. It is independent from the
  // real account password, so forgetting it never costs you your messages:
  // messages live in the cloud, protected by your account password.

  const STORAGE_SALT = "calcut_vault_salt";
  const STORAGE_BLOB = "calcut_vault_blob";
  const STORAGE_BIOMETRIC = "calcut_biometric_cred_id";
  const DURESS_SALT = "calcut_duress_salt";
  const DURESS_BLOB = "calcut_duress_blob";

  function getOrCreateSalt(saltKey = STORAGE_SALT) {
    let salt = localStorage.getItem(saltKey);
    if (!salt) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      salt = b64encode(bytes.buffer);
      localStorage.setItem(saltKey, salt);
    }
    return b64decode(salt);
  }

  async function deriveKeyFromSecret(secret, salt) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function deriveLocalKey(pin, saltKey = STORAGE_SALT) {
    return deriveKeyFromSecret(pin, getOrCreateSalt(saltKey));
  }

  function vaultExists() {
    return !!localStorage.getItem(STORAGE_BLOB);
  }

  async function saveLocalBlob(key, dataObj, blobKey = STORAGE_BLOB) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(dataObj));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    localStorage.setItem(blobKey, JSON.stringify({
      iv: b64encode(iv.buffer),
      data: b64encode(ciphertext),
    }));
  }

  async function loadLocalBlob(key, blobKey = STORAGE_BLOB) {
    const raw = localStorage.getItem(blobKey);
    if (!raw) return null;
    const { iv, data } = JSON.parse(raw);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64decode(iv)) },
      key,
      b64decode(data)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  /* ---------------- Duress (decoy) PIN ---------------- */
  // A second, optional PIN that opens a harmless, entirely fake empty inbox
  // instead of the real vault. It never touches the real account, Firestore,
  // or any real message data — it is a separate, self-contained localStorage
  // blob with its own salt, so there is zero risk of it ever leaking real
  // content even if implemented imperfectly.

  function duressPinExists() {
    return !!localStorage.getItem(DURESS_BLOB);
  }

  async function setDuressPin(pin) {
    const key = await deriveLocalKey(pin, DURESS_SALT);
    await saveLocalBlob(key, { duress: true }, DURESS_BLOB);
  }

  async function tryDuressPin(pin) {
    if (!duressPinExists()) return false;
    const key = await deriveLocalKey(pin, DURESS_SALT);
    try {
      const data = await loadLocalBlob(key, DURESS_BLOB);
      return !!(data && data.duress);
    } catch (e) {
      return false;
    }
  }

  function clearDuressPin() {
    localStorage.removeItem(DURESS_BLOB);
    localStorage.removeItem(DURESS_SALT);
  }

  const lockPanel = document.getElementById("vault-lock");
  const authPanel = document.getElementById("auth-panel");
  const appPanel = document.getElementById("vault-app");
  const pinInput = document.getElementById("vault-pin-input");
  const unlockBtn = document.getElementById("vault-unlock-btn");
  const backBtn = document.getElementById("vault-back-btn");
  const errorEl = document.getElementById("vault-error");
  const forgotPinLink = document.getElementById("forgot-pin-link");

  function openVaultLockScreen() {
    calcView.classList.add("hidden");
    vaultView.classList.remove("hidden");
    lockPanel.classList.remove("hidden");
    authPanel.classList.add("hidden");
    appPanel.classList.add("hidden");
    pinInput.value = "";
    errorEl.textContent = "";
    const heading = lockPanel.querySelector("h2");
    const sub = lockPanel.querySelector("p");
    if (vaultExists()) {
      heading.textContent = "Kilidi Aç";
      sub.textContent = "Devam etmek için PIN girin";
    } else {
      heading.textContent = "PIN Oluştur";
      sub.textContent = "Yeni gizli PIN belirleyin (en az 4 karakter)";
    }
    setTimeout(() => pinInput.focus(), 50);
  }

  function closeVaultToCalculator() {
    vaultView.classList.add("hidden");
    calcView.classList.remove("hidden");
    lockPanel.classList.remove("hidden");
    authPanel.classList.add("hidden");
    appPanel.classList.add("hidden");
    document.getElementById("pending-panel").classList.add("hidden");
    document.getElementById("duress-panel").classList.add("hidden");
    clearAll();
    renderCalc();
  }

  async function verifyBiometricIfEnabled() {
    const credIdB64 = localStorage.getItem(STORAGE_BIOMETRIC);
    if (!credIdB64 || !window.PublicKeyCredential) return true;
    try {
      await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: b64decode(credIdB64), type: "public-key" }],
          userVerification: "required",
          timeout: 60000,
        },
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function afterLocalUnlock() {
    const bioOk = await verifyBiometricIfEnabled();
    if (!bioOk) {
      errorEl.textContent = "Biyometrik doğrulama başarısız.";
      return;
    }
    lockPanel.classList.add("hidden");

    if (!myPrivateKey && localSessionData && localSessionData.uid && localSessionData.privateKeyJwk) {
      const restored = await restoreSession(localSessionData);
      if (restored) {
        if (myStatus === "approved") {
          enterMessenger();
        } else {
          openPendingPanel();
        }
        // Re-check the real status in the background in case it changed
        // (e.g. got approved, or the referral got rejected) while this
        // device was locked.
        fbDb.collection("users").doc(myUid).get().then(async doc => {
          if (!doc.exists) {
            // The referral was rejected and the account no longer exists.
            await fbAuth.signOut().catch(() => {});
            await clearPersistedSession();
            myUid = null; myNickname = null; myPrivateKey = null; myPublicKey = null; myStatus = null; myReferredByNickname = null;
            openAuthPanel();
            authError.textContent = "Referans başvurunuz reddedildi. Tekrar kayıt olabilirsiniz.";
            return;
          }
          const data = doc.data();
          if (!data) return;
          const freshStatus = data.status === undefined ? "approved" : data.status;
          if (freshStatus !== myStatus) {
            myStatus = freshStatus;
            persistSession();
            if (myStatus === "approved") enterMessenger();
          }
        }).catch(() => {});
        return;
      }
    }

    if (fbAuth.currentUser && myPrivateKey) {
      if (myStatus === "approved") {
        enterMessenger();
      } else {
        openPendingPanel();
      }
    } else {
      openAuthPanel();
    }
  }

  async function restoreSession(session) {
    if (!fbAuth.currentUser || fbAuth.currentUser.uid !== session.uid) return false;
    try {
      const privateKey = await crypto.subtle.importKey(
        "jwk", session.privateKeyJwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]
      );
      const publicKey = await crypto.subtle.importKey(
        "jwk", session.publicKeyJwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
      );
      myUid = session.uid;
      myNickname = session.nickname;
      myPrivateKey = privateKey;
      myPublicKey = publicKey;
      myStatus = session.status || "pending";
      myReferredByNickname = session.referredByNickname || null;
      myBlocked = session.blocked || {};
      publicKeyCache.set(myUid, publicKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function persistSession() {
    if (!currentLocalKey || !myUid || !myPrivateKey) return;
    const privateKeyJwk = await crypto.subtle.exportKey("jwk", myPrivateKey);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", myPublicKey);
    localSessionData = {
      uid: myUid,
      nickname: myNickname,
      status: myStatus,
      referredByNickname: myReferredByNickname,
      blocked: myBlocked,
      privateKeyJwk,
      publicKeyJwk,
    };
    await saveLocalBlob(currentLocalKey, localSessionData).catch(() => {});
  }

  async function clearPersistedSession() {
    localSessionData = {};
    if (currentLocalKey) {
      await saveLocalBlob(currentLocalKey, {}).catch(() => {});
    }
  }

  // Returns "real" | "duress" | "fail". The real vault is always tried
  // first; only on a real-PIN mismatch do we check the duress PIN, so a
  // duress PIN can never accidentally shadow the real one.
  async function attemptUnlock(pin) {
    const key = await deriveLocalKey(pin);
    if (!vaultExists()) {
      await saveLocalBlob(key, {});
      currentLocalKey = key;
      localSessionData = {};
      return "real";
    }
    try {
      localSessionData = await loadLocalBlob(key);
      currentLocalKey = key;
      return "real";
    } catch (e) {
      if (await tryDuressPin(pin)) return "duress";
      return "fail";
    }
  }

  function openDuressScreen() {
    lockPanel.classList.add("hidden");
    authPanel.classList.add("hidden");
    appPanel.classList.add("hidden");
    document.getElementById("pending-panel").classList.add("hidden");
    document.getElementById("duress-panel").classList.remove("hidden");
  }

  async function unlockWithPin(pin) {
    return (await attemptUnlock(pin)) !== "fail";
  }

  async function tryAutoUnlock(pin) {
    if (!vaultExists() && !duressPinExists()) return false; // require explicit setup via triple-tap gesture first
    const mode = await attemptUnlock(pin);
    if (mode === "fail") return false;
    calcView.classList.add("hidden");
    vaultView.classList.remove("hidden");
    if (mode === "duress") {
      openDuressScreen();
    } else {
      await afterLocalUnlock();
    }
    return true;
  }

  unlockBtn.addEventListener("click", async () => {
    const pin = pinInput.value.trim();
    if (pin.length < 4) {
      errorEl.textContent = "PIN en az 4 karakter olmalı.";
      return;
    }
    const mode = await attemptUnlock(pin);
    if (mode === "real") {
      errorEl.textContent = "";
      await afterLocalUnlock();
    } else if (mode === "duress") {
      errorEl.textContent = "";
      openDuressScreen();
    } else {
      errorEl.textContent = "Yanlış PIN.";
    }
  });
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockBtn.click();
  });
  backBtn.addEventListener("click", closeVaultToCalculator);

  forgotPinLink.addEventListener("click", () => {
    if (!confirm("Bu cihazdaki yerel PIN sıfırlanacak. Mesajların hesap parolanla korunduğu için kaybolmaz; sıfırladıktan sonra hesabına tekrar giriş yapman gerekecek. Devam edilsin mi?")) return;
    localStorage.removeItem(STORAGE_BLOB);
    localStorage.removeItem(STORAGE_SALT);
    localStorage.removeItem(STORAGE_BIOMETRIC);
    clearDuressPin();
    openVaultLockScreen();
  });

  /* ---------------- Real account (Firebase Auth + E2E messaging) ---------------- */

  let myUid = null;
  let myNickname = null;
  let myPrivateKey = null;
  let myPublicKey = null;
  let myStatus = null; // "pending" or "approved"
  let myReferredByNickname = null;
  let myBlocked = {}; // uid -> true, people I've blocked
  const publicKeyCache = new Map(); // uid -> CryptoKey

  // The PIN-derived key and decrypted local blob from the most recent vault
  // unlock, kept around so a successful login can save a restorable session
  // into the same PIN-protected blob (see persistSession / restoreSession).
  let currentLocalKey = null;
  let localSessionData = null;

  // Firebase Auth's email/password provider is used purely as a mechanism —
  // nobody sees or types an email. Each nickname deterministically maps to a
  // synthetic address, and Firebase's own "email already in use" check is
  // what actually enforces nickname uniqueness.
  const SYNTHETIC_EMAIL_DOMAIN = "@calcut.local";
  function nicknameToSyntheticEmail(nickname) {
    return nickname + SYNTHETIC_EMAIL_DOMAIN;
  }

  const authTitle = document.getElementById("auth-title");
  const authNicknameInput = document.getElementById("auth-nickname-input");
  const authReferrerInput = document.getElementById("auth-referrer-input");
  const authPasswordInput = document.getElementById("auth-password-input");
  const authSubmitBtn = document.getElementById("auth-submit-btn");
  const authToggleBtn = document.getElementById("auth-toggle-btn");
  const authBackBtn = document.getElementById("auth-back-btn");
  const authError = document.getElementById("auth-error");
  const pendingPanel = document.getElementById("pending-panel");
  const pendingReferrerEl = document.getElementById("pending-referrer");
  const pendingMsg = document.getElementById("pending-msg");
  let authMode = "login"; // or "signup"

  function openAuthPanel() {
    authPanel.classList.remove("hidden");
    appPanel.classList.add("hidden");
    pendingPanel.classList.add("hidden");
    authError.textContent = "";
    authPasswordInput.value = "";
    authMode = "login";
    authTitle.textContent = "Giriş Yap";
    authSubmitBtn.textContent = "Giriş Yap";
    authToggleBtn.textContent = "Hesabın yok mu? Kayıt ol";
    authReferrerInput.classList.add("hidden");
  }

  authToggleBtn.addEventListener("click", () => {
    authMode = authMode === "login" ? "signup" : "login";
    authTitle.textContent = authMode === "login" ? "Giriş Yap" : "Hesap Oluştur";
    authSubmitBtn.textContent = authMode === "login" ? "Giriş Yap" : "Kayıt Ol";
    authToggleBtn.textContent = authMode === "login" ? "Hesabın yok mu? Kayıt ol" : "Zaten hesabın var mı? Giriş yap";
    authReferrerInput.classList.toggle("hidden", authMode !== "signup");
    authError.textContent = "";
  });

  function openPendingPanel() {
    authPanel.classList.add("hidden");
    appPanel.classList.add("hidden");
    pendingPanel.classList.remove("hidden");
    pendingReferrerEl.textContent = myReferredByNickname ? "@" + myReferredByNickname : "referans kullanıcının";
    pendingMsg.textContent = "";
    resetInactivityTimer();
  }

  document.getElementById("pending-refresh-btn").addEventListener("click", async () => {
    pendingMsg.textContent = "Kontrol ediliyor...";
    try {
      const doc = await fbDb.collection("users").doc(myUid).get();
      const data = doc.data();
      if (data && data.status === "approved") {
        myStatus = "approved";
        await persistSession();
        pendingPanel.classList.add("hidden");
        enterMessenger();
      } else if (!doc.exists) {
        pendingMsg.textContent = "Referans başvurunuz reddedildi. Çıkış yapıp tekrar kayıt olabilirsiniz.";
      } else {
        pendingMsg.textContent = "Henüz onaylanmadı, tekrar dene.";
      }
    } catch (e) {
      pendingMsg.textContent = "Kontrol edilemedi: " + e.message;
    }
  });

  document.getElementById("pending-logout-btn").addEventListener("click", async () => {
    await fbAuth.signOut();
    await clearPersistedSession();
    myUid = null; myNickname = null; myPrivateKey = null; myPublicKey = null; myStatus = null; myReferredByNickname = null;
    pendingPanel.classList.add("hidden");
    closeVaultToCalculator();
  });

  function normalizeNickname(raw) {
    return raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  }

  authBackBtn.addEventListener("click", closeVaultToCalculator);

  async function generateKeyPair() {
    return crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function signUp(nicknameRaw, password, referrerNicknameRaw) {
    const nickname = normalizeNickname(nicknameRaw);
    if (nickname.length < 3) {
      throw new Error("Kullanıcı adı en az 3 karakter olmalı (harf, rakam, alt çizgi).");
    }
    const referrerNickname = normalizeNickname(referrerNicknameRaw || "");

    const cred = await fbAuth.createUserWithEmailAndPassword(nicknameToSyntheticEmail(nickname), password);
    const uid = cred.user.uid;

    try {
      let status = "pending";
      let referredBy = null;
      let referredByNickname = null;

      if (referrerNickname) {
        const refQ = await fbDb.collection("users").where("nickname", "==", referrerNickname).limit(1).get();
        if (refQ.empty) {
          throw new Error("Referans kullanıcı bulunamadı.");
        }
        const refData = refQ.docs[0].data();
        // Accounts predating this feature have no status field — treat them
        // as approved client-side too, for an accurate error message (the
        // Firestore rules require the field to actually be set, though).
        const refStatus = refData.status === undefined ? "approved" : refData.status;
        if (refStatus !== "approved") {
          throw new Error("Referans kullanıcı henüz onaylı değil.");
        }
        referredBy = refQ.docs[0].id;
        referredByNickname = refData.nickname;
      } else {
        // No referrer given: only acceptable if this is the very first account
        // in the system (bootstrap), which is auto-approved.
        const bootstrapDoc = await fbDb.collection("meta").doc("bootstrap").get();
        if (bootstrapDoc.exists) {
          throw new Error("Kayıt olmak için onaylı bir kullanıcının referans kullanıcı adı gerekli.");
        }
        status = "approved";
      }

      const keyPair = await generateKeyPair();
      const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      const privJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

      const pkSalt = crypto.getRandomValues(new Uint8Array(16));
      const pkKey = await deriveKeyFromSecret(password, pkSalt);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encPriv = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        pkKey,
        new TextEncoder().encode(JSON.stringify(privJwk))
      );

      const batch = fbDb.batch();
      batch.set(fbDb.collection("users").doc(uid), {
        nickname,
        publicKeyJwk: pubJwk,
        pkSalt: b64encode(pkSalt.buffer),
        encPrivateKey: { iv: b64encode(iv.buffer), data: b64encode(encPriv) },
        status,
        referredBy,
        referredByNickname,
        blocked: {},
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      if (status === "approved") {
        // Closes the bootstrap gate: the security rules only allow a
        // referrer-less, pre-approved signup while this doc doesn't exist yet,
        // so only the very first account can ever take this path.
        batch.set(fbDb.collection("meta").doc("bootstrap"), {
          uid,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();

      myUid = uid;
      myNickname = nickname;
      myPrivateKey = keyPair.privateKey;
      myPublicKey = keyPair.publicKey;
      myStatus = status;
      myReferredByNickname = referredByNickname;
      myBlocked = {};
      publicKeyCache.set(uid, keyPair.publicKey);
    } catch (e) {
      await cred.user.delete().catch(() => {});
      throw e;
    }
  }

  async function logIn(nicknameRaw, password) {
    const nickname = normalizeNickname(nicknameRaw);
    const cred = await fbAuth.signInWithEmailAndPassword(nicknameToSyntheticEmail(nickname), password);
    const uid = cred.user.uid;
    const doc = await fbDb.collection("users").doc(uid).get();
    const data = doc.data();
    if (!data) throw new Error("Kullanıcı verisi bulunamadı.");

    const pkSalt = new Uint8Array(b64decode(data.pkSalt));
    const pkKey = await deriveKeyFromSecret(password, pkSalt);
    const ivBytes = new Uint8Array(b64decode(data.encPrivateKey.iv));
    let privJwkBytes;
    try {
      privJwkBytes = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivBytes },
        pkKey,
        b64decode(data.encPrivateKey.data)
      );
    } catch (e) {
      throw new Error("Parola yanlış.");
    }
    const privJwk = JSON.parse(new TextDecoder().decode(privJwkBytes));
    const privateKey = await crypto.subtle.importKey(
      "jwk", privJwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk", data.publicKeyJwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
    );

    myUid = uid;
    myNickname = data.nickname || nickname;
    myPrivateKey = privateKey;
    myPublicKey = publicKey;
    // Accounts created before this feature existed have no status field at
    // all — grandfather them in as approved rather than locking them out.
    myStatus = data.status === undefined ? "approved" : data.status;
    myReferredByNickname = data.referredByNickname || null;
    myBlocked = data.blocked || {};
    publicKeyCache.set(uid, publicKey);
  }

  authSubmitBtn.addEventListener("click", async () => {
    const nickname = authNicknameInput.value;
    const password = authPasswordInput.value;
    const referrer = authReferrerInput.value;
    if (normalizeNickname(nickname).length < 3) {
      authError.textContent = "Kullanıcı adı en az 3 karakter olmalı (harf, rakam, alt çizgi).";
      return;
    }
    if (password.length < 6) {
      authError.textContent = "Parola en az 6 karakter olmalı.";
      return;
    }
    authError.textContent = "";
    authSubmitBtn.disabled = true;
    try {
      if (authMode === "signup") {
        await signUp(nickname, password, referrer);
      } else {
        await logIn(nickname, password);
      }
      await persistSession();
      if (myStatus === "approved") {
        enterMessenger();
      } else {
        openPendingPanel();
      }
    } catch (e) {
      authError.textContent = humanizeAuthError(e);
    } finally {
      authSubmitBtn.disabled = false;
    }
  });

  function humanizeAuthError(e) {
    const code = e && e.code;
    if (code === "auth/email-already-in-use") return "Bu kullanıcı adı zaten alınmış.";
    if (code === "auth/invalid-email") return "Geçersiz kullanıcı adı.";
    if (code === "auth/weak-password") return "Parola çok zayıf (en az 6 karakter).";
    if (code === "auth/wrong-password" || code === "auth/invalid-credential") return "Kullanıcı adı veya parola yanlış.";
    if (code === "auth/user-not-found") return "Bu kullanıcı adıyla kayıtlı hesap yok.";
    return (e && e.message) || "Bir hata oluştu.";
  }

  async function getPublicKeyForUid(uid) {
    if (publicKeyCache.has(uid)) return publicKeyCache.get(uid);
    const doc = await fbDb.collection("users").doc(uid).get();
    const data = doc.data();
    if (!data) return null;
    const key = await crypto.subtle.importKey(
      "jwk", data.publicKeyJwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
    );
    publicKeyCache.set(uid, key);
    return key;
  }

  /* ---------------- Messenger (contacts, conversations, E2E messages) ---------------- */

  const threadListPanel = document.getElementById("thread-list-panel");
  const threadDetailPanel = document.getElementById("thread-detail-panel");
  const settingsPanel = document.getElementById("settings-panel");
  const threadListEl = document.getElementById("thread-list");

  let conversations = new Map(); // convId -> {id, otherUid, otherNickname, updatedAt, unread, lastPreview, lastTs}
  let conversationsUnsub = null;
  let activeConvId = null;
  let activeOtherUid = null;
  let activeOtherUids = [];
  let activeIsGroup = false;
  let messagesUnsub = null;
  const lastMessageUnsubs = new Map(); // convId -> unsub
  const previousUnread = new Map(); // convId -> last known unread count, for alarm-trigger edge detection

  // ---- Alarm-style notification: disguised as a phone alarm going off,
  // never mentions messages, senders or nicknames. This in-app version fires
  // while the tab/PWA is open; when it's closed, the FCM push below (handled
  // in sw.js) shows the same disguised notification instead.

  // ---- Selectable alarm sounds (Settings > Bildirim sesleri), generated with
  // WebAudio. The choice is per device (localStorage). Each preset schedules
  // one "ring" starting at t0 and returns its length in seconds; incoming calls
  // repeat it. These only play while the app is open; a closed app's push
  // notification uses the phone's own notification sound.

  function tone(ctx, t, freq, len, type, vol) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol || 0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + len + 0.05);
  }

  const SOUND_PRESETS = {
    classic: { name: "Klasik alarm", play: (ctx, t) => {
      for (let i = 0; i < 4; i++) tone(ctx, t + i * 0.5, 880, 0.3, "sine", 0.35);
      return 2;
    } },
    digital: { name: "Dijital saat", play: (ctx, t) => {
      [0, 0.12, 0.24, 0.36, 0.8, 0.92, 1.04, 1.16].forEach(o => tone(ctx, t + o, 2000, 0.08, "square", 0.08));
      return 1.4;
    } },
    bell: { name: "Zil", play: (ctx, t) => {
      [0, 0.8].forEach(o => {
        tone(ctx, t + o, 660, 1.1, "sine", 0.3);
        tone(ctx, t + o, 1320, 0.7, "sine", 0.12);
        tone(ctx, t + o, 1980, 0.4, "sine", 0.06);
      });
      return 1.9;
    } },
    melody: { name: "Yumuşak melodi", play: (ctx, t) => {
      [523, 659, 784, 1047].forEach((f, i) => tone(ctx, t + i * 0.22, f, 0.4, "triangle", 0.3));
      return 1.3;
    } },
    rising: { name: "Yükselen bip", play: (ctx, t) => {
      for (let i = 0; i < 6; i++) tone(ctx, t + i * 0.22, 600 + i * 120, 0.15, "sine", 0.3);
      return 1.4;
    } },
    silent: { name: "Sessiz (sadece titreşim)", play: () => 0 },
  };

  function getSoundPref(kind) {
    try {
      const v = localStorage.getItem("calcut_sound_" + kind);
      if (v && SOUND_PRESETS[v]) return v;
    } catch (e) {}
    return "classic";
  }

  function setSoundPref(kind, id) {
    try { localStorage.setItem("calcut_sound_" + kind, id); } catch (e) {}
  }

  // Plays a preset once (message alarm, or a preview in Settings).
  function playSoundOnce(presetId) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const len = SOUND_PRESETS[presetId].play(ctx, ctx.currentTime);
      setTimeout(() => ctx.close().catch(() => {}), (len + 1) * 1000);
    } catch (e) {}
  }

  function playAlarmSound() {
    playSoundOnce(getSoundPref("message"));
  }

  function showAlarmNotification() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    try {
      new Notification("Alarm", {
        body: timeStr, tag: "calcut-alarm", silent: true, requireInteraction: false,
        icon: "icons/alarm-192.png", badge: "icons/alarm-badge-96.png",
      });
    } catch (e) {}
  }

  function triggerAlarmAlert() {
    playAlarmSound();
    showAlarmNotification();
    if (navigator.vibrate) {
      try { navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) {}
    }
  }

  // ---- Background push (FCM). After a message is sent or a call starts, the
  // app asks the push Worker (worker/_worker.js, window.PUSH_URLS) to push
  // to every token stored under users/{uid}.fcmTokens of the recipients, so
  // messages and incoming calls still ring when their app is closed. Needs
  // notification permission, and on iOS the app must be opened from the home screen.

  let currentPushToken = null;
  let lastPushError = null; // shown in Settings so a failed setup isn't silent

  // The Android app (native/) has no web push; it gets an FCM token from its
  // NativePush plugin instead and registers it with the push server the same way.
  function nativePush() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.NativePush) || null;
  }
  let nativePushState = null; // { configured, notifications, fullScreen }

  async function refreshNativePushState() {
    const np = nativePush();
    if (!np) return null;
    nativePushState = await np.status().catch(() => null);
    return nativePushState;
  }

  async function pushSupported() {
    if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) return false;
    if (!firebase.messaging) return false;
    try {
      return await firebase.messaging.isSupported();
    } catch (e) {
      return false;
    }
  }

  // interactive: called from the Settings button, so the Android app may ask
  // for notification permission; on sign-in it only registers if already allowed.
  async function registerPushToken(interactive) {
    const np = nativePush();
    if (!myUid) return false;
    if (!np && (!("Notification" in window) || Notification.permission !== "granted")) return false;
    try {
      let token;
      if (np) {
        const st = await refreshNativePushState();
        if (!st || !st.configured) throw new Error("bu uygulama sürümü arka plan bildirimi için ayarlanmamış");
        if (!st.notifications && !interactive) return false;
        try {
          token = (await np.getToken()).token;
        } catch (e) {
          throw new Error(e.message);
        }
        await refreshNativePushState();
      } else {
        if (!(await pushSupported())) throw new Error("bu tarayıcı arka plan bildirimini desteklemiyor");
        const registration = await navigator.serviceWorker.register("sw.js");
        await navigator.serviceWorker.ready;
        const opts = { serviceWorkerRegistration: registration };
        if (window.FCM_VAPID_KEY) opts.vapidKey = window.FCM_VAPID_KEY;
        try {
          token = await firebase.messaging().getToken(opts);
        } catch (e) {
          throw new Error("cihaz anahtarı alınamadı (" + e.message + ")");
        }
      }
      if (!token) throw new Error("cihaz anahtarı alınamadı");
      // Saved through the push Worker, so the Firestore rules don't have to allow it.
      const r = await requestPush({ kind: "register-token", token });
      if (r.error) throw new Error("anahtar kaydedilemedi, bildirim sunucusuna ulaşılamadı (" + r.error + ")");
      if (r.status !== 200) {
        throw new Error("anahtar kaydedilemedi, sunucu hatası " + r.status + " (" + JSON.stringify(r.data) + ")");
      }
      if (!r.data || !(r.data.v >= 3)) {
        throw new Error("Bildirim sunucusunun kodu eski, güncellenmesi gerekiyor.");
      }
      currentPushToken = token;
      lastPushError = null;
      return true;
    } catch (e) {
      lastPushError = e.message;
      throw e;
    }
  }

  function pushStatusText() {
    if (nativePush()) {
      const st = nativePushState;
      if (!st) return "Kontrol ediliyor...";
      if (!st.configured) return "⚠️ Bu uygulama sürümü arka plan bildirimi için henüz ayarlanmadı.";
      if (!st.notifications) return "Bildirimler kapalı. Açmak için yukarıdaki düğmeye bas.";
      if (currentPushToken) {
        return "✅ Arka plan bildirimleri açık: uygulama kapalıyken de mesaj ve aramalarda alarm çalacak." +
          (st.fullScreen ? "" : " Kilit ekranında aramanın tam ekran açılması için düğmeye basıp izin ver.");
      }
      if (lastPushError) return "⚠️ Bildirimler yalnızca uygulama açıkken çalışıyor: " + lastPushError;
      return "Kontrol ediliyor...";
    }
    if (!("Notification" in window)) return "Bu tarayıcı bildirimleri desteklemiyor.";
    if (Notification.permission === "denied") {
      return "Bildirim izni reddedilmiş. Telefon ayarlarından bu uygulamaya bildirim izni ver.";
    }
    if (Notification.permission !== "granted") return "Bildirimler kapalı. Açmak için yukarıdaki düğmeye bas.";
    if (currentPushToken) return "✅ Arka plan bildirimleri açık: uygulama kapalıyken de mesaj ve aramalarda alarm çalacak.";
    if (lastPushError) return "⚠️ Bildirimler yalnızca uygulama açıkken çalışıyor: " + lastPushError;
    return "Kontrol ediliyor...";
  }

  async function unregisterPushToken() {
    if (!myUid || !currentPushToken) return;
    try {
      await requestPush({ kind: "unregister-token", token: currentPushToken });
      const np = nativePush();
      if (np) await np.deleteToken();
      else await firebase.messaging().deleteToken();
    } catch (e) {
      console.error("push token remove error", e);
    }
    currentPushToken = null;
  }

  // Fire-and-forget: the Worker checks with Firestore that this user really
  // sent the message / placed the call before pushing anything.
  // Resolves to { status, data } (data is the server's JSON reply) or { error }.
  // Tries each address in PUSH_URLS until one is reachable (an ISP may block
  // one of the domains) and sticks with the first that answers.
  // Sent as a "simple" request (text/plain body, ID token inside it, no
  // Authorization header) so there's no CORS preflight: the Apps Script
  // server (apps-script/Code.gs) can't answer one.
  const pushUrls = window.PUSH_URLS || (window.PUSH_URL ? [window.PUSH_URL] : []);
  let pushUrlIndex = 0;

  async function requestPush(body) {
    if (!pushUrls.length || !fbAuth.currentUser) return { error: "PUSH_URLS ayarlı değil" };
    let idToken;
    try {
      idToken = await fbAuth.currentUser.getIdToken();
    } catch (e) {
      return { error: e.message };
    }
    let lastError = null;
    for (let i = 0; i < pushUrls.length; i++) {
      const idx = (pushUrlIndex + i) % pushUrls.length;
      try {
        const res = await fetch(pushUrls[idx], {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(Object.assign({ idToken }, body)),
          keepalive: true,
        });
        const data = await res.json().catch(() => null);
        // A reply that isn't our JSON (e.g. a placeholder page) counts as unreachable.
        if (!data) { lastError = pushUrls[idx] + " geçersiz yanıt (" + res.status + ")"; continue; }
        pushUrlIndex = idx;
        // Apps Script always answers 200 and reports failures as { error }.
        const status = res.status === 200 && data.error ? 500 : res.status;
        return { status, data };
      } catch (e) {
        lastError = pushUrls[idx] + ": " + e.message;
      }
    }
    console.error("push request error", lastError);
    return { error: lastError };
  }

  // ---- Android app updates. The app is installed from an APK, so nothing
  // updates it; the release notes carry "versionCode=N" (see the workflow) and
  // a dot on the settings button points to the download when N is newer.
  const APP_RELEASE_API = "https://api.github.com/repos/gavalkadir2-tech/calcut/releases/tags/android-test";
  const APP_APK_URL = "https://github.com/gavalkadir2-tech/calcut/releases/download/android-test/hesap-makinesi.apk";
  let appUpdate = null; // { current, latest } once checked

  function appUpdatePlugin() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.AppUpdate) || null;
  }

  async function checkForAppUpdate() {
    const plugin = appUpdatePlugin();
    if (!plugin) return;
    try {
      const { versionCode } = await plugin.getVersion();
      const res = await fetch(APP_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) return;
      const m = /versionCode=(\d+)/.exec((await res.json()).body || "");
      appUpdate = { current: versionCode, latest: m ? Number(m[1]) : null };
      document.getElementById("settings-btn").classList.toggle("has-update", isAppUpdateAvailable());
      renderAppUpdate();
    } catch (e) {
      console.error("app update check error", e);
    }
  }

  function isAppUpdateAvailable() {
    return !!(appUpdate && appUpdate.latest && appUpdate.latest > appUpdate.current);
  }

  function renderAppUpdate() {
    if (!appUpdatePlugin()) return;
    document.getElementById("app-update-section").classList.remove("hidden");
    const msgEl = document.getElementById("app-update-msg");
    const available = isAppUpdateAvailable();
    document.getElementById("app-update-btn").classList.toggle("hidden", !available);
    if (!appUpdate) msgEl.textContent = "Kontrol ediliyor...";
    else if (available) msgEl.textContent = "Yeni sürüm var (" + appUpdate.latest + "). Bu cihazdaki: " + appUpdate.current + ".";
    else msgEl.textContent = "Uygulama güncel (" + appUpdate.current + ").";
  }

  document.getElementById("app-update-btn").addEventListener("click", () => {
    const plugin = appUpdatePlugin();
    if (plugin) plugin.openDownload({ url: APP_APK_URL }).catch(() => {});
  });

  // Once the call is answered/rejected in the app, drop the ringing system notification.
  function closeCallNotifications() {
    const np = nativePush();
    if (np) { np.cancelCallNotification().catch(() => {}); return; }
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) return;
      return reg.getNotifications({ tag: "calcut-call" }).then(list => list.forEach(n => n.close()));
    }).catch(() => {});
  }

  function convIdFor(uidA, uidB) {
    return [uidA, uidB].sort().join("_");
  }

  function enterMessenger() {
    if (myStatus !== "approved") {
      openPendingPanel();
      return;
    }
    lockPanel.classList.add("hidden");
    authPanel.classList.add("hidden");
    appPanel.classList.remove("hidden");
    showThreadList();
    listenToConversations();
    listenForIncomingCalls();
    registerPushToken().catch(err => console.error("push token register error", err));
    checkForAppUpdate();
    resetInactivityTimer();
    // Refresh the blocked list in case it changed on another device.
    fbDb.collection("users").doc(myUid).get().then(doc => {
      const data = doc.data();
      if (data) { myBlocked = data.blocked || {}; renderThreadList(); }
    }).catch(() => {});
  }

  function showThreadList() {
    threadListPanel.classList.remove("hidden");
    threadDetailPanel.classList.add("hidden");
    settingsPanel.classList.add("hidden");
    renderThreadList();
  }

  function stopAllMessengerListeners() {
    if (conversationsUnsub) { conversationsUnsub(); conversationsUnsub = null; }
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    if (disappearingCheckInterval) { clearInterval(disappearingCheckInterval); disappearingCheckInterval = null; }
    stopTypingListener();
    // The incoming-call listener deliberately keeps running while locked (it
    // follows the Firebase sign-in, see listenForIncomingCalls); it stops on sign-out.
    endCall(null);
    lastMessageUnsubs.forEach(unsub => unsub());
    lastMessageUnsubs.clear();
    conversations.clear();
    previousUnread.clear();
  }

  function subscribeLastMessage(convId, attempt) {
    attempt = attempt || 0;
    if (lastMessageUnsubs.has(convId)) return;
    const unsub = fbDb.collection("conversations").doc(convId).collection("messages")
      .orderBy("ts", "desc").limit(1)
      .onSnapshot(async snap => {
        if (snap.empty) {
          // Messages were cleared but the conversation (contact) stays listed.
          const conv = conversations.get(convId);
          if (conv && conv.lastPreview) {
            conv.lastPreview = "";
            conv.lastIsMissedCall = false;
            if (!threadListPanel.classList.contains("hidden")) renderThreadList();
          }
          return;
        }
        const d = snap.docs[0].data();
        let preview;
        let lastIsMissedCall = false;
        if (d.deleted) {
          preview = "Bu mesaj silindi";
        } else if (d.type === "image") {
          preview = "📷 Fotoğraf";
        } else if (d.type === "file") {
          preview = "📄 Dosya";
        } else if (d.type === "call") {
          const raw = await decryptMessage(d).catch(() => null);
          try {
            const cd = raw ? JSON.parse(raw) : null;
            preview = cd ? callLogText(d.from === myUid, cd.outcome, cd.duration || 0, cd.media) : "📞 Arama";
            lastIsMissedCall = !!cd && isMissedIncomingCall(d.from === myUid, cd.outcome);
          } catch (e) {
            preview = "📞 Arama";
          }
        } else {
          preview = await decryptMessage(d).catch(() => "[çözülemedi]");
        }
        const conv = conversations.get(convId);
        if (!conv) return;
        // Call log previews already read naturally regardless of who placed
        // the call, so skip the usual "Sen: "/sender-name prefix for that type.
        let prefix = "";
        if (d.type !== "call") {
          if (d.from === myUid) prefix = "Sen: ";
          else if (conv.isGroup) prefix = (conv.participantNicknames[d.from] || "?") + ": ";
        }
        conv.lastPreview = prefix + preview;
        conv.lastIsMissedCall = lastIsMissedCall;
        conv.lastTs = d.ts ? d.ts.toMillis() : Date.now();
        if (!threadListPanel.classList.contains("hidden")) renderThreadList();
      }, err => {
        // Right after a conversation is created, the security rules' get() check
        // can momentarily race the write reaching the server, causing a spurious
        // permission-denied here. Retry a few times with backoff before giving up.
        lastMessageUnsubs.delete(convId);
        if (attempt < 5 && conversations.has(convId)) {
          setTimeout(() => subscribeLastMessage(convId, attempt + 1), 400 * (attempt + 1));
        } else {
          console.error("last message listen error", err);
        }
      });
    lastMessageUnsubs.set(convId, unsub);
  }

  function listenToConversations() {
    if (conversationsUnsub) conversationsUnsub();
    conversationsUnsub = fbDb.collection("conversations")
      .where("participants", "array-contains", myUid)
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          if (change.type === "removed") {
            conversations.delete(change.doc.id);
            previousUnread.delete(change.doc.id);
            if (lastMessageUnsubs.has(change.doc.id)) {
              lastMessageUnsubs.get(change.doc.id)();
              lastMessageUnsubs.delete(change.doc.id);
            }
            return;
          }
          const d = change.doc.data();
          const isGroup = !!d.isGroup;
          const otherUid = isGroup ? null : d.participants.find(u => u !== myUid);
          const otherNickname = isGroup ? null : ((d.participantNicknames && d.participantNicknames[otherUid]) || "?");
          const otherUids = isGroup ? (d.participants || []).filter(u => u !== myUid) : [otherUid];
          const unread = (d.unreadCount && d.unreadCount[myUid]) || 0;
          const muted = !!(d.muted && d.muted[myUid]);
          const existing = conversations.get(change.doc.id) || {};
          conversations.set(change.doc.id, {
            id: change.doc.id,
            otherUid,
            otherNickname,
            otherUids,
            isGroup,
            groupName: d.groupName || null,
            participants: d.participants || [],
            participantNicknames: d.participantNicknames || {},
            updatedAt: d.updatedAt ? d.updatedAt.toMillis() : 0,
            unread,
            lastPreview: existing.lastPreview || "",
            lastIsMissedCall: !!existing.lastIsMissedCall,
            lastTs: existing.lastTs || 0,
            disappearingSeconds: d.disappearingSeconds || 0,
            muted,
          });
          if (change.doc.id === activeConvId) { updateDisappearingUi(); updateMuteUi(); }
          subscribeLastMessage(change.doc.id);

          // Fire the alarm-style notification for a new message: only once
          // we've already seen this conversation before (skip the initial
          // snapshot on login, which would otherwise fire for old unread
          // messages) and only if it's not the conversation currently open.
          const prev = previousUnread.get(change.doc.id);
          if (prev !== undefined && unread > prev && change.doc.id !== activeConvId && !(otherUid && myBlocked[otherUid]) && !muted) {
            triggerAlarmAlert();
          }
          previousUnread.set(change.doc.id, unread);
        });
        if (!threadDetailPanel.classList.contains("hidden")) return;
        renderThreadList();
      }, err => console.error("conversations listen error", err));
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function formatCallDuration(sec) {
    const mm = Math.floor(sec / 60);
    const ss = sec % 60;
    return mm + ":" + String(ss).padStart(2, "0");
  }

  // The call log entry is written by the caller, so fromMe = I placed the call.
  function callLogText(fromMe, outcome, duration, media) {
    const dirWord = fromMe ? "Giden" : "Gelen";
    const icon = media === "video" ? "📹" : "📞";
    const kind = media === "video" ? "görüntülü arama" : "arama";
    if (outcome === "completed") return `${icon} ${dirWord} ${kind} · ${formatCallDuration(duration)}`;
    if (outcome === "missed" || outcome === "canceled") {
      // For the person being called, an unanswered call is a missed call
      // whether the caller gave up or it timed out.
      return fromMe ? `${icon} Giden ${kind} · Yanıtlanmadı` : `📵 Cevapsız ${kind}`;
    }
    if (outcome === "rejected") return fromMe ? "📵 Arama reddedildi" : "📵 Aramayı reddettiniz";
    return `${icon} Arama`;
  }

  // Missed incoming calls are highlighted in red, in the chat and the thread list.
  function isMissedIncomingCall(fromMe, outcome) {
    return !fromMe && (outcome === "missed" || outcome === "canceled");
  }

  function formatThreadTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
  }

  function renderThreadList() {
    threadListEl.innerHTML = "";
    const list = Array.from(conversations.values()).sort((a, b) => (b.lastTs || b.updatedAt) - (a.lastTs || a.updatedAt));
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = "Henüz sohbet yok. '+' ile bir kişinin kullanıcı adını ekle.";
      li.style.cursor = "default";
      threadListEl.appendChild(li);
      return;
    }
    list.forEach(conv => {
      const li = document.createElement("li");
      if (conv.unread > 0) li.classList.add("unread");
      li.innerHTML = `
        <div class="thread-row">
          <span class="thread-name"></span>
          <span class="thread-time"></span>
        </div>
        <div class="thread-row">
          <span class="thread-preview"></span>
          <span class="thread-badge hidden">0</span>
        </div>`;
      const displayName = conv.isGroup ? `👥 ${conv.groupName} (${conv.participants.length})` : "@" + conv.otherNickname;
      li.querySelector(".thread-name").textContent = displayName + (conv.muted ? " 🔕" : "");
      li.querySelector(".thread-time").textContent = formatThreadTime(conv.lastTs || conv.updatedAt);
      if (!conv.isGroup && myBlocked[conv.otherUid]) {
        li.classList.add("blocked");
        li.querySelector(".thread-preview").textContent = "🚫 Engellendi";
      } else {
        li.querySelector(".thread-preview").textContent = conv.lastPreview || "Aç ve sohbet et";
        if (conv.lastIsMissedCall) li.classList.add("missed-call");
      }
      if (conv.unread > 0) {
        const badge = li.querySelector(".thread-badge");
        badge.textContent = conv.unread > 99 ? "99+" : String(conv.unread);
        badge.classList.remove("hidden");
      }
      li.addEventListener("click", () => openConversation(conv.id, conv.otherUid, conv.otherNickname, {
        isGroup: conv.isGroup, groupName: conv.groupName, participants: conv.participants,
      }));
      threadListEl.appendChild(li);
    });
  }

  document.getElementById("new-thread-btn").addEventListener("click", () => {
    document.getElementById("new-thread-name").value = "";
    document.getElementById("new-thread-modal").classList.remove("hidden");
  });
  document.getElementById("new-thread-cancel").addEventListener("click", () => {
    document.getElementById("new-thread-modal").classList.add("hidden");
  });
  document.getElementById("new-thread-create").addEventListener("click", async () => {
    const nickname = normalizeNickname(document.getElementById("new-thread-name").value);
    if (!nickname) return;
    if (nickname === myNickname) {
      alert("Kendi kullanıcı adını ekleyemezsin.");
      return;
    }
    try {
      const q = await fbDb.collection("users").where("nickname", "==", nickname).limit(1).get();
      if (q.empty) {
        alert("Bu kullanıcı adıyla kayıtlı bir kullanıcı bulunamadı.");
        return;
      }
      const otherDoc = q.docs[0];
      const otherUid = otherDoc.id;
      const otherData = otherDoc.data();
      const convId = convIdFor(myUid, otherUid);
      await fbDb.collection("conversations").doc(convId).set({
        participants: [myUid, otherUid],
        participantNicknames: { [myUid]: myNickname, [otherUid]: otherData.nickname },
        unreadCount: { [myUid]: 0, [otherUid]: 0 },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      document.getElementById("new-thread-modal").classList.add("hidden");
      openConversation(convId, otherUid, otherData.nickname);
    } catch (e) {
      alert("Sohbet eklenemedi: " + e.message);
    }
  });

  const MAX_GROUP_PARTICIPANTS = 20;

  document.getElementById("new-group-btn").addEventListener("click", () => {
    document.getElementById("new-group-name-input").value = "";
    document.querySelectorAll(".new-group-member-input").forEach(i => i.value = "");
    document.getElementById("new-group-modal").classList.remove("hidden");
  });
  document.getElementById("new-group-cancel").addEventListener("click", () => {
    document.getElementById("new-group-modal").classList.add("hidden");
  });
  document.getElementById("new-group-add-member").addEventListener("click", () => {
    const container = document.getElementById("new-group-members");
    if (container.querySelectorAll(".new-group-member-input").length >= MAX_GROUP_PARTICIPANTS - 1) return;
    const input = document.createElement("input");
    input.className = "new-group-member-input";
    input.type = "text";
    input.placeholder = "Kişinin kullanıcı adı (rumuz)";
    container.appendChild(input);
  });
  document.getElementById("new-group-create").addEventListener("click", async () => {
    const groupName = document.getElementById("new-group-name-input").value.trim();
    if (!groupName) { alert("Grup adı gerekli."); return; }
    const nicknames = [...new Set(
      Array.from(document.querySelectorAll(".new-group-member-input"))
        .map(i => normalizeNickname(i.value))
        .filter(Boolean)
        .filter(n => n !== myNickname)
    )];
    if (nicknames.length < 2) { alert("Kendin hariç en az 2 kişi eklemelisin."); return; }
    try {
      const participants = [myUid];
      const participantNicknames = { [myUid]: myNickname };
      for (const nick of nicknames) {
        const q = await fbDb.collection("users").where("nickname", "==", nick).limit(1).get();
        if (q.empty) { alert(`Kullanıcı bulunamadı: @${nick}`); return; }
        const doc = q.docs[0];
        participants.push(doc.id);
        participantNicknames[doc.id] = doc.data().nickname;
      }
      const unreadCount = {};
      participants.forEach(u => { unreadCount[u] = 0; });
      const convRef = fbDb.collection("conversations").doc();
      await convRef.set({
        participants,
        participantNicknames,
        unreadCount,
        isGroup: true,
        groupName,
        createdBy: myUid,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      document.getElementById("new-group-modal").classList.add("hidden");
      openConversation(convRef.id, null, null, { isGroup: true, groupName, participants });
    } catch (e) {
      alert("Grup oluşturulamadı: " + e.message);
    }
  });

  function lockVault() {
    stopAllMessengerListeners();
    myPrivateKey = null;
    myPublicKey = null;
    closeVaultToCalculator();
  }

  document.getElementById("lock-btn").addEventListener("click", lockVault);
  document.getElementById("duress-lock-btn").addEventListener("click", closeVaultToCalculator);
  document.getElementById("duress-new-thread-btn").addEventListener("click", () => {
    alert("Sohbet eklenemedi. Lütfen daha sonra tekrar deneyin.");
  });

  /* ---------------- Auto-lock: backgrounding or inactivity ---------------- */
  // Locking here only hides the vault and drops the in-memory private key —
  // it does NOT clear the persisted PIN-protected session, so re-entering the
  // PIN immediately restores it (same as tapping the manual lock button).

  const INACTIVITY_LOCK_MS = 5 * 60 * 1000; // 5 minutes with no interaction
  const BACKGROUND_LOCK_MS = 30 * 1000; // 30 seconds fully backgrounded/hidden
  let inactivityTimer = null;
  let backgroundTimer = null;

  function isVaultUnlockedView() {
    return !vaultView.classList.contains("hidden") &&
      lockPanel.classList.contains("hidden") &&
      authPanel.classList.contains("hidden");
  }

  function autoLockNow() {
    if (!isVaultUnlockedView()) return;
    if (activeCallId) return; // locking would hang up the call (screen off mid-call)
    lockVault();
  }

  function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    if (!isVaultUnlockedView()) return;
    inactivityTimer = setTimeout(autoLockNow, INACTIVITY_LOCK_MS);
  }

  ["click", "keydown", "touchstart", "mousemove"].forEach(evt => {
    document.addEventListener(evt, resetInactivityTimer, { passive: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(backgroundTimer);
      if (!isVaultUnlockedView()) return;
      backgroundTimer = setTimeout(autoLockNow, BACKGROUND_LOCK_MS);
    } else {
      clearTimeout(backgroundTimer);
      resetInactivityTimer();
    }
  });

  document.getElementById("settings-btn").addEventListener("click", () => {
    threadListPanel.classList.add("hidden");
    threadDetailPanel.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
    document.getElementById("new-pin-input").value = "";
    document.getElementById("settings-msg").textContent = "";
    document.getElementById("biometric-msg").textContent = "";
    renderBiometricButtons();
    const alarmMsgEl = document.getElementById("alarm-msg");
    alarmMsgEl.textContent = pushStatusText();
    if (nativePush()) {
      refreshNativePushState().then(() => {
        alarmMsgEl.textContent = pushStatusText();
        if (!currentPushToken) {
          registerPushToken().catch(() => {}).then(() => { alarmMsgEl.textContent = pushStatusText(); });
        }
      });
    } else if (!currentPushToken && "Notification" in window && Notification.permission === "granted") {
      registerPushToken().catch(() => {}).then(() => { alarmMsgEl.textContent = pushStatusText(); });
    }
    document.getElementById("nickname-change-msg").textContent = "";
    document.getElementById("new-nickname-input").value = "";
    document.getElementById("duress-pin-msg").textContent = "";
    renderAppUpdate();
    document.getElementById("duress-pin-input").value = "";
    document.getElementById("backup-msg").textContent = "";
    loadPendingReferrals();
  });
  document.getElementById("settings-back-btn").addEventListener("click", showThreadList);

  async function loadPendingReferrals() {
    const listEl = document.getElementById("pending-referrals-list");
    listEl.innerHTML = "<li class='empty-state'>Yükleniyor...</li>";
    try {
      const q = await fbDb.collection("users")
        .where("referredBy", "==", myUid)
        .where("status", "==", "pending")
        .get();
      listEl.innerHTML = "";
      if (q.empty) {
        listEl.innerHTML = "<li class='empty-state'>Bekleyen referans yok.</li>";
        return;
      }
      q.docs.forEach(doc => {
        const data = doc.data();
        const li = document.createElement("li");
        li.innerHTML = `<span></span><div class="referral-actions"><button class="approve-btn">Onayla</button><button class="reject-btn">Reddet</button></div>`;
        li.querySelector("span").textContent = "@" + data.nickname;
        li.querySelectorAll("button").forEach(btn => btn.disabled = false);
        li.querySelector(".approve-btn").addEventListener("click", async (ev) => {
          li.querySelectorAll("button").forEach(btn => btn.disabled = true);
          try {
            await fbDb.collection("users").doc(doc.id).update({ status: "approved" });
            li.remove();
          } catch (e) {
            alert("Onaylanamadı: " + e.message);
            li.querySelectorAll("button").forEach(btn => btn.disabled = false);
          }
        });
        li.querySelector(".reject-btn").addEventListener("click", async () => {
          if (!confirm(`@${data.nickname} kullanıcısının referans başvurusu reddedilsin mi?`)) return;
          li.querySelectorAll("button").forEach(btn => btn.disabled = true);
          try {
            await fbDb.collection("users").doc(doc.id).delete();
            li.remove();
          } catch (e) {
            alert("Reddedilemedi: " + e.message);
            li.querySelectorAll("button").forEach(btn => btn.disabled = false);
          }
        });
        listEl.appendChild(li);
      });
    } catch (e) {
      listEl.innerHTML = "<li class='empty-state'>Yüklenemedi.</li>";
    }
  }

  document.getElementById("change-nickname-btn").addEventListener("click", async () => {
    const msgEl = document.getElementById("nickname-change-msg");
    const newNicknameRaw = document.getElementById("new-nickname-input").value;
    const newNickname = normalizeNickname(newNicknameRaw);
    if (newNickname.length < 3) {
      msgEl.textContent = "Kullanıcı adı en az 3 karakter olmalı (harf, rakam, alt çizgi).";
      return;
    }
    if (newNickname === myNickname) {
      msgEl.textContent = "Bu zaten mevcut kullanıcı adın.";
      return;
    }
    msgEl.textContent = "Değiştiriliyor...";
    try {
      // Renaming only changes the display/lookup nickname, never the login
      // credential: Firebase Auth now requires verifying a new email before
      // it takes effect, which our synthetic @calcut.local addresses can
      // never do. So unlike at signup, uniqueness has to be checked here by
      // hand instead of relying on Firebase Auth's email-collision check.
      const existing = await fbDb.collection("users").where("nickname", "==", newNickname).limit(1).get();
      if (!existing.empty) {
        msgEl.textContent = "Bu kullanıcı adı zaten alınmış.";
        return;
      }
      await fbDb.collection("users").doc(myUid).update({ nickname: newNickname });

      // Propagate the new nickname into every conversation this account is
      // part of, so the other side's thread list stays accurate.
      const convs = await fbDb.collection("conversations").where("participants", "array-contains", myUid).get();
      const batch = fbDb.batch();
      convs.docs.forEach(doc => {
        batch.update(doc.ref, { [`participantNicknames.${myUid}`]: newNickname });
      });
      if (!convs.empty) await batch.commit();

      myNickname = newNickname;
      await persistSession();
      renderThreadList();
      msgEl.textContent = "Görünen adın @" + newNickname + " oldu. Girişte hâlâ eski kullanıcı adını kullanmalısın.";
      document.getElementById("new-nickname-input").value = "";
    } catch (e) {
      msgEl.textContent = "Değiştirilemedi: " + e.message;
    }
  });

  document.getElementById("change-pin-btn").addEventListener("click", async () => {
    const newPin = document.getElementById("new-pin-input").value.trim();
    const msgEl = document.getElementById("settings-msg");
    if (newPin.length < 4) {
      msgEl.textContent = "Yeni PIN en az 4 karakter olmalı.";
      return;
    }
    const newKey = await deriveLocalKey(newPin);
    await saveLocalBlob(newKey, localSessionData || {});
    currentLocalKey = newKey;
    msgEl.textContent = "PIN güncellendi.";
    document.getElementById("new-pin-input").value = "";
  });

  document.getElementById("set-duress-pin-btn").addEventListener("click", async () => {
    const msgEl = document.getElementById("duress-pin-msg");
    const pin = document.getElementById("duress-pin-input").value.trim();
    if (pin.length < 4) {
      msgEl.textContent = "Yanılgı PIN'i en az 4 karakter olmalı.";
      return;
    }
    if (pin === pinInput.value.trim()) {
      msgEl.textContent = "Yanılgı PIN'i gerçek PIN'in ile aynı olamaz.";
      return;
    }
    try {
      const realKeyCheck = await deriveLocalKey(pin);
      // Guard against picking a duress PIN that happens to equal the real
      // vault PIN, which would make the real vault permanently unreachable
      // with that value (real PIN is always tried first, so this alone
      // isn't unsafe, but a matching value would make the decoy pointless).
      if (vaultExists()) {
        try {
          await loadLocalBlob(realKeyCheck);
          msgEl.textContent = "Bu değer gerçek PIN'in ile çakışıyor, başka bir PIN seç.";
          return;
        } catch (e) { /* good: it doesn't match the real PIN */ }
      }
      await setDuressPin(pin);
      msgEl.textContent = "Yanılgı PIN'i belirlendi.";
      document.getElementById("duress-pin-input").value = "";
    } catch (e) {
      msgEl.textContent = "Belirlenemedi: " + e.message;
    }
  });

  document.getElementById("clear-duress-pin-btn").addEventListener("click", () => {
    const msgEl = document.getElementById("duress-pin-msg");
    clearDuressPin();
    msgEl.textContent = "Yanılgı PIN'i kaldırıldı.";
    document.getElementById("duress-pin-input").value = "";
  });

  document.getElementById("enable-biometric-btn").addEventListener("click", async () => {
    const msgEl = document.getElementById("biometric-msg");
    if (!window.PublicKeyCredential) {
      msgEl.textContent = "Bu cihaz/tarayıcı biyometrik onayı desteklemiyor.";
      return;
    }
    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: "Hesap Makinesi" },
          user: {
            id: crypto.getRandomValues(new Uint8Array(16)),
            name: myNickname || "kullanici",
            displayName: myNickname || "Kullanıcı",
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { userVerification: "required" },
          timeout: 60000,
        },
      });
      localStorage.setItem(STORAGE_BIOMETRIC, b64encode(cred.rawId));
      renderBiometricButtons();
      msgEl.textContent = "Biyometrik onay etkinleştirildi.";
    } catch (e) {
      msgEl.textContent = "Biyometrik kayıt başarısız: " + e.message;
    }
  });

  function renderBiometricButtons() {
    const enabled = !!localStorage.getItem(STORAGE_BIOMETRIC);
    document.getElementById("enable-biometric-btn").classList.toggle("hidden", enabled);
    document.getElementById("disable-biometric-btn").classList.toggle("hidden", !enabled);
  }

  document.getElementById("disable-biometric-btn").addEventListener("click", () => {
    if (!confirm("Biyometrik onay kaldırılsın mı? Kilit yalnızca PIN ile açılacak.")) return;
    localStorage.removeItem(STORAGE_BIOMETRIC);
    renderBiometricButtons();
    document.getElementById("biometric-msg").textContent = "Biyometrik onay kaldırıldı.";
  });

  document.getElementById("enable-alarm-btn").addEventListener("click", async () => {
    const msgEl = document.getElementById("alarm-msg");
    const np = nativePush();
    if (np) {
      msgEl.textContent = "Kaydediliyor...";
      try {
        await registerPushToken(true);
      } catch (e) {
        console.error("push token register error", e);
      }
      const st = await refreshNativePushState();
      // Android 14+ only lets an app ring full screen on the lock screen once the user allows it.
      if (currentPushToken && st && !st.fullScreen) await np.openFullScreenSettings().catch(() => {});
      msgEl.textContent = pushStatusText();
      return;
    }
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (isIos && !standalone) {
      msgEl.textContent = "iPhone'da bildirim için önce Paylaş > Ana Ekrana Ekle ile uygulamayı ekleyip ana ekrandaki ikondan açmalısın.";
      return;
    }
    if (!("Notification" in window)) {
      msgEl.textContent = "Bu tarayıcı bildirimleri desteklemiyor.";
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        triggerAlarmAlert();
        msgEl.textContent = "Kaydediliyor...";
        try {
          await registerPushToken();
        } catch (e) {
          console.error("push token register error", e);
        }
        msgEl.textContent = pushStatusText();
      } else {
        msgEl.textContent = "Bildirim izni verilmedi.";
      }
    } catch (e) {
      msgEl.textContent = "Bildirimler etkinleştirilemedi: " + e.message;
    }
  });

  // Settings > Bildirim sesleri: one picker for the message alarm, one for calls.
  [["message", "message-sound-select", "message-sound-preview"],
   ["call", "call-sound-select", "call-sound-preview"]].forEach(([kind, selectId, previewId]) => {
    const select = document.getElementById(selectId);
    Object.keys(SOUND_PRESETS).forEach(id => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = SOUND_PRESETS[id].name;
      select.appendChild(opt);
    });
    select.value = getSoundPref(kind);
    select.addEventListener("change", () => {
      setSoundPref(kind, select.value);
      playSoundOnce(select.value);
    });
    document.getElementById(previewId).addEventListener("click", () => {
      playSoundOnce(select.value);
      if (navigator.vibrate) {
        try { navigator.vibrate([300, 150, 300]); } catch (e) {}
      }
    });
  });

  document.getElementById("test-push-btn").addEventListener("click", async () => {
    const msgEl = document.getElementById("alarm-msg");
    if (!currentPushToken) {
      msgEl.textContent = pushStatusText();
      return;
    }
    msgEl.textContent = "Test bildirimi gönderiliyor...";
    const r = await requestPush({ kind: "test" });
    if (r.error) {
      msgEl.textContent = "⚠️ Bildirim sunucusuna ulaşılamadı: " + r.error;
    } else if (r.status === 200 && r.data && !(r.data.v >= 3)) {
      msgEl.textContent = "⚠️ Bildirim sunucusunun kodu eski, güncellenmesi gerekiyor.";
    } else if (r.status === 200 && r.data && r.data.sent > 0) {
      msgEl.textContent = "✅ Test bildirimi gönderildi. Birkaç saniye içinde \"Alarm\" bildirimi gelmeli. Geldiyse kurulum tamam.";
    } else if (r.status === 200) {
      msgEl.textContent = "⚠️ Sunucu bu cihaza ulaşamadı (gönderilen: 0). Bildirimleri Etkinleştir'e tekrar bas.";
    } else {
      msgEl.textContent = "⚠️ Bildirim sunucusu hata verdi (" + r.status + "): " + JSON.stringify(r.data);
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    if (!confirm("Hesabından çıkış yapılsın mı?")) return;
    stopAllMessengerListeners();
    await unregisterPushToken();
    await fbAuth.signOut();
    await clearPersistedSession();
    myUid = null; myNickname = null; myPrivateKey = null; myPublicKey = null; myStatus = null; myReferredByNickname = null;
    closeVaultToCalculator();
  });

  document.getElementById("wipe-vault-btn").addEventListener("click", () => {
    if (!confirm("Bu cihazdaki yerel kilit verileri silinecek (mesajların hesabında güvende kalır). Emin misiniz?")) return;
    localStorage.removeItem(STORAGE_BLOB);
    localStorage.removeItem(STORAGE_SALT);
    localStorage.removeItem(STORAGE_BIOMETRIC);
    clearDuressPin();
    closeVaultToCalculator();
  });

  /* ---------------- Encrypted backup / export ---------------- */
  // Client-side only: decrypts every conversation this account can already
  // read and re-packages it into a single file, encrypted with a
  // user-chosen backup password (independent of both the local PIN and the
  // account password). Import only decrypts and displays it locally for
  // reading — it never writes anything back to Firestore.

  document.getElementById("export-backup-btn").addEventListener("click", async () => {
    const msgEl = document.getElementById("backup-msg");
    const password = prompt("Yedek dosyasını şifrelemek için bir parola belirle (bu parolayı unutma, yedeği açmak için gerekecek):");
    if (!password) return;
    msgEl.textContent = "Hazırlanıyor...";
    try {
      const convsSnap = await fbDb.collection("conversations").where("participants", "array-contains", myUid).get();
      const exportedConvs = [];
      for (const convDoc of convsSnap.docs) {
        const cd = convDoc.data();
        const otherUid = cd.participants.find(u => u !== myUid);
        const otherNickname = (cd.participantNicknames && cd.participantNicknames[otherUid]) || "?";
        const msgsSnap = await fbDb.collection("conversations").doc(convDoc.id).collection("messages").orderBy("ts").get();
        const messages = [];
        for (const msgDoc of msgsSnap.docs) {
          const d = msgDoc.data();
          if (d.deleted) continue;
          let plain;
          try { plain = await decryptMessage(d); } catch (e) { continue; }
          messages.push({
            from: d.from === myUid ? myNickname : otherNickname,
            type: d.type,
            content: plain,
            ts: d.ts ? d.ts.toMillis() : null,
            edited: !!d.edited,
          });
        }
        exportedConvs.push({ otherNickname, messages });
      }
      const payload = { exportedAt: Date.now(), nickname: myNickname, conversations: exportedConvs };
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKeyFromSecret(password, salt);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload))
      );
      const fileObj = {
        calcutBackup: true,
        version: 1,
        salt: b64encode(salt.buffer),
        iv: b64encode(iv.buffer),
        data: b64encode(ciphertext),
      };
      const blob = new Blob([JSON.stringify(fileObj)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `calcut-yedek-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      msgEl.textContent = `Yedek indirildi (${exportedConvs.length} sohbet).`;
    } catch (e) {
      msgEl.textContent = "Yedek alınamadı: " + e.message;
    }
  });

  const importBackupInput = document.getElementById("import-backup-input");
  document.getElementById("import-backup-btn").addEventListener("click", () => importBackupInput.click());
  importBackupInput.addEventListener("change", async () => {
    const file = importBackupInput.files[0];
    importBackupInput.value = "";
    if (!file) return;
    const msgEl = document.getElementById("backup-msg");
    const password = prompt("Yedek dosyasının parolasını gir:");
    if (!password) return;
    try {
      const text = await file.text();
      const fileObj = JSON.parse(text);
      if (!fileObj.calcutBackup) throw new Error("Bu bir calcut yedek dosyası değil.");
      const salt = new Uint8Array(b64decode(fileObj.salt));
      const key = await deriveKeyFromSecret(password, salt);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(b64decode(fileObj.iv)) },
        key,
        b64decode(fileObj.data)
      );
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      showBackupViewer(payload);
      msgEl.textContent = "";
    } catch (e) {
      msgEl.textContent = "Yedek açılamadı: yanlış parola veya bozuk dosya.";
    }
  });

  function showBackupViewer(payload) {
    const content = document.getElementById("backup-viewer-content");
    content.innerHTML = "";
    const header = document.createElement("p");
    header.textContent = `@${payload.nickname} — ${new Date(payload.exportedAt).toLocaleString()} tarihli yedek`;
    content.appendChild(header);
    (payload.conversations || []).forEach(conv => {
      const h4 = document.createElement("h4");
      h4.textContent = "@" + conv.otherNickname;
      content.appendChild(h4);
      if (!conv.messages.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "Mesaj yok.";
        content.appendChild(empty);
        return;
      }
      conv.messages.forEach(m => {
        const line = document.createElement("div");
        line.className = "backup-msg-line";
        const from = document.createElement("span");
        from.className = "backup-from";
        from.textContent = "@" + m.from + ":";
        line.appendChild(from);
        let text;
        if (m.type === "image") text = "📷 Fotoğraf";
        else if (m.type === "file") text = "📄 Dosya";
        else if (m.type === "call") text = "📞 Arama kaydı";
        else text = m.content + (m.edited ? " (düzenlendi)" : "");
        line.appendChild(document.createTextNode(text));
        content.appendChild(line);
      });
    });
    document.getElementById("backup-viewer-modal").classList.remove("hidden");
  }

  document.getElementById("backup-viewer-close").addEventListener("click", () => {
    document.getElementById("backup-viewer-modal").classList.add("hidden");
  });

  /* ---------------- Conversation detail / E2E message send+receive ---------------- */

  const messageListEl = document.getElementById("message-list");
  const messageInput = document.getElementById("message-input");
  const attachPhotoBtn = document.getElementById("attach-photo-btn");
  const photoInput = document.getElementById("photo-input");

  async function openConversation(convId, otherUid, otherNickname, extra) {
    extra = extra || {};
    closeThreadSearch();
    activeConvId = convId;
    activeIsGroup = !!extra.isGroup;
    activeOtherUid = activeIsGroup ? null : otherUid;
    activeOtherUids = activeIsGroup ? (extra.participants || []).filter(u => u !== myUid) : [otherUid];
    threadListPanel.classList.add("hidden");
    threadDetailPanel.classList.remove("hidden");
    settingsPanel.classList.add("hidden");
    document.getElementById("thread-title").textContent = activeIsGroup
      ? `👥 ${extra.groupName} (${(extra.participants || []).length})`
      : "@" + otherNickname;
    document.getElementById("thread-call-btn").classList.toggle("hidden", activeIsGroup);
    document.getElementById("thread-video-call-btn").classList.toggle("hidden", activeIsGroup);
    document.getElementById("thread-block-btn").classList.toggle("hidden", activeIsGroup);
    const conv = conversations.get(convId);
    if (conv) conv.unread = 0;
    fbDb.collection("conversations").doc(convId).update({ [`unreadCount.${myUid}`]: 0 }).catch(() => {});
    if (activeIsGroup) {
      await Promise.all(activeOtherUids.map(u => getPublicKeyForUid(u)));
      threadTypingEl.classList.add("hidden");
      // Not gated by updateBlockUi() for a group, so reset explicitly.
      messageInput.disabled = false;
      document.getElementById("message-send-btn").disabled = false;
      attachPhotoBtn.disabled = false;
      threadBlockedBanner.classList.add("hidden");
    } else {
      await getPublicKeyForUid(otherUid);
      listenToTyping(convId, otherUid);
      updateBlockUi();
    }
    listenToMessages(convId);
    updateDisappearingUi();
    updateMuteUi();
  }

  /* ---------------- Block / unblock a contact ---------------- */

  const threadBlockBtn = document.getElementById("thread-block-btn");
  const threadBlockedBanner = document.getElementById("thread-blocked-banner");

  function updateBlockUi() {
    const isBlocked = !!myBlocked[activeOtherUid];
    threadBlockBtn.classList.toggle("active", isBlocked);
    threadBlockBtn.title = isBlocked ? "Engeli kaldır" : "Kullanıcıyı engelle";
    threadBlockedBanner.classList.toggle("hidden", !isBlocked);
    messageInput.disabled = isBlocked;
    document.getElementById("message-send-btn").disabled = isBlocked;
    attachPhotoBtn.disabled = isBlocked;
    document.getElementById("thread-call-btn").disabled = isBlocked;
    document.getElementById("thread-video-call-btn").disabled = isBlocked;
  }

  async function setBlocked(otherUid, blocked) {
    const previous = myBlocked;
    myBlocked = { ...myBlocked };
    if (blocked) myBlocked[otherUid] = true;
    else delete myBlocked[otherUid];
    updateBlockUi();
    renderThreadList();
    try {
      await fbDb.collection("users").doc(myUid).update({
        [`blocked.${otherUid}`]: blocked ? true : firebase.firestore.FieldValue.delete(),
      });
      persistSession();
    } catch (e) {
      myBlocked = previous;
      updateBlockUi();
      renderThreadList();
      throw e;
    }
  }

  threadBlockBtn.addEventListener("click", async () => {
    if (!activeOtherUid) return;
    const isBlocked = !!myBlocked[activeOtherUid];
    if (!isBlocked && !confirm("Bu kullanıcıyı engellemek istediğinize emin misiniz? Birbirinize mesaj gönderemeyeceksiniz.")) return;
    try {
      await setBlocked(activeOtherUid, !isBlocked);
    } catch (e) {
      alert("İşlem başarısız: " + e.message);
    }
  });

  document.getElementById("thread-unblock-btn").addEventListener("click", async () => {
    if (!activeOtherUid) return;
    try {
      await setBlocked(activeOtherUid, false);
    } catch (e) {
      alert("İşlem başarısız: " + e.message);
    }
  });

  /* ---------------- Per-conversation mute ---------------- */
  // Muting is per-user (stored as muted.{myUid} on the conversation doc), so
  // each side can mute independently. It only silences the alarm-style
  // notification for new messages — the thread keeps working normally.

  const threadMuteBtn = document.getElementById("thread-mute-btn");

  function updateMuteUi() {
    const conv = activeConvId ? conversations.get(activeConvId) : null;
    const muted = conv ? !!conv.muted : false;
    threadMuteBtn.classList.toggle("active", muted);
    threadMuteBtn.textContent = muted ? "🔕" : "🔔";
    threadMuteBtn.title = muted ? "Sesi aç" : "Sohbeti sessize al";
  }

  threadMuteBtn.addEventListener("click", async () => {
    if (!activeConvId) return;
    const convId = activeConvId;
    const conv = conversations.get(convId);
    const newMuted = !(conv && conv.muted);
    try {
      await fbDb.collection("conversations").doc(convId).update({ [`muted.${myUid}`]: newMuted });
      if (conv) conv.muted = newMuted;
      updateMuteUi();
      renderThreadList();
    } catch (e) {
      alert("İşlem başarısız: " + e.message);
    }
  });

  /* ---------------- Disappearing messages (per-conversation timer) ---------------- */

  const threadDisappearingBtn = document.getElementById("thread-disappearing-btn");
  const disappearingModal = document.getElementById("disappearing-modal");

  function updateDisappearingUi() {
    const conv = activeConvId ? conversations.get(activeConvId) : null;
    const seconds = conv ? (conv.disappearingSeconds || 0) : 0;
    threadDisappearingBtn.classList.toggle("active", seconds > 0);
    threadDisappearingBtn.title = seconds > 0 ? "Kaybolan mesajlar açık" : "Kaybolan mesajlar";
  }

  threadDisappearingBtn.addEventListener("click", () => {
    if (!activeConvId) return;
    const conv = conversations.get(activeConvId);
    const current = conv ? (conv.disappearingSeconds || 0) : 0;
    disappearingModal.querySelectorAll(".disappearing-opt").forEach(btn => {
      btn.classList.toggle("active", Number(btn.dataset.seconds) === current);
    });
    disappearingModal.classList.remove("hidden");
  });

  document.getElementById("disappearing-cancel").addEventListener("click", () => {
    disappearingModal.classList.add("hidden");
  });

  disappearingModal.querySelectorAll(".disappearing-opt").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!activeConvId) return;
      const seconds = Number(btn.dataset.seconds);
      const convId = activeConvId;
      try {
        await fbDb.collection("conversations").doc(convId).update({ disappearingSeconds: seconds });
        const conv = conversations.get(convId);
        if (conv) conv.disappearingSeconds = seconds;
        updateDisappearingUi();
      } catch (e) {
        alert("Ayarlanamadı: " + e.message);
      } finally {
        disappearingModal.classList.add("hidden");
      }
    });
  });

  async function pruneExpiredMessages(convId) {
    try {
      const q = await fbDb.collection("conversations").doc(convId).collection("messages")
        .where("expiresAt", "<=", firebase.firestore.Timestamp.now()).get();
      if (q.empty) return;
      const batch = fbDb.batch();
      q.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    } catch (e) {}
  }

  /* ---------------- Voice calls (WebRTC, signaled through Firestore) ----------------
     The call itself only runs while the app is open; when it's closed, the
     push Worker sends a ringing notification (sw.js) and tapping it opens
     the app, which picks up the still-ringing call. Only STUN is configured (free public
     servers) — there's no TURN relay, so calls between two very restrictive
     NATs (e.g. some mobile carriers) may fail to connect; that would need a
     paid TURN service to fix. */

  const ICE_SERVERS = { iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ] };
  const CALL_RING_TIMEOUT_MS = 45000;

  const callScreen = document.getElementById("call-screen");
  const callNicknameEl = document.getElementById("call-nickname");
  const callStatusEl = document.getElementById("call-status");
  const callTimerEl = document.getElementById("call-timer");
  const callErrorEl = document.getElementById("call-error");
  const callActionsIncoming = document.getElementById("call-actions-incoming");
  const callActionsActive = document.getElementById("call-actions-active");
  const callActionsOutgoing = document.getElementById("call-actions-outgoing");
  const callMuteBtn = document.getElementById("call-mute-btn");
  const callSpeakerBtn = document.getElementById("call-speaker-btn");
  const callCameraBtn = document.getElementById("call-camera-btn");
  const callAvatarEl = document.getElementById("call-avatar");
  const callRemoteVideo = document.getElementById("call-remote-video");
  const callLocalVideo = document.getElementById("call-local-video");
  const threadCallBtn = document.getElementById("thread-call-btn");
  const threadVideoCallBtn = document.getElementById("thread-video-call-btn");
  let isVideoCall = false;
  let isCameraOff = false;
  const SINK_ID_SUPPORTED = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  let isSpeakerOn = false;
  let speakerSinkId = null; // resolved lazily from enumerateDevices, once we have mic permission labels
  let earpieceSinkId = null;

  let activeCallId = null;
  let activeCallRole = null; // "caller" or "callee"
  let peerConnection = null;
  let localStream = null;
  let remoteAudioEl = null;
  let callDocUnsub = null;
  let remoteCandidatesUnsub = null;
  let incomingCallsUnsub = null;
  let currentIncomingCall = null; // { id, data }
  let incomingCallDocUnsub = null;
  let callTimerInterval = null;
  let callStartedAt = null;
  let isMuted = false;
  let ringToneTimer = null;
  let ringToneCtx = null;
  let callTimeoutTimer = null;
  let callRingPushTimer = null; // re-pushes while ringing, since a web notification can't loop a ringtone
  // Only the caller logs a call-history entry into the conversation (once,
  // when the call reaches a terminal state), so these track what's needed
  // to write it regardless of whether the user has navigated away from the
  // conversation mid-call.
  let callLogConvId = null;
  let callLogOtherUid = null;
  let callLogOtherNickname = null;
  let callWasConnected = false;

  async function logCallToConversation(convId, otherUid, outcome, durationSec, media) {
    try {
      // sendEncryptedTo takes a list of recipients (group chat support).
      await sendEncryptedTo(convId, [otherUid], JSON.stringify({ outcome, duration: durationSec, media }), "call");
    } catch (e) {}
  }

  const CALL_END_MESSAGES = {
    REJECTED: "Arama reddedildi.",
    TIMEOUT: "Yanıt yok.",
    CANCELED: "İptal edildi.",
    ENDED_BY_OTHER: "Karşı taraf kapattı.",
    ENDED: "Arama sona erdi.",
    DISCONNECTED: "Bağlantı kesildi.",
    FAILED: "Bağlantı kurulamadı.",
  };

  function resetCallUi() {
    callSecurityEl.classList.add("hidden");
    callActionsIncoming.classList.add("hidden");
    callActionsActive.classList.add("hidden");
    callActionsOutgoing.classList.add("hidden");
    callTimerEl.classList.add("hidden");
    callErrorEl.textContent = "";
  }

  function applyCallVideoUi() {
    callScreen.classList.toggle("video-active", isVideoCall);
    callAvatarEl.classList.toggle("hidden", isVideoCall);
    callRemoteVideo.classList.toggle("hidden", !isVideoCall);
    callLocalVideo.classList.toggle("hidden", !isVideoCall);
    callCameraBtn.classList.toggle("hidden", !isVideoCall);
    if (isVideoCall && localStream) {
      callLocalVideo.srcObject = localStream;
    }
  }

  /* ---- Incoming calls look like a ringing alarm: big clock, "Durdur"
     (answers) and "Ertele" (declines); unanswered ones turn into a
     "Kaçırılan alarm". The caller's nickname is shown as the alarm's label. */

  const alarmFaceEl = document.getElementById("alarm-face");
  const alarmClockEl = document.getElementById("alarm-clock");
  const alarmDateEl = document.getElementById("alarm-date");
  const alarmSubEl = document.getElementById("alarm-sub");
  const callAcceptBtn = document.getElementById("call-accept-btn");
  const callRejectBtn = document.getElementById("call-reject-btn");
  let alarmClockTimer = null;

  function alarmTimeText(d) {
    return d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  }

  function tickAlarmClock() {
    const now = new Date();
    alarmClockEl.textContent = alarmTimeText(now);
    alarmDateEl.textContent = now.toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
  }

  function enterAlarmMode(label) {
    callScreen.classList.add("alarm-mode");
    alarmFaceEl.classList.remove("hidden");
    alarmSubEl.classList.remove("missed");
    alarmSubEl.textContent = label;
    callAcceptBtn.textContent = "Durdur";
    callRejectBtn.textContent = "Ertele";
    tickAlarmClock();
    clearInterval(alarmClockTimer);
    alarmClockTimer = setInterval(tickAlarmClock, 1000);
  }

  function exitAlarmMode() {
    clearInterval(alarmClockTimer);
    alarmClockTimer = null;
    callScreen.classList.remove("alarm-mode");
    alarmFaceEl.classList.add("hidden");
    callAcceptBtn.textContent = "Kabul Et";
    callRejectBtn.textContent = "Reddet";
  }

  function showMissedAlarm() {
    const timeText = alarmTimeText(new Date());
    clearInterval(alarmClockTimer);
    alarmClockTimer = null;
    alarmSubEl.textContent = "Kaçırılan alarm";
    alarmSubEl.classList.add("missed");
    // Leave it in the notification shade too (same tag as the background push, so they merge).
    if ("serviceWorker" in navigator && "Notification" in window && Notification.permission === "granted") {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (reg) {
          reg.showNotification("Kaçırılan alarm", {
            body: timeText, tag: "calcut-call", icon: "icons/alarm-192.png", badge: "icons/alarm-badge-96.png",
          });
        }
      }).catch(() => {});
    }
  }

  function showIncomingCallUi(data, callId) {
    isVideoCall = data.media === "video";
    applyCallVideoUi();
    callScreen.classList.remove("hidden");
    resetCallUi();
    callNicknameEl.textContent = "@" + (data.fromNickname || "?");
    callStatusEl.textContent = isVideoCall ? "Gelen görüntülü arama..." : "Gelen arama...";
    enterAlarmMode(data.fromNickname || "");
    callActionsIncoming.classList.remove("hidden");
    playRingtone();
    if (navigator.vibrate) {
      try { navigator.vibrate([400, 200, 400, 200, 400]); } catch (e) {}
    }
    // The callee has no listener on this specific call doc yet (that only
    // starts on accept), so without this, if the caller cancels or times out
    // while it's still ringing, this screen would stay stuck forever.
    if (incomingCallDocUnsub) incomingCallDocUnsub();
    incomingCallDocUnsub = fbDb.collection("calls").doc(callId).onSnapshot(snap => {
      const d = snap.data();
      if (!d || !currentIncomingCall || currentIncomingCall.id !== callId) return;
      if (d.status === "ended") {
        stopRingtone();
        currentIncomingCall = null;
        resetCallUi();
        callStatusEl.textContent = "Arayan aramayı sonlandırdı.";
        showMissedAlarm();
        setTimeout(hideCallScreen, 3000);
      }
    }, () => {});
  }

  function showOutgoingCallUi(nickname) {
    applyCallVideoUi();
    callScreen.classList.remove("hidden");
    resetCallUi();
    callNicknameEl.textContent = "@" + nickname;
    callStatusEl.textContent = isVideoCall ? "Görüntülü arıyor..." : "Aranıyor...";
    callActionsOutgoing.classList.remove("hidden");
  }

  /* ---- Call security code. Voice/video is DTLS-SRTP encrypted end to end,
     but the keys' fingerprints travel in the SDP through Firestore, so someone
     able to rewrite the call doc could sit in the middle. Both sides derive 4
     emoji from the two fingerprints (sorted, so both get the same code); if
     the people on the call read out matching codes, nobody is in between. */
  const SECURITY_EMOJI = [
    "🐶", "🐱", "🐭", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧",
    "🐦", "🦆", "🦉", "🐴", "🦄", "🐝", "🦋", "🐌", "🐢", "🐙", "🐬", "🐳", "🦀", "🐠", "🌵", "🌲",
    "🌻", "🌹", "🍄", "🌙", "⭐", "🔥", "🌈", "❄️", "🍎", "🍋", "🍉", "🍇", "🍓", "🍒", "🥕", "🌽",
    "🍕", "🍩", "🎂", "☕", "⚽", "🏀", "🎸", "🎲", "🚗", "🚲", "✈️", "🚀", "⛵", "🏠", "🔑", "🎁",
  ];
  const callSecurityEl = document.getElementById("call-security");
  const callSecurityCodeEl = document.getElementById("call-security-code");

  function sdpFingerprint(sdp) {
    const m = /a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/.exec(sdp || "");
    return m ? (m[1] + " " + m[2]).toUpperCase() : null;
  }

  async function showCallSecurityCode(pc) {
    callSecurityEl.classList.add("hidden");
    if (!pc || !pc.localDescription || !pc.remoteDescription || !crypto.subtle) return;
    const a = sdpFingerprint(pc.localDescription.sdp);
    const b = sdpFingerprint(pc.remoteDescription.sdp);
    if (!a || !b) return;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode([a, b].sort().join("|"))));
    if (pc !== peerConnection) return; // call ended meanwhile
    callSecurityCodeEl.textContent = Array.from(digest.slice(0, 4)).map(x => SECURITY_EMOJI[x % 64]).join(" ");
    callSecurityEl.classList.remove("hidden");
  }

  function showActiveCallUi(nickname) {
    exitAlarmMode();
    applyCallVideoUi();
    resetCallUi();
    callWasConnected = true;
    callNicknameEl.textContent = "@" + nickname;
    callStatusEl.textContent = "Görüşmede";
    callActionsActive.classList.remove("hidden");
    callTimerEl.classList.remove("hidden");
    callTimerEl.textContent = "00:00";
    isMuted = false;
    callMuteBtn.classList.remove("active");
    callMuteBtn.textContent = "Sessize Al";
    isCameraOff = false;
    callCameraBtn.classList.remove("active");
    callCameraBtn.textContent = "Kamerayı Kapat";
    if (isVideoCall) {
      callSpeakerBtn.classList.add("hidden");
    } else {
      resetAudioRouting();
    }
    showCallSecurityCode(peerConnection).catch(() => {});
    callStartedAt = Date.now();
    clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - callStartedAt) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, "0");
      const ss = String(secs % 60).padStart(2, "0");
      callTimerEl.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function hideCallScreen() {
    callScreen.classList.add("hidden");
    exitAlarmMode();
  }

  // Incoming-call ring: repeats the sound chosen in Settings ("Arama alarmı").
  function playRingtone() {
    stopRingtone();
    const preset = SOUND_PRESETS[getSoundPref("call")];
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      ringToneCtx = new Ctx();
      const ring = () => {
        if (!ringToneCtx) return 0;
        return preset.play(ringToneCtx, ringToneCtx.currentTime);
      };
      const len = ring();
      if (len > 0) ringToneTimer = setInterval(ring, Math.max(1.6, len + 0.6) * 1000);
    } catch (e) {}
  }

  function stopRingtone() {
    if (ringToneTimer) { clearInterval(ringToneTimer); ringToneTimer = null; }
    if (ringToneCtx) { ringToneCtx.close().catch(() => {}); ringToneCtx = null; }
  }

  async function getMic(withVideo) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: withVideo ? { facingMode: "user" } : false,
      });
    } catch (e) {
      throw new Error(withVideo
        ? "Kamera/mikrofon erişimi reddedildi veya kullanılamıyor."
        : "Mikrofon erişimi reddedildi veya kullanılamıyor.");
    }
  }

  function createPeerConnection(callId, role, docAlreadyExists) {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    const candidatesCollection = role === "caller" ? "callerCandidates" : "calleeCandidates";
    const pendingCandidates = [];
    let docReady = !!docAlreadyExists;
    pc._flushCandidates = () => {
      docReady = true;
      pendingCandidates.forEach(c => {
        fbDb.collection("calls").doc(callId).collection(candidatesCollection).add(c).catch(() => {});
      });
      pendingCandidates.length = 0;
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const c = event.candidate.toJSON();
      if (docReady) {
        fbDb.collection("calls").doc(callId).collection(candidatesCollection).add(c).catch(() => {});
      } else {
        pendingCandidates.push(c);
      }
    };
    pc.ontrack = (event) => {
      if (isVideoCall) {
        callRemoteVideo.srcObject = event.streams[0];
      } else {
        if (!remoteAudioEl) {
          remoteAudioEl = document.createElement("audio");
          remoteAudioEl.autoplay = true;
          document.body.appendChild(remoteAudioEl);
        }
        remoteAudioEl.srcObject = event.streams[0];
        // The WebView may pick its own output once remote audio starts, so
        // re-apply the chosen route in the Android app.
        const nativeRoute = nativeAudioRoute();
        if (nativeRoute) {
          setTimeout(() => {
            if (pc === peerConnection) nativeRoute.setSpeaker({ on: isSpeakerOn }).catch(() => {});
          }, 500);
        }
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc === peerConnection && (pc.connectionState === "failed" || pc.connectionState === "disconnected")) {
        endCall("DISCONNECTED");
      }
    };
    return pc;
  }

  function listenToCallDoc(callId) {
    if (callDocUnsub) callDocUnsub();
    callDocUnsub = fbDb.collection("calls").doc(callId).onSnapshot(async snap => {
      const data = snap.data();
      if (!data || callId !== activeCallId) return;
      if (activeCallRole === "caller" && data.status === "accepted" && data.answer &&
          peerConnection && !peerConnection.currentRemoteDescription) {
        clearTimeout(callTimeoutTimer);
        clearInterval(callRingPushTimer);
        callRingPushTimer = null;
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
          showActiveCallUi(data.toNickname);
        } catch (e) {
          endCall("FAILED");
        }
      }
      if (data.status === "rejected" && activeCallRole === "caller") {
        endCall("REJECTED");
      }
      if (data.status === "ended") {
        // My own hangUpCall()/cancelOutgoingCall() already nulled
        // activeCallId before this echoes back, so reaching here always
        // means the OTHER side ended it.
        endCall("ENDED_BY_OTHER");
      }
    }, () => {});
  }

  function listenToRemoteCandidates(callId, collectionName) {
    if (remoteCandidatesUnsub) remoteCandidatesUnsub();
    remoteCandidatesUnsub = fbDb.collection("calls").doc(callId).collection(collectionName)
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          if (change.type === "added" && peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
          }
        });
      }, () => {});
  }

  async function startCall(otherUid, otherNickname, withVideo) {
    if (!otherUid || activeCallId) return;
    if (myBlocked[otherUid]) { alert("Bu kullanıcıyı engellediniz."); return; }
    if (!("mediaDevices" in navigator)) { alert("Bu tarayıcı aramayı desteklemiyor."); return; }
    isVideoCall = !!withVideo;
    try {
      localStream = await getMic(isVideoCall);
    } catch (e) {
      alert(e.message);
      return;
    }
    activeCallRole = "caller";
    callWasConnected = false;
    callLogConvId = convIdFor(myUid, otherUid);
    callLogOtherUid = otherUid;
    callLogOtherNickname = otherNickname;
    showOutgoingCallUi(otherNickname);
    try {
      const callDocRef = fbDb.collection("calls").doc();
      activeCallId = callDocRef.id;

      peerConnection = createPeerConnection(activeCallId, "caller", false);
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      await callDocRef.set({
        from: myUid,
        fromNickname: myNickname,
        to: otherUid,
        toNickname: otherNickname,
        status: "ringing",
        media: isVideoCall ? "video" : "audio",
        offer: { type: offer.type, sdp: offer.sdp },
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      peerConnection._flushCandidates();

      listenToCallDoc(activeCallId);
      listenToRemoteCandidates(activeCallId, "calleeCandidates");

      requestPush({ kind: "call", callId: callDocRef.id });
      callRingPushTimer = setInterval(() => {
        if (activeCallId !== callDocRef.id || callWasConnected) {
          clearInterval(callRingPushTimer);
          callRingPushTimer = null;
          return;
        }
        requestPush({ kind: "call", callId: callDocRef.id });
      }, 8000);

      callTimeoutTimer = setTimeout(() => {
        if (activeCallId === callDocRef.id && activeCallRole === "caller") {
          fbDb.collection("calls").doc(callDocRef.id).update({ status: "ended" })
            .then(() => requestPush({ kind: "call-missed", callId: callDocRef.id }))
            .catch(() => {});
          endCall("TIMEOUT");
        }
      }, CALL_RING_TIMEOUT_MS);
    } catch (e) {
      callErrorEl.textContent = "Arama başlatılamadı: " + e.message;
      endCall("FAILED");
    }
  }

  async function acceptIncomingCall() {
    if (!currentIncomingCall) return;
    stopRingtone();
    closeCallNotifications();
    if (incomingCallDocUnsub) { incomingCallDocUnsub(); incomingCallDocUnsub = null; }
    const { id, data } = currentIncomingCall;
    currentIncomingCall = null;
    isVideoCall = data.media === "video";
    try {
      localStream = await getMic(isVideoCall);
    } catch (e) {
      callErrorEl.textContent = e.message;
      fbDb.collection("calls").doc(id).update({ status: "rejected" }).catch(() => {});
      setTimeout(hideCallScreen, 1500);
      return;
    }
    activeCallId = id;
    activeCallRole = "callee";
    try {
      peerConnection = createPeerConnection(id, "callee", true);
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      await fbDb.collection("calls").doc(id).update({
        status: "accepted",
        answer: { type: answer.type, sdp: answer.sdp },
      });

      listenToCallDoc(id);
      listenToRemoteCandidates(id, "callerCandidates");
      showActiveCallUi(data.fromNickname);
    } catch (e) {
      callErrorEl.textContent = "Bağlantı kurulamadı: " + e.message;
      endCall("FAILED");
    }
  }

  function rejectIncomingCall() {
    if (!currentIncomingCall) return;
    stopRingtone();
    closeCallNotifications();
    if (incomingCallDocUnsub) { incomingCallDocUnsub(); incomingCallDocUnsub = null; }
    fbDb.collection("calls").doc(currentIncomingCall.id).update({ status: "rejected" }).catch(() => {});
    currentIncomingCall = null;
    hideCallScreen();
  }

  function cancelOutgoingCall() {
    if (activeCallId && activeCallRole === "caller") {
      const callId = activeCallId;
      fbDb.collection("calls").doc(callId).update({ status: "ended" })
        .then(() => requestPush({ kind: "call-missed", callId }))
        .catch(() => {});
    }
    endCall("CANCELED");
  }

  function hangUpCall() {
    if (activeCallId) {
      fbDb.collection("calls").doc(activeCallId).update({ status: "ended" }).catch(() => {});
    }
    endCall("ENDED");
  }

  function endCall(code) {
    clearTimeout(callTimeoutTimer);
    clearInterval(callRingPushTimer);
    callRingPushTimer = null;
    clearInterval(callTimerInterval);
    callTimerInterval = null;
    stopRingtone();
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (remoteAudioEl) { remoteAudioEl.srcObject = null; }
    callRemoteVideo.srcObject = null;
    callLocalVideo.srcObject = null;
    if (callDocUnsub) { callDocUnsub(); callDocUnsub = null; }
    if (remoteCandidatesUnsub) { remoteCandidatesUnsub(); remoteCandidatesUnsub = null; }
    isSpeakerOn = false;
    callSpeakerBtn.classList.remove("active");
    callSpeakerBtn.textContent = "Hoparlör";
    const nativeRoute = nativeAudioRoute();
    if (nativeRoute) nativeRoute.endCall().catch(() => {});

    const role = activeCallRole;
    const wasVideo = isVideoCall;
    const durationSec = callWasConnected && callStartedAt ? Math.max(0, Math.round((Date.now() - callStartedAt) / 1000)) : 0;
    if (role === "caller" && callLogConvId && callLogOtherUid) {
      let outcome = null;
      if (callWasConnected) outcome = "completed";
      else if (code === "REJECTED") outcome = "rejected";
      else if (code === "TIMEOUT") outcome = "missed";
      else if (code === "CANCELED") outcome = "canceled";
      if (outcome) {
        logCallToConversation(callLogConvId, callLogOtherUid, outcome, durationSec, wasVideo ? "video" : "audio").catch(() => {});
      }
    }

    activeCallId = null;
    activeCallRole = null;
    callLogConvId = null;
    callLogOtherUid = null;
    callLogOtherNickname = null;
    callWasConnected = false;
    isMuted = false;
    isVideoCall = false;
    isCameraOff = false;
    callScreen.classList.remove("video-active");
    callAvatarEl.classList.remove("hidden");
    callRemoteVideo.classList.add("hidden");
    callLocalVideo.classList.add("hidden");
    callCameraBtn.classList.add("hidden");
    if (code && CALL_END_MESSAGES[code]) {
      resetCallUi();
      callStatusEl.textContent = CALL_END_MESSAGES[code];
      setTimeout(hideCallScreen, 1500);
    } else {
      hideCallScreen();
    }
  }

  /* Incoming calls ring and can be answered ("Durdur") as soon as the app is
     open, even on the calculator screen while the vault is locked: no 1923=+
     gesture or PIN. Answering only needs the signed-in Firebase account (kept
     on the device by Firebase), not the message keys, so messages stay locked.
     The listener follows the sign-in state rather than the vault. */
  let incomingCallsUid = null;

  function listenForIncomingCalls(uid) {
    uid = uid || myUid || (fbAuth.currentUser && fbAuth.currentUser.uid);
    if (!uid) return;
    if (incomingCallsUnsub && incomingCallsUid === uid) return; // already listening
    if (incomingCallsUnsub) incomingCallsUnsub();
    incomingCallsUid = uid;
    if (!myPrivateKey) {
      // Locked: the blocked list normally comes with the unlocked session.
      fbDb.collection("users").doc(uid).get().then(doc => {
        const data = doc.data();
        if (data && !myPrivateKey) myBlocked = data.blocked || {};
      }).catch(() => {});
    }
    incomingCallsUnsub = fbDb.collection("calls")
      .where("to", "==", uid)
      .where("status", "==", "ringing")
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          if (change.type !== "added") return;
          const data = change.doc.data();
          if (activeCallId || currentIncomingCall) return; // already busy
          if (myBlocked[data.from]) return;
          const createdMs = data.createdAt ? data.createdAt.toMillis() : Date.now();
          if (Date.now() - createdMs > CALL_RING_TIMEOUT_MS + 5000) return; // stale
          currentIncomingCall = { id: change.doc.id, data };
          showIncomingCallUi(data, change.doc.id);
        });
      }, () => {});
  }

  fbAuth.onAuthStateChanged(user => {
    if (user) listenForIncomingCalls(user.uid);
    else stopListeningForIncomingCalls();
  });

  function stopListeningForIncomingCalls() {
    if (incomingCallsUnsub) { incomingCallsUnsub(); incomingCallsUnsub = null; }
    incomingCallsUid = null;
    if (incomingCallDocUnsub) { incomingCallDocUnsub(); incomingCallDocUnsub = null; }
    currentIncomingCall = null;
  }

  threadCallBtn.addEventListener("click", () => {
    if (!activeOtherUid || !activeConvId) return;
    const conv = conversations.get(activeConvId);
    startCall(activeOtherUid, conv ? conv.otherNickname : "?", false);
  });
  threadVideoCallBtn.addEventListener("click", () => {
    if (!activeOtherUid || !activeConvId) return;
    const conv = conversations.get(activeConvId);
    startCall(activeOtherUid, conv ? conv.otherNickname : "?", true);
  });
  document.getElementById("call-accept-btn").addEventListener("click", acceptIncomingCall);
  document.getElementById("call-reject-btn").addEventListener("click", rejectIncomingCall);
  document.getElementById("call-cancel-btn").addEventListener("click", cancelOutgoingCall);
  document.getElementById("call-hangup-btn").addEventListener("click", hangUpCall);
  callMuteBtn.addEventListener("click", () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
    callMuteBtn.classList.toggle("active", isMuted);
    callMuteBtn.textContent = isMuted ? "Sesi Aç" : "Sessize Al";
  });
  callCameraBtn.addEventListener("click", () => {
    if (!localStream) return;
    const videoTracks = localStream.getVideoTracks();
    if (!videoTracks.length) return;
    isCameraOff = !isCameraOff;
    videoTracks.forEach(t => { t.enabled = !isCameraOff; });
    callCameraBtn.classList.toggle("active", isCameraOff);
    callCameraBtn.textContent = isCameraOff ? "Kamerayı Aç" : "Kamerayı Kapat";
  });

  /* ---------------- Speaker / earpiece output routing ----------------
     A real web-platform limitation: there is no API to say "start this
     call on the earpiece" the way native phone apps can — setSinkId() only
     lets us pick among the audio OUTPUT devices the OS already exposes
     (and iOS Safari doesn't support it at all). On phones that do expose a
     distinct "Speakerphone" device, this lets people switch to it and back
     to the default (which is normally the earpiece on a phone call) —
     that's the most a web page can control. */

  async function findAudioOutputRoutes() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return { speakerId: null, earpieceId: null };
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === "audiooutput");
      const speaker = outputs.find(d => /speaker/i.test(d.label));
      // Naming varies by OEM/Chrome version: some devices expose a distinct
      // earpiece output as "Earpiece", "Receiver", "Handset", or "Phone".
      const earpiece = outputs.find(d => /earpiece|receiver|handset/i.test(d.label));
      return { speakerId: speaker ? speaker.deviceId : null, earpieceId: earpiece ? earpiece.deviceId : null };
    } catch (e) {
      return { speakerId: null, earpieceId: null };
    }
  }

  async function applySinkId(sinkId) {
    if (!remoteAudioEl || !SINK_ID_SUPPORTED) return false;
    try {
      await remoteAudioEl.setSinkId(sinkId || "");
      return true;
    } catch (e) {
      return false;
    }
  }

  // In the Android app (native/), a native plugin can do what the web page
  // can't: put the call in communication mode and pick the earpiece.
  function nativeAudioRoute() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.AudioRoute) || null;
  }

  async function resetAudioRouting() {
    isSpeakerOn = false;
    callSpeakerBtn.classList.remove("active");
    callSpeakerBtn.textContent = "Hoparlör";
    const nativeRoute = nativeAudioRoute();
    if (nativeRoute) {
      callSpeakerBtn.classList.remove("hidden");
      await nativeRoute.startCall({ speaker: false }).catch(() => {});
      return;
    }
    callSpeakerBtn.classList.toggle("hidden", !SINK_ID_SUPPORTED);
    if (SINK_ID_SUPPORTED) {
      const routes = await findAudioOutputRoutes();
      speakerSinkId = routes.speakerId;
      earpieceSinkId = routes.earpieceId;
      // Prefer an explicit earpiece device if the OS exposes one as its own
      // selectable output; otherwise fall back to the default output (on
      // phones without a distinct earpiece entry, that's usually still the
      // earpiece for a fresh audio session — but Android doesn't give web
      // pages any way to request "phone call" audio mode, so if Chrome
      // already decided to route new audio to the speaker, this can't
      // force it back to the earpiece).
      await applySinkId(earpieceSinkId || "");
    }
  }

  callSpeakerBtn.addEventListener("click", async () => {
    const nativeRoute = nativeAudioRoute();
    if (nativeRoute) {
      const res = await nativeRoute.setSpeaker({ on: !isSpeakerOn }).catch(() => null);
      if (!res || !res.ok) {
        callErrorEl.textContent = "Ses çıkışı değiştirilemedi" + (res ? " (" + res.device + ")" : "") + ".";
        return;
      }
      isSpeakerOn = !isSpeakerOn;
      callSpeakerBtn.classList.toggle("active", isSpeakerOn);
      callSpeakerBtn.textContent = isSpeakerOn ? "Kulaklık" : "Hoparlör";
      return;
    }
    if (!SINK_ID_SUPPORTED) return;
    isSpeakerOn = !isSpeakerOn;
    const ok = await applySinkId(isSpeakerOn ? (speakerSinkId || "") : (earpieceSinkId || ""));
    if (!ok) {
      isSpeakerOn = !isSpeakerOn; // revert, nothing actually changed
      callErrorEl.textContent = "Ses çıkışı değiştirilemedi.";
      return;
    }
    callSpeakerBtn.classList.toggle("active", isSpeakerOn);
    callSpeakerBtn.textContent = isSpeakerOn ? "Kulaklık" : "Hoparlör";
  });

  /* ---------------- Typing indicator ---------------- */

  const threadTypingEl = document.getElementById("thread-typing");
  const TYPING_STALE_MS = 4000; // how long since the other side's last keystroke before we hide "yazıyor..."
  const TYPING_WRITE_THROTTLE_MS = 2000; // how often we write our own typing timestamp
  let typingUnsub = null;
  let typingCheckInterval = null;
  let lastTypingWriteAt = 0;

  function listenToTyping(convId, otherUid) {
    if (typingUnsub) typingUnsub();
    if (typingCheckInterval) clearInterval(typingCheckInterval);
    threadTypingEl.classList.add("hidden");

    function refreshFromSnapshot(snap) {
      const d = snap.data();
      const ts = d && d.typing && d.typing[otherUid];
      const millis = ts && ts.toMillis ? ts.toMillis() : 0;
      const isTyping = millis > 0 && (Date.now() - millis) < TYPING_STALE_MS;
      threadTypingEl.classList.toggle("hidden", !isTyping);
    }

    typingUnsub = fbDb.collection("conversations").doc(convId)
      .onSnapshot(refreshFromSnapshot, () => {});
    // The timestamp doesn't push a new update once it goes stale, so also
    // re-check locally on an interval to hide the indicator on time.
    typingCheckInterval = setInterval(() => {
      fbDb.collection("conversations").doc(convId).get().then(refreshFromSnapshot).catch(() => {});
    }, 1500);
  }

  function stopTypingListener() {
    if (typingUnsub) { typingUnsub(); typingUnsub = null; }
    if (typingCheckInterval) { clearInterval(typingCheckInterval); typingCheckInterval = null; }
    threadTypingEl.classList.add("hidden");
  }

  function notifyTyping() {
    if (!activeConvId || activeIsGroup) return;
    const now = Date.now();
    if (now - lastTypingWriteAt < TYPING_WRITE_THROTTLE_MS) return;
    lastTypingWriteAt = now;
    fbDb.collection("conversations").doc(activeConvId).update({
      [`typing.${myUid}`]: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  let disappearingCheckInterval = null;

  function listenToMessages(convId) {
    if (messagesUnsub) messagesUnsub();
    if (disappearingCheckInterval) { clearInterval(disappearingCheckInterval); disappearingCheckInterval = null; }
    messageListEl.innerHTML = "";
    messagesUnsub = fbDb.collection("conversations").doc(convId).collection("messages")
      .orderBy("ts")
      .onSnapshot(async snap => {
        fbDb.collection("conversations").doc(convId).update({ [`unreadCount.${myUid}`]: 0 }).catch(() => {});
        const conv = conversations.get(convId);
        const rendered = [];
        const now = Date.now();
        for (const doc of snap.docs) {
          const d = doc.data();
          const expiresAtMillis = d.expiresAt ? d.expiresAt.toMillis() : null;
          if (expiresAtMillis && expiresAtMillis <= now) continue; // already expired: hide, will be purged shortly
          const fromNickname = activeIsGroup && conv ? (conv.participantNicknames[d.from] || "?") : null;
          if (d.deleted) {
            rendered.push({
              id: doc.id, type: d.type, from: d.from === myUid ? "me" : "them", fromNickname,
              deleted: true, text: null, image: null, file: null, call: null,
              ts: d.ts ? d.ts.toMillis() : Date.now(), read: !!d.read, expiresAtMillis,
            });
            continue;
          }
          const plain = await decryptMessage(d).catch(() => "[çözülemedi]");
          // The conversation is open right now, so any message from someone
          // else is by definition being read as it arrives. Group threads
          // don't track per-member read receipts (see the tick rendering
          // below), so only bother writing this for 1:1 threads.
          if (!activeIsGroup && d.from !== myUid && !d.read) {
            doc.ref.update({ read: true }).catch(() => {});
          }
          let file = null;
          if (d.type === "file") {
            try { file = JSON.parse(plain); } catch (e) { file = null; }
          }
          let call = null;
          if (d.type === "call") {
            try { call = JSON.parse(plain); } catch (e) { call = null; }
          }
          rendered.push({
            id: doc.id,
            type: d.type,
            from: d.from === myUid ? "me" : "them",
            fromNickname,
            text: (d.type === "image" || d.type === "file" || d.type === "call") ? null : plain,
            image: d.type === "image" ? plain : null,
            file,
            call,
            ts: d.ts ? d.ts.toMillis() : Date.now(),
            read: !!d.read,
            expiresAtMillis,
            chunked: d.chunked || null,
            deleted: false,
            edited: !!d.edited,
            reactions: d.reactions || {},
          });
        }
        currentMessages = rendered;
        renderMessages(rendered);
      }, err => console.error("messages listen error", err));

    pruneExpiredMessages(convId);
    // Disappearing messages expire purely by wall-clock time, so a periodic
    // check (rather than only re-running on Firestore snapshot changes) is
    // needed to hide/purge them right on schedule while the thread is open.
    disappearingCheckInterval = setInterval(() => {
      if (currentMessages.some(m => m.expiresAtMillis && m.expiresAtMillis <= Date.now())) {
        renderMessages(currentMessages);
      }
      pruneExpiredMessages(convId);
    }, 3000);
  }

  /* ---------------- In-conversation search ---------------- */

  const threadSearchBtn = document.getElementById("thread-search-btn");
  const threadSearchBar = document.getElementById("thread-search-bar");
  const threadSearchInput = document.getElementById("thread-search-input");
  const threadSearchCount = document.getElementById("thread-search-count");
  let currentMessages = [];
  let searchQuery = "";

  function closeThreadSearch() {
    threadSearchBar.classList.add("hidden");
    threadSearchInput.value = "";
    searchQuery = "";
    threadSearchCount.textContent = "";
  }

  threadSearchBtn.addEventListener("click", () => {
    if (threadSearchBar.classList.contains("hidden")) {
      threadSearchBar.classList.remove("hidden");
      threadSearchInput.focus();
    } else {
      closeThreadSearch();
      renderMessages(currentMessages);
    }
  });
  threadSearchInput.addEventListener("input", () => {
    searchQuery = threadSearchInput.value;
    renderMessages(currentMessages);
  });

  function appendHighlightedText(container, text, query) {
    if (!query) {
      container.textContent = text;
      return;
    }
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let cursor = 0;
    let idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) {
      container.textContent = text;
      return;
    }
    while (idx !== -1) {
      container.appendChild(document.createTextNode(text.slice(cursor, idx)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(idx, idx + query.length);
      container.appendChild(mark);
      cursor = idx + query.length;
      idx = lowerText.indexOf(lowerQuery, cursor);
    }
    container.appendChild(document.createTextNode(text.slice(cursor)));
  }

  // Large ciphertexts (photos, files) don't fit Firestore's ~1MiB document
  // cap, so sendEncryptedTo splits them over chunk documents in the same
  // messages collection: { from, chunkOf, idx, data }, ids "<group>_<idx>".
  // Chunk documents have no "ts", so every ts-ordered query skips them; the
  // message itself carries chunked: { conv, id, n } instead of ciphertext.
  const CHUNK_CHARS = 700 * 1024;
  const chunkedPlainCache = new Map(); // chunk group id -> decrypted text

  function chunkRef(chunked, idx) {
    return fbDb.collection("conversations").doc(chunked.conv).collection("messages").doc(chunked.id + "_" + idx);
  }

  async function readChunkedCiphertext(chunked) {
    const parts = await Promise.all(
      Array.from({ length: chunked.n }, (_, i) => chunkRef(chunked, i).get())
    );
    if (parts.some(p => !p.exists)) throw new Error("missing chunk");
    return parts.map(p => p.data().data).join("");
  }

  async function deleteChunks(chunked) {
    if (!chunked) return;
    await Promise.all(Array.from({ length: chunked.n }, (_, i) => chunkRef(chunked, i).delete().catch(() => {})));
    chunkedPlainCache.delete(chunked.id);
  }

  async function decryptMessage(d) {
    if (d.chunked && chunkedPlainCache.has(d.chunked.id)) return chunkedPlainCache.get(d.chunked.id);
    const wrapped = d.wrappedKeys && d.wrappedKeys[myUid];
    if (!wrapped) throw new Error("no key for me");
    const rawAes = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, myPrivateKey, b64decode(wrapped));
    const aesKey = await crypto.subtle.importKey("raw", rawAes, { name: "AES-GCM" }, false, ["decrypt"]);
    const ciphertext = d.chunked ? await readChunkedCiphertext(d.chunked) : d.ciphertext;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64decode(d.iv)) },
      aesKey,
      b64decode(ciphertext)
    );
    const text = new TextDecoder().decode(plain);
    if (d.chunked) chunkedPlainCache.set(d.chunked.id, text);
    return text;
  }

  function renderMessages(msgs) {
    messageListEl.innerHTML = "";
    const query = searchQuery.trim();
    let matchCount = 0;
    msgs.forEach(m => {
      if (m.expiresAtMillis && m.expiresAtMillis <= Date.now()) return;
      if (query) {
        // Images, call log entries and deleted messages aren't searchable
        // (no text to match), so hide them while filtering; only text
        // messages containing the query are shown.
        if (m.deleted || m.image || !m.text || !m.text.toLowerCase().includes(query.toLowerCase())) return;
        matchCount++;
      }
      const time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (m.deleted) {
        const div = document.createElement("div");
        div.className = "msg-bubble " + m.from + " deleted";
        const span = document.createElement("span");
        span.className = "deleted-text";
        span.textContent = "Bu mesaj silindi";
        div.appendChild(span);
        const timeSpan = document.createElement("span");
        timeSpan.className = "msg-time";
        timeSpan.textContent = time;
        div.appendChild(timeSpan);
        messageListEl.appendChild(div);
        return;
      }
      if (m.call) {
        const callDiv = document.createElement("div");
        const missedOrRejected = isMissedIncomingCall(m.from === "me", m.call.outcome) || m.call.outcome === "rejected";
        callDiv.className = "msg-bubble call-log" + (missedOrRejected ? " call-missed" : "");
        const span = document.createElement("span");
        span.textContent = callLogText(m.from === "me", m.call.outcome, m.call.duration || 0, m.call.media);
        callDiv.appendChild(span);
        const timeSpan = document.createElement("span");
        timeSpan.className = "msg-time";
        timeSpan.textContent = time;
        callDiv.appendChild(timeSpan);
        messageListEl.appendChild(callDiv);
        return;
      }
      const div = document.createElement("div");
      div.className = "msg-bubble " + m.from;
      div.dataset.msgId = m.id;
      if (activeIsGroup && m.from === "them" && m.fromNickname) {
        const senderLabel = document.createElement("span");
        senderLabel.className = "msg-sender";
        senderLabel.textContent = "@" + m.fromNickname;
        div.appendChild(senderLabel);
      }
      if (m.image) {
        const img = document.createElement("img");
        img.src = m.image;
        div.appendChild(img);
      } else if (m.file) {
        const link = document.createElement("a");
        link.className = "file-attachment";
        link.href = m.file.dataUrl;
        link.download = m.file.name || "dosya";
        const icon = document.createElement("span");
        icon.className = "file-icon";
        icon.textContent = "📄";
        const info = document.createElement("span");
        info.className = "file-info";
        const nameSpan = document.createElement("span");
        nameSpan.className = "file-name";
        nameSpan.textContent = m.file.name || "Dosya";
        const sizeSpan = document.createElement("span");
        sizeSpan.className = "file-size";
        sizeSpan.textContent = m.file.size ? formatFileSize(m.file.size) : "";
        info.appendChild(nameSpan);
        info.appendChild(sizeSpan);
        link.appendChild(icon);
        link.appendChild(info);
        div.appendChild(link);
      } else {
        const span = document.createElement("span");
        span.className = "msg-text";
        appendHighlightedText(span, m.text, query);
        div.appendChild(span);
      }
      const metaRow = document.createElement("span");
      metaRow.className = "msg-meta";
      if (m.edited) {
        const editedSpan = document.createElement("span");
        editedSpan.className = "msg-edited";
        editedSpan.textContent = "düzenlendi";
        metaRow.appendChild(editedSpan);
      }
      const timeSpan = document.createElement("span");
      timeSpan.className = "msg-time";
      timeSpan.textContent = time;
      metaRow.appendChild(timeSpan);
      if (m.from === "me") {
        if (!activeIsGroup) {
          const tick = document.createElement("span");
          tick.className = "msg-tick" + (m.read ? " read" : "");
          tick.textContent = "✓✓";
          metaRow.appendChild(tick);
        }
        if (m.type === "text") {
          const editBtn = document.createElement("button");
          editBtn.className = "msg-action msg-edit-btn";
          editBtn.textContent = "✎";
          editBtn.dataset.msgId = m.id;
          metaRow.appendChild(editBtn);
        }
        const delBtn = document.createElement("button");
        delBtn.className = "msg-action msg-delete-btn";
        delBtn.textContent = "🗑";
        delBtn.dataset.msgId = m.id;
        metaRow.appendChild(delBtn);
      }
      const reactBtn = document.createElement("button");
      reactBtn.className = "msg-action msg-react-btn";
      reactBtn.textContent = "🙂";
      reactBtn.dataset.msgId = m.id;
      metaRow.appendChild(reactBtn);
      if (m.type === "text" || m.type === "image" || m.type === "file") {
        const fwdBtn = document.createElement("button");
        fwdBtn.className = "msg-action msg-forward-btn";
        fwdBtn.textContent = "➡️";
        fwdBtn.dataset.msgId = m.id;
        metaRow.appendChild(fwdBtn);
      }
      div.appendChild(metaRow);
      const reactionEntries = Object.entries(m.reactions || {});
      if (reactionEntries.length) {
        const row = document.createElement("div");
        row.className = "msg-reactions";
        const counts = {};
        reactionEntries.forEach(([, emoji]) => { counts[emoji] = (counts[emoji] || 0) + 1; });
        Object.entries(counts).forEach(([emoji, count]) => {
          const badge = document.createElement("span");
          const mine = m.reactions[myUid] === emoji;
          badge.className = "msg-reaction-badge" + (mine ? " mine" : "");
          badge.textContent = emoji + (count > 1 ? " " + count : "");
          badge.dataset.msgId = m.id;
          badge.dataset.emoji = emoji;
          row.appendChild(badge);
        });
        div.appendChild(row);
      }
      messageListEl.appendChild(div);
    });
    messageListEl.scrollTop = messageListEl.scrollHeight;
    if (query) {
      threadSearchCount.textContent = matchCount === 0 ? "Sonuç yok" : matchCount + " sonuç";
    }
  }

  /* ---------------- Message delete / edit (sender only) ---------------- */

  const reactionPicker = document.getElementById("reaction-picker");
  let reactionTargetMsgId = null;

  function hideReactionPicker() {
    reactionPicker.classList.add("hidden");
    reactionTargetMsgId = null;
  }

  async function setMyReaction(convId, msgId, emoji) {
    const msg = currentMessages.find(m => m.id === msgId);
    const current = msg && msg.reactions ? msg.reactions[myUid] : null;
    const field = `reactions.${myUid}`;
    try {
      await fbDb.collection("conversations").doc(convId).collection("messages").doc(msgId).update({
        [field]: current === emoji ? firebase.firestore.FieldValue.delete() : emoji,
      });
    } catch (e2) {
      alert("Tepki eklenemedi: " + e2.message);
    }
  }

  reactionPicker.querySelectorAll(".reaction-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      if (reactionTargetMsgId) setMyReaction(activeConvId, reactionTargetMsgId, btn.dataset.emoji);
      hideReactionPicker();
    });
  });
  document.addEventListener("click", (e) => {
    if (!reactionPicker.classList.contains("hidden") && !e.target.closest("#reaction-picker") && !e.target.closest(".msg-react-btn")) {
      hideReactionPicker();
    }
  });

  messageListEl.addEventListener("click", async (e) => {
    const reactBtn = e.target.closest(".msg-react-btn");
    if (reactBtn) {
      const rect = reactBtn.getBoundingClientRect();
      reactionTargetMsgId = reactBtn.dataset.msgId;
      reactionPicker.classList.remove("hidden");
      const pickerRect = reactionPicker.getBoundingClientRect();
      let left = rect.left - pickerRect.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - pickerRect.width - 8));
      reactionPicker.style.left = left + "px";
      reactionPicker.style.top = Math.max(8, rect.top - pickerRect.height - 8) + "px";
      return;
    }
    const badge = e.target.closest(".msg-reaction-badge");
    if (badge && badge.classList.contains("mine")) {
      await setMyReaction(activeConvId, badge.dataset.msgId, badge.dataset.emoji);
      return;
    }
    const fwdBtn = e.target.closest(".msg-forward-btn");
    if (fwdBtn) {
      openForwardModal(fwdBtn.dataset.msgId);
      return;
    }
    const delBtn = e.target.closest(".msg-delete-btn");
    if (delBtn) {
      if (!confirm("Bu mesaj silinsin mi? (Herkes için)")) return;
      try {
        await fbDb.collection("conversations").doc(activeConvId).collection("messages")
          .doc(delBtn.dataset.msgId).update({ deleted: true, deletedAt: firebase.firestore.FieldValue.serverTimestamp() });
        const deletedMsg = currentMessages.find(m => m.id === delBtn.dataset.msgId);
        if (deletedMsg) await deleteChunks(deletedMsg.chunked);
      } catch (e2) {
        alert("Silinemedi: " + e2.message);
      }
      return;
    }
    const editBtn = e.target.closest(".msg-edit-btn");
    if (editBtn) {
      const msg = currentMessages.find(m => m.id === editBtn.dataset.msgId);
      if (!msg) return;
      const newText = prompt("Mesajı düzenle:", msg.text || "");
      if (newText === null) return;
      const trimmed = newText.trim();
      if (!trimmed || trimmed === msg.text) return;
      try {
        await editMessage(activeConvId, activeOtherUids, editBtn.dataset.msgId, trimmed);
      } catch (e2) {
        alert("Düzenlenemedi: " + e2.message);
      }
    }
  });

  async function editMessage(convId, otherUids, msgId, newText) {
    const otherPublicKeys = await Promise.all(otherUids.map(u => getPublicKeyForUid(u)));
    if (otherPublicKeys.some(k => !k)) {
      alert("Bir alıcının açık anahtarı bulunamadı.");
      return;
    }
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const rawAes = await crypto.subtle.exportKey("raw", aesKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(newText)
    );
    const myWrapped = await wrapAesKeyForPublicKey(rawAes, myPublicKey);
    const wrappedKeys = { [myUid]: myWrapped };
    for (let i = 0; i < otherUids.length; i++) {
      wrappedKeys[otherUids[i]] = await wrapAesKeyForPublicKey(rawAes, otherPublicKeys[i]);
    }
    await fbDb.collection("conversations").doc(convId).collection("messages").doc(msgId).update({
      iv: b64encode(iv.buffer),
      ciphertext: b64encode(ciphertext),
      wrappedKeys,
      edited: true,
      editedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  /* ---------------- Message forwarding ---------------- */

  const forwardModal = document.getElementById("forward-modal");
  const forwardThreadList = document.getElementById("forward-thread-list");
  let forwardingMsgId = null;

  function openForwardModal(msgId) {
    forwardingMsgId = msgId;
    forwardThreadList.innerHTML = "";
    const list = Array.from(conversations.values());
    if (!list.length) {
      forwardThreadList.innerHTML = "<li class='empty-state'>İletilecek başka sohbet yok.</li>";
    } else {
      list.forEach(conv => {
        const li = document.createElement("li");
        li.textContent = conv.isGroup ? `👥 ${conv.groupName}` : "@" + conv.otherNickname;
        li.addEventListener("click", () => forwardMessageTo(conv.id));
        forwardThreadList.appendChild(li);
      });
    }
    forwardModal.classList.remove("hidden");
  }

  function closeForwardModal() {
    forwardModal.classList.add("hidden");
    forwardingMsgId = null;
  }

  document.getElementById("forward-cancel").addEventListener("click", closeForwardModal);

  async function forwardMessageTo(targetConvId) {
    const msg = currentMessages.find(m => m.id === forwardingMsgId);
    closeForwardModal();
    if (!msg) return;
    const targetConv = conversations.get(targetConvId);
    const otherUids = targetConv ? targetConv.otherUids : [];
    if (!otherUids.length) return;
    try {
      if (msg.type === "text") {
        await sendEncryptedTo(targetConvId, otherUids, msg.text, "text");
      } else if (msg.type === "image") {
        await sendEncryptedTo(targetConvId, otherUids, msg.image, "image");
      } else if (msg.type === "file") {
        await sendEncryptedTo(targetConvId, otherUids, JSON.stringify(msg.file), "file");
      }
    } catch (e) {
      alert("İletilemedi: " + e.message);
    }
  }

  async function wrapAesKeyForPublicKey(rawAesKey, publicKey) {
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey);
    return b64encode(wrapped);
  }

  async function sendEncrypted(payloadText, type) {
    // Capture these locally: the user may navigate away from the conversation
    // (clearing activeConvId/activeOtherUids) while this async send is still
    // in flight, and the write below must still target the right thread.
    return sendEncryptedTo(activeConvId, activeOtherUids, payloadText, type);
  }

  async function sendEncryptedTo(convId, otherUids, payloadText, type) {
    if (!convId || !otherUids || !otherUids.length) return;
    // Blocking only applies to 1:1 threads; groups don't expose a block UI.
    if (otherUids.length === 1 && myBlocked[otherUids[0]]) return;
    const otherPublicKeys = await Promise.all(otherUids.map(u => getPublicKeyForUid(u)));
    if (otherPublicKeys.some(k => !k)) {
      alert("Bir alıcının açık anahtarı bulunamadı.");
      return;
    }
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const rawAes = await crypto.subtle.exportKey("raw", aesKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(payloadText)
    );
    const myWrapped = await wrapAesKeyForPublicKey(rawAes, myPublicKey);
    const wrappedKeys = { [myUid]: myWrapped };
    for (let i = 0; i < otherUids.length; i++) {
      wrappedKeys[otherUids[i]] = await wrapAesKeyForPublicKey(rawAes, otherPublicKeys[i]);
    }

    const conv = conversations.get(convId);
    const disappearingSeconds = conv ? (conv.disappearingSeconds || 0) : 0;
    const expiresAt = disappearingSeconds > 0
      ? firebase.firestore.Timestamp.fromMillis(Date.now() + disappearingSeconds * 1000)
      : null;
    const messagesCol = fbDb.collection("conversations").doc(convId).collection("messages");
    const ciphertextB64 = b64encode(ciphertext);
    const msgData = {
      from: myUid,
      type,
      iv: b64encode(iv.buffer),
      wrappedKeys,
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      read: false,
    };
    if (expiresAt) msgData.expiresAt = expiresAt;
    if (ciphertextB64.length > CHUNK_CHARS) {
      // Chunks go first, so a reader never sees the message without them.
      const chunked = { conv: convId, id: messagesCol.doc().id, n: Math.ceil(ciphertextB64.length / CHUNK_CHARS) };
      // A batch is capped at 10MiB, so write a few chunks at a time.
      for (let i = 0; i < chunked.n; i += 4) {
        const batch = fbDb.batch();
        for (let j = i; j < Math.min(i + 4, chunked.n); j++) {
          const chunk = { from: myUid, chunkOf: chunked.id, idx: j, data: ciphertextB64.slice(j * CHUNK_CHARS, (j + 1) * CHUNK_CHARS) };
          if (expiresAt) chunk.expiresAt = expiresAt; // purged along with the message
          batch.set(chunkRef(chunked, j), chunk);
        }
        await batch.commit();
      }
      msgData.chunked = chunked;
    } else {
      msgData.ciphertext = ciphertextB64;
    }
    const msgRef = await messagesCol.add(msgData);
    if (type !== "call") requestPush({ kind: "message", convId, msgId: msgRef.id });
    const convUpdate = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    otherUids.forEach(u => { convUpdate[`unreadCount.${u}`] = firebase.firestore.FieldValue.increment(1); });
    await fbDb.collection("conversations").doc(convId).update(convUpdate);
  }

  document.getElementById("message-send-btn").addEventListener("click", sendMessage);
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });
  messageInput.addEventListener("input", notifyTyping);

  async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    messageInput.value = "";
    try {
      await sendEncrypted(text, "text");
    } catch (e) {
      alert("Mesaj gönderilemedi: " + e.message);
    }
  }

  attachPhotoBtn.addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files[0];
    photoInput.value = "";
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    // Large payloads are split over chunk documents (see CHUNK_CHARS), so
    // this only bounds upload time and storage; base64 and encryption make
    // the stored size about 1.8x the file.
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      alert(isImage ? "Fotoğraf çok büyük (maks 10MB)." : "Dosya çok büyük (maks 10MB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        if (isImage) {
          await sendEncrypted(reader.result, "image");
        } else {
          const payload = JSON.stringify({ name: file.name, mime: file.type, size: file.size, dataUrl: reader.result });
          await sendEncrypted(payload, "file");
        }
      } catch (e) {
        alert("Dosya gönderilemedi: " + e.message);
      }
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("thread-back-btn").addEventListener("click", () => {
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    stopTypingListener();
    closeThreadSearch();
    currentMessages = [];
    activeConvId = null;
    activeOtherUid = null;
    activeOtherUids = [];
    activeIsGroup = false;
    showThreadList();
  });

  document.getElementById("thread-delete-btn").addEventListener("click", async () => {
    if (!activeConvId) return;
    if (!confirm("Bu sohbetteki tüm mesajlar silinsin mi? (Karşı tarafta da silinir, kişi listende kalır)")) return;
    const convId = activeConvId;
    // Only the messages go; the conversation doc stays so the contact remains
    // in both people's lists and can be messaged again.
    try {
      const convRef = fbDb.collection("conversations").doc(convId);
      const msgsSnap = await convRef.collection("messages").get();
      // Firestore batches are capped at 500 writes.
      for (let i = 0; i < msgsSnap.docs.length; i += 450) {
        const batch = fbDb.batch();
        msgsSnap.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      const conv = conversations.get(convId);
      const convUpdate = {};
      ((conv && conv.participants) || [myUid]).forEach(u => { convUpdate[`unreadCount.${u}`] = 0; });
      await convRef.update(convUpdate).catch(() => {});
    } catch (e) {
      alert("Sohbet silinemedi: " + e.message);
    }
  });

})();

(() => {
  "use strict";

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

  function getOrCreateSalt() {
    let salt = localStorage.getItem(STORAGE_SALT);
    if (!salt) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      salt = b64encode(bytes.buffer);
      localStorage.setItem(STORAGE_SALT, salt);
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

  function deriveLocalKey(pin) {
    return deriveKeyFromSecret(pin, getOrCreateSalt());
  }

  function vaultExists() {
    return !!localStorage.getItem(STORAGE_BLOB);
  }

  async function saveLocalBlob(key, dataObj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(dataObj));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    localStorage.setItem(STORAGE_BLOB, JSON.stringify({
      iv: b64encode(iv.buffer),
      data: b64encode(ciphertext),
    }));
  }

  async function loadLocalBlob(key) {
    const raw = localStorage.getItem(STORAGE_BLOB);
    if (!raw) return null;
    const { iv, data } = JSON.parse(raw);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64decode(iv)) },
      key,
      b64decode(data)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
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

  async function unlockWithPin(pin) {
    const key = await deriveLocalKey(pin);
    if (!vaultExists()) {
      await saveLocalBlob(key, {});
      currentLocalKey = key;
      localSessionData = {};
      return true;
    }
    try {
      localSessionData = await loadLocalBlob(key);
      currentLocalKey = key;
      return true;
    } catch (e) {
      return false;
    }
  }

  async function tryAutoUnlock(pin) {
    if (!vaultExists()) return false; // require explicit setup via triple-tap gesture first
    const key = await deriveLocalKey(pin);
    try {
      localSessionData = await loadLocalBlob(key);
      currentLocalKey = key;
    } catch (e) {
      return false;
    }
    calcView.classList.add("hidden");
    vaultView.classList.remove("hidden");
    await afterLocalUnlock();
    return true;
  }

  unlockBtn.addEventListener("click", async () => {
    const pin = pinInput.value.trim();
    if (pin.length < 4) {
      errorEl.textContent = "PIN en az 4 karakter olmalı.";
      return;
    }
    const ok = await unlockWithPin(pin);
    if (ok) {
      errorEl.textContent = "";
      await afterLocalUnlock();
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
  let messagesUnsub = null;
  const lastMessageUnsubs = new Map(); // convId -> unsub
  const previousUnread = new Map(); // convId -> last known unread count, for alarm-trigger edge detection

  // ---- Alarm-style notification: disguised as a phone alarm going off,
  // never mentions messages, senders or nicknames. Only fires while this
  // tab/PWA is open (foreground or backgrounded) — there is no server-side
  // push set up, so a fully closed app or locked phone won't ring.

  function playAlarmSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      const beeps = 4;
      for (let i = 0; i < beeps; i++) {
        const start = now + i * 0.5;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.35, start + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.35);
      }
      setTimeout(() => ctx.close().catch(() => {}), (beeps * 0.5 + 1) * 1000);
    } catch (e) {}
  }

  function showAlarmNotification() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    try {
      new Notification("Alarm", { body: timeStr, tag: "calcut-alarm", silent: true, requireInteraction: false });
    } catch (e) {}
  }

  function triggerAlarmAlert() {
    playAlarmSound();
    showAlarmNotification();
    if (navigator.vibrate) {
      try { navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) {}
    }
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
    stopTypingListener();
    stopListeningForIncomingCalls();
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
        if (snap.empty) return;
        const d = snap.docs[0].data();
        const preview = d.type === "image" ? "📷 Fotoğraf" : d.type === "file" ? "📄 Dosya" : await decryptMessage(d).catch(() => "[çözülemedi]");
        const conv = conversations.get(convId);
        if (!conv) return;
        conv.lastPreview = (d.from === myUid ? "Sen: " : "") + preview;
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
          const otherUid = d.participants.find(u => u !== myUid);
          const otherNickname = (d.participantNicknames && d.participantNicknames[otherUid]) || "?";
          const unread = (d.unreadCount && d.unreadCount[myUid]) || 0;
          const existing = conversations.get(change.doc.id) || {};
          conversations.set(change.doc.id, {
            id: change.doc.id,
            otherUid,
            otherNickname,
            updatedAt: d.updatedAt ? d.updatedAt.toMillis() : 0,
            unread,
            lastPreview: existing.lastPreview || "",
            lastTs: existing.lastTs || 0,
          });
          subscribeLastMessage(change.doc.id);

          // Fire the alarm-style notification for a new message: only once
          // we've already seen this conversation before (skip the initial
          // snapshot on login, which would otherwise fire for old unread
          // messages) and only if it's not the conversation currently open.
          const prev = previousUnread.get(change.doc.id);
          if (prev !== undefined && unread > prev && change.doc.id !== activeConvId && !myBlocked[otherUid]) {
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
      li.querySelector(".thread-name").textContent = "@" + conv.otherNickname;
      li.querySelector(".thread-time").textContent = formatThreadTime(conv.lastTs || conv.updatedAt);
      if (myBlocked[conv.otherUid]) {
        li.classList.add("blocked");
        li.querySelector(".thread-preview").textContent = "🚫 Engellendi";
      } else {
        li.querySelector(".thread-preview").textContent = conv.lastPreview || "Aç ve sohbet et";
      }
      if (conv.unread > 0) {
        const badge = li.querySelector(".thread-badge");
        badge.textContent = conv.unread > 99 ? "99+" : String(conv.unread);
        badge.classList.remove("hidden");
      }
      li.addEventListener("click", () => openConversation(conv.id, conv.otherUid, conv.otherNickname));
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

  function lockVault() {
    stopAllMessengerListeners();
    myPrivateKey = null;
    myPublicKey = null;
    closeVaultToCalculator();
  }

  document.getElementById("lock-btn").addEventListener("click", lockVault);

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
    document.getElementById("alarm-msg").textContent = "";
    document.getElementById("nickname-change-msg").textContent = "";
    document.getElementById("new-nickname-input").value = "";
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
      msgEl.textContent = "Biyometrik onay etkinleştirildi.";
    } catch (e) {
      msgEl.textContent = "Biyometrik kayıt başarısız: " + e.message;
    }
  });

  document.getElementById("enable-alarm-btn").addEventListener("click", async () => {
    const msgEl = document.getElementById("alarm-msg");
    if (!("Notification" in window)) {
      msgEl.textContent = "Bu tarayıcı bildirimleri desteklemiyor.";
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        msgEl.textContent = "Bildirimler etkinleştirildi. Uygulama açıkken (arka planda dahi) yeni mesajda alarm çalacak.";
        triggerAlarmAlert();
      } else {
        msgEl.textContent = "Bildirim izni verilmedi.";
      }
    } catch (e) {
      msgEl.textContent = "Bildirimler etkinleştirilemedi: " + e.message;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    if (!confirm("Hesabından çıkış yapılsın mı?")) return;
    stopAllMessengerListeners();
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
    closeVaultToCalculator();
  });

  /* ---------------- Conversation detail / E2E message send+receive ---------------- */

  const messageListEl = document.getElementById("message-list");
  const messageInput = document.getElementById("message-input");
  const attachPhotoBtn = document.getElementById("attach-photo-btn");
  const photoInput = document.getElementById("photo-input");

  async function openConversation(convId, otherUid, otherNickname) {
    closeThreadSearch();
    activeConvId = convId;
    activeOtherUid = otherUid;
    threadListPanel.classList.add("hidden");
    threadDetailPanel.classList.remove("hidden");
    settingsPanel.classList.add("hidden");
    document.getElementById("thread-title").textContent = "@" + otherNickname;
    const conv = conversations.get(convId);
    if (conv) conv.unread = 0;
    fbDb.collection("conversations").doc(convId).update({ [`unreadCount.${myUid}`]: 0 }).catch(() => {});
    await getPublicKeyForUid(otherUid);
    listenToMessages(convId);
    listenToTyping(convId, otherUid);
    updateBlockUi();
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

  /* ---------------- Voice calls (WebRTC, signaled through Firestore) ----------------
     No push/background support: this only works while the tab/PWA is open, same
     tradeoff as the alarm notifications. Only STUN is configured (free public
     servers) — there's no TURN relay, so calls between two very restrictive
     NATs (e.g. some mobile carriers) may fail to connect; that would need a
     paid TURN service to fix. */

  const ICE_SERVERS = { iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ] };
  const CALL_RING_TIMEOUT_MS = 30000;

  const callScreen = document.getElementById("call-screen");
  const callNicknameEl = document.getElementById("call-nickname");
  const callStatusEl = document.getElementById("call-status");
  const callTimerEl = document.getElementById("call-timer");
  const callErrorEl = document.getElementById("call-error");
  const callActionsIncoming = document.getElementById("call-actions-incoming");
  const callActionsActive = document.getElementById("call-actions-active");
  const callActionsOutgoing = document.getElementById("call-actions-outgoing");
  const callMuteBtn = document.getElementById("call-mute-btn");
  const threadCallBtn = document.getElementById("thread-call-btn");

  let activeCallId = null;
  let activeCallRole = null; // "caller" or "callee"
  let peerConnection = null;
  let localStream = null;
  let remoteAudioEl = null;
  let callDocUnsub = null;
  let remoteCandidatesUnsub = null;
  let incomingCallsUnsub = null;
  let currentIncomingCall = null; // { id, data }
  let callTimerInterval = null;
  let callStartedAt = null;
  let isMuted = false;
  let ringToneTimer = null;
  let ringToneCtx = null;
  let callTimeoutTimer = null;

  function resetCallUi() {
    callActionsIncoming.classList.add("hidden");
    callActionsActive.classList.add("hidden");
    callActionsOutgoing.classList.add("hidden");
    callTimerEl.classList.add("hidden");
    callErrorEl.textContent = "";
  }

  function showIncomingCallUi(data) {
    callScreen.classList.remove("hidden");
    resetCallUi();
    callNicknameEl.textContent = "@" + (data.fromNickname || "?");
    callStatusEl.textContent = "Gelen arama...";
    callActionsIncoming.classList.remove("hidden");
    playRingtone();
  }

  function showOutgoingCallUi(nickname) {
    callScreen.classList.remove("hidden");
    resetCallUi();
    callNicknameEl.textContent = "@" + nickname;
    callStatusEl.textContent = "Aranıyor...";
    callActionsOutgoing.classList.remove("hidden");
  }

  function showActiveCallUi(nickname) {
    resetCallUi();
    callNicknameEl.textContent = "@" + nickname;
    callStatusEl.textContent = "Görüşmede";
    callActionsActive.classList.remove("hidden");
    callTimerEl.classList.remove("hidden");
    callTimerEl.textContent = "00:00";
    isMuted = false;
    callMuteBtn.classList.remove("active");
    callMuteBtn.textContent = "Sessize Al";
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
  }

  function playRingtone() {
    stopRingtone();
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      ringToneCtx = new Ctx();
      const ring = () => {
        if (!ringToneCtx) return;
        const now = ringToneCtx.currentTime;
        [0, 0.3].forEach(offset => {
          const osc = ringToneCtx.createOscillator();
          const gain = ringToneCtx.createGain();
          osc.type = "sine";
          osc.frequency.value = 660;
          gain.gain.setValueAtTime(0.0001, now + offset);
          gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.28);
          osc.connect(gain).connect(ringToneCtx.destination);
          osc.start(now + offset);
          osc.stop(now + offset + 0.3);
        });
      };
      ring();
      ringToneTimer = setInterval(ring, 1600);
    } catch (e) {}
  }

  function stopRingtone() {
    if (ringToneTimer) { clearInterval(ringToneTimer); ringToneTimer = null; }
    if (ringToneCtx) { ringToneCtx.close().catch(() => {}); ringToneCtx = null; }
  }

  async function getMic() {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      throw new Error("Mikrofon erişimi reddedildi veya kullanılamıyor.");
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
      if (!remoteAudioEl) {
        remoteAudioEl = document.createElement("audio");
        remoteAudioEl.autoplay = true;
        document.body.appendChild(remoteAudioEl);
      }
      remoteAudioEl.srcObject = event.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (pc === peerConnection && (pc.connectionState === "failed" || pc.connectionState === "disconnected")) {
        endCall("Bağlantı kesildi.");
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
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
          showActiveCallUi(data.toNickname);
        } catch (e) {
          endCall("Bağlantı kurulamadı.");
        }
      }
      if (data.status === "rejected" && activeCallRole === "caller") {
        endCall("Arama reddedildi.");
      }
      if (data.status === "ended") {
        endCall(activeCallRole === "caller" ? "Arama sona erdi." : "Karşı taraf kapattı.");
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

  async function startCall(otherUid, otherNickname) {
    if (!otherUid || activeCallId) return;
    if (myBlocked[otherUid]) { alert("Bu kullanıcıyı engellediniz."); return; }
    if (!("mediaDevices" in navigator)) { alert("Bu tarayıcı sesli aramayı desteklemiyor."); return; }
    try {
      localStream = await getMic();
    } catch (e) {
      alert(e.message);
      return;
    }
    activeCallRole = "caller";
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
        offer: { type: offer.type, sdp: offer.sdp },
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      peerConnection._flushCandidates();

      listenToCallDoc(activeCallId);
      listenToRemoteCandidates(activeCallId, "calleeCandidates");

      callTimeoutTimer = setTimeout(() => {
        if (activeCallId === callDocRef.id && activeCallRole === "caller") {
          fbDb.collection("calls").doc(callDocRef.id).update({ status: "ended" }).catch(() => {});
          endCall("Yanıt yok.");
        }
      }, CALL_RING_TIMEOUT_MS);
    } catch (e) {
      callErrorEl.textContent = "Arama başlatılamadı: " + e.message;
      endCall(null);
    }
  }

  async function acceptIncomingCall() {
    if (!currentIncomingCall) return;
    stopRingtone();
    const { id, data } = currentIncomingCall;
    currentIncomingCall = null;
    try {
      localStream = await getMic();
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
      endCall(null);
    }
  }

  function rejectIncomingCall() {
    if (!currentIncomingCall) return;
    stopRingtone();
    fbDb.collection("calls").doc(currentIncomingCall.id).update({ status: "rejected" }).catch(() => {});
    currentIncomingCall = null;
    hideCallScreen();
  }

  function cancelOutgoingCall() {
    if (activeCallId && activeCallRole === "caller") {
      fbDb.collection("calls").doc(activeCallId).update({ status: "ended" }).catch(() => {});
    }
    endCall(null);
  }

  function hangUpCall() {
    if (activeCallId) {
      fbDb.collection("calls").doc(activeCallId).update({ status: "ended" }).catch(() => {});
    }
    endCall(null);
  }

  function endCall(reason) {
    clearTimeout(callTimeoutTimer);
    clearInterval(callTimerInterval);
    callTimerInterval = null;
    stopRingtone();
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (remoteAudioEl) { remoteAudioEl.srcObject = null; }
    if (callDocUnsub) { callDocUnsub(); callDocUnsub = null; }
    if (remoteCandidatesUnsub) { remoteCandidatesUnsub(); remoteCandidatesUnsub = null; }
    activeCallId = null;
    activeCallRole = null;
    isMuted = false;
    if (reason) {
      resetCallUi();
      callStatusEl.textContent = reason;
      setTimeout(hideCallScreen, 1500);
    } else {
      hideCallScreen();
    }
  }

  function listenForIncomingCalls() {
    if (incomingCallsUnsub) incomingCallsUnsub();
    incomingCallsUnsub = fbDb.collection("calls")
      .where("to", "==", myUid)
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
          showIncomingCallUi(data);
        });
      }, () => {});
  }

  function stopListeningForIncomingCalls() {
    if (incomingCallsUnsub) { incomingCallsUnsub(); incomingCallsUnsub = null; }
  }

  threadCallBtn.addEventListener("click", () => {
    if (!activeOtherUid || !activeConvId) return;
    const conv = conversations.get(activeConvId);
    startCall(activeOtherUid, conv ? conv.otherNickname : "?");
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
    if (!activeConvId) return;
    const now = Date.now();
    if (now - lastTypingWriteAt < TYPING_WRITE_THROTTLE_MS) return;
    lastTypingWriteAt = now;
    fbDb.collection("conversations").doc(activeConvId).update({
      [`typing.${myUid}`]: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  function listenToMessages(convId) {
    if (messagesUnsub) messagesUnsub();
    messageListEl.innerHTML = "";
    messagesUnsub = fbDb.collection("conversations").doc(convId).collection("messages")
      .orderBy("ts")
      .onSnapshot(async snap => {
        fbDb.collection("conversations").doc(convId).update({ [`unreadCount.${myUid}`]: 0 }).catch(() => {});
        const rendered = [];
        for (const doc of snap.docs) {
          const d = doc.data();
          const plain = await decryptMessage(d).catch(() => "[çözülemedi]");
          // The conversation is open right now, so any message from the other
          // person is by definition being read as it arrives.
          if (d.from !== myUid && !d.read) {
            doc.ref.update({ read: true }).catch(() => {});
          }
          let file = null;
          if (d.type === "file") {
            try { file = JSON.parse(plain); } catch (e) { file = null; }
          }
          rendered.push({
            from: d.from === myUid ? "me" : "them",
            text: (d.type === "image" || d.type === "file") ? null : plain,
            image: d.type === "image" ? plain : null,
            file,
            ts: d.ts ? d.ts.toMillis() : Date.now(),
            read: !!d.read,
          });
        }
        currentMessages = rendered;
        renderMessages(rendered);
      }, err => console.error("messages listen error", err));
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

  async function decryptMessage(d) {
    const wrapped = d.wrappedKeys && d.wrappedKeys[myUid];
    if (!wrapped) throw new Error("no key for me");
    const rawAes = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, myPrivateKey, b64decode(wrapped));
    const aesKey = await crypto.subtle.importKey("raw", rawAes, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64decode(d.iv)) },
      aesKey,
      b64decode(d.ciphertext)
    );
    return new TextDecoder().decode(plain);
  }

  function renderMessages(msgs) {
    messageListEl.innerHTML = "";
    const query = searchQuery.trim();
    let matchCount = 0;
    msgs.forEach(m => {
      if (query) {
        // Images aren't searchable (no text to match), so hide them while
        // filtering; only text messages containing the query are shown.
        if (m.image || !m.text || !m.text.toLowerCase().includes(query.toLowerCase())) return;
        matchCount++;
      }
      const div = document.createElement("div");
      div.className = "msg-bubble " + m.from;
      const time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
        appendHighlightedText(span, m.text, query);
        div.appendChild(span);
      }
      const metaRow = document.createElement("span");
      metaRow.className = "msg-meta";
      const timeSpan = document.createElement("span");
      timeSpan.className = "msg-time";
      timeSpan.textContent = time;
      metaRow.appendChild(timeSpan);
      if (m.from === "me") {
        const tick = document.createElement("span");
        tick.className = "msg-tick" + (m.read ? " read" : "");
        tick.textContent = "✓✓";
        metaRow.appendChild(tick);
      }
      div.appendChild(metaRow);
      messageListEl.appendChild(div);
    });
    messageListEl.scrollTop = messageListEl.scrollHeight;
    if (query) {
      threadSearchCount.textContent = matchCount === 0 ? "Sonuç yok" : matchCount + " sonuç";
    }
  }

  async function wrapAesKeyForPublicKey(rawAesKey, publicKey) {
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey);
    return b64encode(wrapped);
  }

  async function sendEncrypted(payloadText, type) {
    // Capture these locally: the user may navigate away from the conversation
    // (clearing activeConvId/activeOtherUid) while this async send is still
    // in flight, and the write below must still target the right thread.
    const convId = activeConvId;
    const otherUid = activeOtherUid;
    if (!convId || !otherUid) return;
    if (myBlocked[otherUid]) return;
    const otherPublicKey = await getPublicKeyForUid(otherUid);
    if (!otherPublicKey) {
      alert("Alıcının açık anahtarı bulunamadı.");
      return;
    }
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const rawAes = await crypto.subtle.exportKey("raw", aesKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(payloadText)
    );
    const myWrapped = await wrapAesKeyForPublicKey(rawAes, myPublicKey);
    const theirWrapped = await wrapAesKeyForPublicKey(rawAes, otherPublicKey);

    await fbDb.collection("conversations").doc(convId).collection("messages").add({
      from: myUid,
      type,
      iv: b64encode(iv.buffer),
      ciphertext: b64encode(ciphertext),
      wrappedKeys: { [myUid]: myWrapped, [otherUid]: theirWrapped },
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      read: false,
    });
    await fbDb.collection("conversations").doc(convId).update({
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      [`unreadCount.${otherUid}`]: firebase.firestore.FieldValue.increment(1),
    });
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
    // Firestore caps a document at ~1MiB, and base64 + JSON wrapping + E2E
    // encryption overhead all inflate the stored size well past the raw
    // file size, so the caps here are much smaller than that limit.
    const maxSize = isImage ? 3 * 1024 * 1024 : 500 * 1024;
    if (file.size > maxSize) {
      alert(isImage ? "Fotoğraf çok büyük (maks 3MB)." : "Dosya çok büyük (maks 500KB).");
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
    showThreadList();
  });

  document.getElementById("thread-delete-btn").addEventListener("click", async () => {
    if (!activeConvId) return;
    if (!confirm("Bu sohbeti silmek istediğinize emin misiniz? (Karşı tarafta da silinir)")) return;
    const convId = activeConvId;
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    const msgsSnap = await fbDb.collection("conversations").doc(convId).collection("messages").get();
    const batch = fbDb.batch();
    msgsSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(fbDb.collection("conversations").doc(convId));
    await batch.commit();
    activeConvId = null;
    activeOtherUid = null;
    showThreadList();
  });

})();

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
        // (e.g. got approved) while this device was locked.
        fbDb.collection("users").doc(myUid).get().then(doc => {
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
    lastMessageUnsubs.forEach(unsub => unsub());
    lastMessageUnsubs.clear();
    conversations.clear();
  }

  function subscribeLastMessage(convId, attempt) {
    attempt = attempt || 0;
    if (lastMessageUnsubs.has(convId)) return;
    const unsub = fbDb.collection("conversations").doc(convId).collection("messages")
      .orderBy("ts", "desc").limit(1)
      .onSnapshot(async snap => {
        if (snap.empty) return;
        const d = snap.docs[0].data();
        const preview = d.type === "image" ? "📷 Fotoğraf" : await decryptMessage(d).catch(() => "[çözülemedi]");
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
        });
        if (!threadDetailPanel.classList.contains("hidden")) return;
        renderThreadList();
      }, err => console.error("conversations listen error", err));
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
      li.querySelector(".thread-preview").textContent = conv.lastPreview || "Aç ve sohbet et";
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

  document.getElementById("lock-btn").addEventListener("click", () => {
    stopAllMessengerListeners();
    myPrivateKey = null;
    myPublicKey = null;
    closeVaultToCalculator();
  });

  document.getElementById("settings-btn").addEventListener("click", () => {
    threadListPanel.classList.add("hidden");
    threadDetailPanel.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
    document.getElementById("new-pin-input").value = "";
    document.getElementById("settings-msg").textContent = "";
    document.getElementById("biometric-msg").textContent = "";
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
        li.innerHTML = `<span></span><button class="approve-btn">Onayla</button>`;
        li.querySelector("span").textContent = "@" + data.nickname;
        li.querySelector(".approve-btn").addEventListener("click", async (ev) => {
          ev.target.disabled = true;
          try {
            await fbDb.collection("users").doc(doc.id).update({ status: "approved" });
            li.remove();
          } catch (e) {
            alert("Onaylanamadı: " + e.message);
            ev.target.disabled = false;
          }
        });
        listEl.appendChild(li);
      });
    } catch (e) {
      listEl.innerHTML = "<li class='empty-state'>Yüklenemedi.</li>";
    }
  }

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
          rendered.push({
            from: d.from === myUid ? "me" : "them",
            text: d.type === "image" ? null : plain,
            image: d.type === "image" ? plain : null,
            ts: d.ts ? d.ts.toMillis() : Date.now(),
            read: !!d.read,
          });
        }
        renderMessages(rendered);
      }, err => console.error("messages listen error", err));
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
    msgs.forEach(m => {
      const div = document.createElement("div");
      div.className = "msg-bubble " + m.from;
      const time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (m.image) {
        const img = document.createElement("img");
        img.src = m.image;
        div.appendChild(img);
      } else {
        const span = document.createElement("span");
        span.textContent = m.text;
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
    if (file.size > 3 * 1024 * 1024) {
      alert("Fotoğraf çok büyük (maks 3MB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await sendEncrypted(reader.result, "image");
      } catch (e) {
        alert("Fotoğraf gönderilemedi: " + e.message);
      }
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("thread-back-btn").addEventListener("click", () => {
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
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

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

  /* ---------------- Biometric vault layer (Android app) ----------------
     In the Android app, biometrics can protect the vault itself, not just
     gate it. The PIN still opens the outer blob (so the calculator's
     as-you-type unlock and the duress PIN work unchanged), but the session
     inside it (private key and all) is then encrypted again with a secret
     only a fingerprint can release: { bioLayer: { iv, data } }. See
     BiometricKeyPlugin.java. */

  const STORAGE_BIO_SEALED = "calcut_vault_bio_sealed";
  let currentBioKey = null;
  let lastBioError = null;

  function biometricKeyPlugin() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.BiometricKey) || null;
  }

  function bioKeyFromSecret(secretB64) {
    return crypto.subtle.importKey("raw", b64decode(secretB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  // What goes into the PIN-encrypted blob: the session itself, or the
  // session encrypted again with the biometric key when that is on.
  async function sealSession(data) {
    if (!currentBioKey) return data;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, currentBioKey, new TextEncoder().encode(JSON.stringify(data))
    );
    return { bioLayer: { iv: b64encode(iv.buffer), data: b64encode(ciphertext) } };
  }

  async function openBioLayer(layer) {
    const plugin = biometricKeyPlugin();
    const sealed = localStorage.getItem(STORAGE_BIO_SEALED);
    if (!plugin || !sealed) throw new Error("Bu cihazda biyometrik anahtar yok.");
    const { secret } = await plugin.unlock({ sealed });
    const key = await bioKeyFromSecret(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64decode(layer.iv)) }, key, b64decode(layer.data)
    );
    currentBioKey = key;
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function bioFailText() {
    if (lastBioError && lastBioError.code === "invalidated") {
      return "Parmak izi kayıtların değiştiği için biyometrik anahtar geçersiz oldu. " +
        "\"PIN'i unuttum\" ile sıfırlayıp hesabına yeniden giriş yap; mesajların hesabında duruyor.";
    }
    return "Biyometrik doğrulama başarısız.";
  }

  function forgetBiometricKey() {
    localStorage.removeItem(STORAGE_BIO_SEALED);
    currentBioKey = null;
    const plugin = biometricKeyPlugin();
    if (plugin) plugin.remove().catch(() => {});
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
      ...localPrefsOf(localSessionData),
    };
    await saveLocalBlob(currentLocalKey, await sealSession(localSessionData)).catch(() => {});
  }

  async function clearPersistedSession() {
    localSessionData = {};
    if (currentLocalKey) {
      await saveLocalBlob(currentLocalKey, await sealSession({})).catch(() => {});
    }
  }

  // Returns "real" | "duress" | "fail" | "biofail". The real vault is always tried
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
    let outer;
    try {
      outer = await loadLocalBlob(key);
    } catch (e) {
      if (await tryDuressPin(pin)) return "duress";
      return "fail";
    }
    // The PIN is right; a biometric layer still needs the fingerprint.
    if (outer && outer.bioLayer) {
      try {
        localSessionData = await openBioLayer(outer.bioLayer);
      } catch (e) {
        lastBioError = e;
        return "biofail";
      }
    } else {
      currentBioKey = null;
      localSessionData = outer;
    }
    currentLocalKey = key;
    return "real";
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
    if (mode === "fail" || mode === "biofail") return false;
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
    } else if (mode === "biofail") {
      errorEl.textContent = bioFailText();
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
    forgetBiometricKey();
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
  // Auth email addresses must stay ASCII, so a nickname with Turkish
  // letters is spelled out there: each such letter becomes "-" plus its
  // 4-digit code (çağrı -> u-00e7a-011fr-0131). ASCII nicknames keep their
  // old address, and "-" never appears in a nickname, so none collide.
  function nicknameToSyntheticEmail(nickname) {
    if (/^[a-z0-9_]*$/.test(nickname)) return nickname + SYNTHETIC_EMAIL_DOMAIN;
    return "u" + nickname.replace(/[^a-z0-9_]/g,
      ch => "-" + ch.charCodeAt(0).toString(16).padStart(4, "0")) + SYNTHETIC_EMAIL_DOMAIN;
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

  // Lowercase letters (Turkish ones included), digits and "_". "I" stays
  // "i" as before (so existing nicknames still match); "İ" is "i" too.
  function normalizeNickname(raw) {
    return raw.normalize("NFC").trim().replace(/İ/g, "i").toLowerCase()
      .replace(/[^a-z0-9_çğıöşü]/g, "");
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
      throw new Error("Kullanıcı adı en az 3 karakter olmalı (harf, Türkçe harfler dahil, rakam, alt çizgi).");
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
    let cred;
    try {
      cred = await fbAuth.signInWithEmailAndPassword(nicknameToSyntheticEmail(nickname), password);
    } catch (e) {
      // Before Turkish letters were allowed they were dropped from the
      // nickname ("çağrı" signed up as "ar"): try that older form too.
      const legacy = nickname.replace(/[^a-z0-9_]/g, "");
      if (legacy === nickname || legacy.length < 3) throw e;
      cred = await fbAuth.signInWithEmailAndPassword(nicknameToSyntheticEmail(legacy), password).catch(() => { throw e; });
    }
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
      authError.textContent = "Kullanıcı adı en az 3 karakter olmalı (harf, Türkçe harfler dahil, rakam, alt çizgi).";
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

  // The Android app can also use the phone's own alarm tone (AlarmSoundPlugin),
  // which then rings for background notifications too, at alarm volume.
  function alarmSoundPlugin() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.AlarmSound) || null;
  }
  if (alarmSoundPlugin()) {
    SOUND_PRESETS.phoneAlarm = { name: "📱 Telefonun alarm sesi", native: true, play: () => 0 };
  }

  // Tells the native side which channel (sound) background notifications use.
  function syncNativeSoundPref(kind) {
    const plugin = alarmSoundPlugin();
    if (!plugin) return;
    const id = getSoundPref(kind);
    const sound = id === "phoneAlarm" ? "alarm" : id === "silent" ? "silent" : "default";
    plugin.setPreference({ kind, sound }).catch(() => {});
  }

  function getSoundPref(kind) {
    try {
      const v = localStorage.getItem("calcut_sound_" + kind);
      if (v && SOUND_PRESETS[v]) return v;
    } catch (e) {}
    return "classic";
  }

  function setSoundPref(kind, id) {
    try { localStorage.setItem("calcut_sound_" + kind, id); } catch (e) {}
    syncNativeSoundPref(kind);
  }
  syncNativeSoundPref("message");
  syncNativeSoundPref("call");

  // Plays a preset once (message alarm, or a preview in Settings).
  function playSoundOnce(presetId) {
    if (SOUND_PRESETS[presetId].native) {
      const plugin = alarmSoundPlugin();
      if (plugin) plugin.play({ loop: false, maxMs: 4000 }).catch(() => {});
      return;
    }
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

  // convId (optional): the chat it's for, which may have its own sound.
  function triggerAlarmAlert(convId) {
    const own = convId ? chatSoundFor(convId) : null;
    if (own) playSoundOnce(own);
    else playAlarmSound();
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
    startStatusListeners();
    listenForIncomingCalls();
    startPresence();
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
    stopPresence();
    stopStatusListeners();
    // The incoming-call listener deliberately keeps running while locked (it
    // follows the Firebase sign-in, see listenForIncomingCalls); it stops on sign-out.
    endCall(null);
    lastMessageUnsubs.forEach(unsub => unsub());
    lastMessageUnsubs.clear();
    conversations.clear();
    callHistory = null;
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
          preview = d.viewOnce ? "👁️ Fotoğraf" : "📷 Fotoğraf";
        } else if (d.type === "file") {
          preview = "📄 Dosya";
        } else if (d.type === "audio") {
          preview = "🎤 Sesli mesaj";
        } else if (d.type === "poll") {
          preview = "📊 Anket";
        } else if (d.type === "location") {
          preview = "📍 Konum";
        } else if (d.type === "contact") {
          preview = "👤 Kişi";
        } else if (d.type === "livelocation") {
          preview = "📍 Canlı konum";
        } else if (d.type === "sticker") {
          preview = "🌟 Çıkartma";
        } else if (d.type === "event") {
          preview = "📅 Etkinlik";
        } else if (d.type === "call") {
          if (mainTab === "calls") loadCallHistory();
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
        // It reached this device: the sender's single ✓ becomes ✓✓.
        if (!conv.isGroup && d.from !== myUid && !d.delivered && !d.read && !d.deleted) {
          snap.docs[0].ref.update({ delivered: true }).catch(() => {});
        } else if (conv.isGroup && d.from !== myUid && !d.deleted && !(d.deliveredTo && d.deliveredTo[myUid])) {
          snap.docs[0].ref.update({ [`deliveredTo.${myUid}`]: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        }
        // Call log previews already read naturally regardless of who placed
        // the call, so skip the usual "Sen: "/sender-name prefix for that type.
        let prefix = "";
        if (d.type !== "call") {
          if (d.from === myUid) prefix = "Sen: ";
          else if (conv.isGroup) prefix = (conv.participantNicknames[d.from] || "?") + ": ";
        }
        conv.lastPreview = prefix + preview;
        conv.lastIsMissedCall = lastIsMissedCall;
        conv.lastMentionsMe = d.from !== myUid && Array.isArray(d.mentions) && d.mentions.includes(myUid);
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
            // Removed from (or left) the group that is open right now.
            if (change.doc.id === activeConvId) {
              document.getElementById("thread-back-btn").click();
              document.getElementById("group-info-modal").classList.add("hidden");
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
            // Older groups have no admins field: their creator is the admin.
            admins: Array.isArray(d.admins) ? d.admins : (d.createdBy ? [d.createdBy] : []),
            groupAvatar: typeof d.groupAvatar === "string" && AVATAR_RE.test(d.groupAvatar) ? d.groupAvatar : null,
            participants: d.participants || [],
            participantNicknames: d.participantNicknames || {},
            updatedAt: d.updatedAt ? d.updatedAt.toMillis() : 0,
            unread,
            lastPreview: existing.lastPreview || "",
            lastIsMissedCall: !!existing.lastIsMissedCall,
            lastTs: existing.lastTs || 0,
            disappearingSeconds: d.disappearingSeconds || 0,
            muted,
            pinnedMessage: typeof d.pinnedMessage === "string" ? d.pinnedMessage : null,
            inviteCode: typeof d.inviteCode === "string" ? d.inviteCode : null,
            lastMentionsMe: !!existing.lastMentionsMe,
          });
          if (change.doc.id === activeConvId) {
            updateDisappearingUi();
            updateMuteUi();
            renderPinnedBar();
            if (isGroup) syncActiveGroup();
          }
          subscribeLastMessage(change.doc.id);

          // Fire the alarm-style notification for a new message: only once
          // we've already seen this conversation before (skip the initial
          // snapshot on login, which would otherwise fire for old unread
          // messages) and only if it's not the conversation currently open.
          const prev = previousUnread.get(change.doc.id);
          if (prev !== undefined && unread > prev && change.doc.id !== activeConvId && !(otherUid && myBlocked[otherUid]) && !muted) {
            triggerAlarmAlert(change.doc.id);
          }
          previousUnread.set(change.doc.id, unread);
        });
        if (!threadDetailPanel.classList.contains("hidden")) return;
        renderThreadList();
        renderStatusStrip(); // contact names come from the conversations
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

  /* ---------------- Per-device chat preferences ----------------
     Pinned and archived chats, starred messages and messages deleted "for
     me" are per device and live in the PIN-encrypted local session, so
     neither the server nor anyone without the PIN can see them. */

  function localPrefsOf(d) {
    d = d || {};
    return {
      pinned: Array.isArray(d.pinned) ? d.pinned : [],
      archived: Array.isArray(d.archived) ? d.archived : [],
      starred: d.starred && typeof d.starred === "object" ? d.starred : {},
      hiddenMsgs: d.hiddenMsgs && typeof d.hiddenMsgs === "object" ? d.hiddenMsgs : {},
    };
  }

  async function saveLocalPrefs() {
    if (!localSessionData || !currentLocalKey) return;
    await saveLocalBlob(currentLocalKey, await sealSession(localSessionData)).catch(() => {});
  }

  function pinnedConvIds() {
    return localPrefsOf(localSessionData).pinned;
  }

  function archivedConvIds() {
    return localPrefsOf(localSessionData).archived;
  }

  async function togglePin(convId) {
    if (!localSessionData || !currentLocalKey) return;
    const pins = pinnedConvIds();
    localSessionData.pinned = pins.includes(convId) ? pins.filter(id => id !== convId) : [convId, ...pins];
    renderThreadList();
    await saveLocalPrefs();
  }

  // Archiving also unpins, as in WhatsApp.
  async function toggleArchive(convId) {
    if (!localSessionData || !currentLocalKey) return;
    const archived = archivedConvIds();
    if (archived.includes(convId)) {
      localSessionData.archived = archived.filter(id => id !== convId);
    } else {
      localSessionData.archived = [convId, ...archived];
      localSessionData.pinned = pinnedConvIds().filter(id => id !== convId);
    }
    renderThreadList();
    await saveLocalPrefs();
  }

  // Message ids per conversation: starred, or deleted for me.
  function msgFlag(field, convId, msgId) {
    const list = localPrefsOf(localSessionData)[field][convId];
    return Array.isArray(list) && list.includes(msgId);
  }

  async function setMsgFlag(field, convId, msgId, on) {
    if (!localSessionData || !currentLocalKey) return;
    const map = { ...localPrefsOf(localSessionData)[field] };
    const list = (map[convId] || []).filter(id => id !== msgId);
    if (on) list.push(msgId);
    if (list.length) map[convId] = list; else delete map[convId];
    localSessionData[field] = map;
    await saveLocalPrefs();
  }

  // Pinned chats first (most recently pinned on top), then the rest by last activity.
  function sortThreads(list, pins) {
    const rank = id => { const i = pins.indexOf(id); return i < 0 ? Infinity : i; };
    return list.sort((a, b) => (rank(a.id) - rank(b.id)) ||
      ((b.lastTs || b.updatedAt) - (a.lastTs || a.updatedAt)));
  }

  const LONG_PRESS_MS = 550;

  // Long-press (touch) or right-click (mouse) runs onLongPress; the click that
  // ends a long-press doesn't also count as a tap.
  function attachLongPress(el, onLongPress) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    let fired = false;
    const fire = () => { fired = true; timer = null; onLongPress(); };
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener("pointerdown", e => {
      fired = false;
      startX = e.clientX;
      startY = e.clientY;
      cancel();
      timer = setTimeout(fire, LONG_PRESS_MS);
    });
    el.addEventListener("pointermove", e => {
      if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) cancel();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(evt => el.addEventListener(evt, cancel));
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (timer) { cancel(); fire(); } else if (!fired) fire();
    });
    el.addEventListener("click", e => {
      if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
    }, true);
  }

  /* ---------------- Action sheet ---------------- */

  const actionSheet = document.getElementById("action-sheet");

  // actions: [{ label, run, danger }]
  function showActionSheet(title, actions) {
    document.getElementById("action-sheet-title").textContent = title || "";
    const list = document.getElementById("action-sheet-list");
    list.innerHTML = "";
    actions.forEach(a => {
      const btn = document.createElement("button");
      btn.textContent = a.label;
      if (a.danger) btn.className = "danger";
      btn.addEventListener("click", () => { hideActionSheet(); a.run(); });
      list.appendChild(btn);
    });
    actionSheet.classList.remove("hidden");
  }

  function hideActionSheet() {
    actionSheet.classList.add("hidden");
  }

  document.getElementById("action-sheet-cancel").addEventListener("click", hideActionSheet);
  actionSheet.addEventListener("click", e => { if (e.target === actionSheet) hideActionSheet(); });

  function showThreadActions(conv) {
    const pinned = pinnedConvIds().includes(conv.id);
    const archived = archivedConvIds().includes(conv.id);
    const actions = [];
    if (!archived) actions.push({ label: pinned ? "📌 Sabitlemeyi kaldır" : "📌 Sabitle", run: () => togglePin(conv.id) });
    actions.push({ label: archived ? "🗄️ Arşivden çıkar" : "🗄️ Arşivle", run: () => toggleArchive(conv.id) });
    actions.push({ label: "🗑 Sohbeti sil", danger: true, run: () => askDeleteChat(conv) });
    showActionSheet(conv.isGroup ? conv.groupName : "@" + conv.otherNickname, actions);
  }

  /* ---------------- Deleting a chat ----------------
     "Benden sil" (like WhatsApp's delete chat) only hides it on this
     device: deletedChats[convId] = when. Older messages stay hidden and the
     chat comes back to the list with the next new message. The person
     stays in Kişiler. "Herkesten sil" erases every message for everyone. */

  function chatDeletedAt(convId) {
    const d = localSessionData && localSessionData.deletedChats;
    return (d && typeof d === "object" && Number(d[convId])) || 0;
  }

  function chatHiddenForMe(conv) {
    const at = chatDeletedAt(conv.id);
    return !!at && (conv.lastTs || conv.updatedAt || 0) <= at;
  }

  async function deleteChatForMe(conv) {
    if (!localSessionData || !currentLocalKey) return;
    const deleted = { ...(localSessionData.deletedChats || {}), [conv.id]: Date.now() };
    localSessionData.deletedChats = deleted;
    localSessionData.pinned = pinnedConvIds().filter(id => id !== conv.id);
    localSessionData.archived = archivedConvIds().filter(id => id !== conv.id);
    await saveLocalPrefs();
    if (activeConvId === conv.id) document.getElementById("thread-back-btn").click();
    else renderThreadList();
  }

  async function deleteChatForEveryone(convId) {
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
  }

  function askDeleteChat(conv) {
    showActionSheet("Sohbeti sil", [
      { label: "🙈 Benden sil (yalnızca bu cihazda)", run: () => {
        if (confirm("Sohbet listenden kaldırılsın mı? Karşı tarafta durur; yeni mesaj gelince sohbet yeniden görünür. Kişi, Kişiler'de kalır.")) deleteChatForMe(conv);
      } },
      { label: "🗑 Herkesten sil (tüm mesajlar)", danger: true, run: () => {
        if (confirm("Bu sohbetteki tüm mesajlar herkesten silinsin mi? Geri alınamaz. Kişi listende kalır.")) deleteChatForEveryone(conv.id);
      } },
    ]);
  }

  /* ---------------- Contacts list ----------------
     Everyone you have a 1:1 chat with, whether or not the chat is in the
     chat list (archived, deleted for me...). */

  function renderContactsList() {
    const add = document.createElement("li");
    add.className = "archive-row";
    add.textContent = "➕ Yeni kişi ekle";
    add.addEventListener("click", () => document.getElementById("new-thread-btn").click());
    threadListEl.appendChild(add);
    const contacts = [...conversations.values()]
      .filter(c => !c.isGroup && c.otherUid)
      .sort((a, b) => a.otherNickname.localeCompare(b.otherNickname, "tr"));
    if (!contacts.length) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = "Henüz kişi yok.";
      threadListEl.appendChild(li);
      return;
    }
    contacts.forEach(c => {
      const blocked = !!myBlocked[c.otherUid];
      const li = document.createElement("li");
      li.className = "has-avatar call-row";
      li.innerHTML = `
        <span class="avatar"></span>
        <div class="thread-body">
          <div class="thread-row"><span class="thread-name"></span></div>
          <div class="thread-row"><span class="thread-preview"></span></div>
        </div>`;
      watchProfile(c.otherUid);
      paintAvatar(li.querySelector(".avatar"), c.otherUid, c.otherNickname);
      li.querySelector(".thread-name").textContent = "@" + c.otherNickname;
      li.querySelector(".thread-preview").textContent = blocked ? "🚫 Engellendi"
        : [aboutOf(c.otherUid), presenceText(c.otherUid)].filter(Boolean).join(" · ");
      if (!blocked) {
        [["📞", false, "Sesli ara"], ["📹", true, "Görüntülü ara"]].forEach(([icon, video, title]) => {
          const b = document.createElement("button");
          b.className = "call-back-btn";
          b.textContent = icon;
          b.title = title;
          b.addEventListener("click", e => {
            e.stopPropagation();
            startCall(c.otherUid, c.otherNickname, video);
          });
          li.appendChild(b);
        });
      }
      li.addEventListener("click", () => openConversation(c.id, c.otherUid, c.otherNickname));
      threadListEl.appendChild(li);
    });
  }

  let showingArchived = false;

  /* ---------------- Read / delivered receipts ----------------
     1:1: read / delivered flags on the message. Groups: readBy and
     deliveredTo maps of uid -> time, each member adding only their own
     (firestore.rules). */

  const GROUP_RECEIPT_RECENT = 30;

  function receiptTimes(map) {
    const out = {};
    if (map && typeof map === "object") {
      Object.entries(map).forEach(([uid, t]) => { out[uid] = t && t.toMillis ? t.toMillis() : Date.now(); });
    }
    return out;
  }

  // "sent" | "delivered" | "read" for one of my messages.
  function messageReceiptState(m) {
    if (activeIsGroup) {
      const conv = activeGroup();
      const members = conv ? conv.participants.filter(u => u !== myUid) : [];
      if (!members.length) return "sent";
      const readBy = m.readBy || {};
      const deliveredTo = m.deliveredTo || {};
      if (members.every(u => readBy[u])) return "read";
      if (members.every(u => readBy[u] || deliveredTo[u])) return "delivered";
      return "sent";
    }
    if (m.read && !myHideReadReceipts()) return "read";
    return m.read || m.delivered ? "delivered" : "sent";
  }

  function formatReceiptTime(t) {
    return new Date(t).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function showMessageInfo(m) {
    const rows = ["🕒 Gönderildi · " + formatReceiptTime(m.ts)];
    if (activeIsGroup) {
      const conv = activeGroup();
      const members = conv ? conv.participants.filter(u => u !== myUid) : [];
      const name = u => "@" + ((conv && conv.participantNicknames[u]) || "?");
      const readBy = m.readBy || {};
      const deliveredTo = m.deliveredTo || {};
      members.filter(u => readBy[u]).sort((a, b) => readBy[a] - readBy[b])
        .forEach(u => rows.push("🔵 " + name(u) + " · okudu " + formatReceiptTime(readBy[u])));
      members.filter(u => !readBy[u] && deliveredTo[u])
        .forEach(u => rows.push("✓✓ " + name(u) + " · iletildi " + formatReceiptTime(deliveredTo[u])));
      members.filter(u => !readBy[u] && !deliveredTo[u])
        .forEach(u => rows.push("✓ " + name(u) + " · henüz ulaşmadı"));
    } else {
      const st = messageReceiptState(m);
      rows.push(st === "read" ? "🔵 Okundu" : st === "delivered" ? "✓✓ İletildi" : "✓ Henüz ulaşmadı");
      if (m.read && myHideReadReceipts()) rows.push("Okundu bilgini kapattığın için okunma görünmüyor.");
    }
    showActionSheet("Mesaj bilgisi", rows.map(label => ({ label, run: () => {} })));
  }

  /* ---------------- Swipe right to reply ---------------- */

  const SWIPE_REPLY_PX = 60;

  function attachSwipeReply(el, onSwipe) {
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let tracking = false;
    let swiping = false;
    let swiped = false;
    el.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse") return;
      tracking = true;
      swiped = false;
      swiping = false;
      dx = 0;
      startX = e.clientX;
      startY = e.clientY;
    });
    el.addEventListener("pointermove", e => {
      if (!tracking) return;
      const mx = e.clientX - startX;
      const my = e.clientY - startY;
      if (!swiping) {
        if (Math.abs(my) > 12) { tracking = false; return; } // scrolling
        if (mx > 12) swiping = true;
        else return;
      }
      dx = Math.max(0, Math.min(mx, SWIPE_REPLY_PX + 20));
      el.style.transform = "translateX(" + dx + "px)";
      el.classList.toggle("swipe-ready", dx >= SWIPE_REPLY_PX);
    });
    const end = () => {
      if (!tracking) return;
      tracking = false;
      el.style.transform = "";
      el.classList.remove("swipe-ready");
      if (swiping && dx >= SWIPE_REPLY_PX) onSwipe();
      swiped = swiping;
      swiping = false;
    };
    ["pointerup", "pointercancel", "pointerleave"].forEach(evt => el.addEventListener(evt, end));
    // A swipe isn't a tap: don't open the photo / link under the finger.
    el.addEventListener("click", e => {
      if (swiped) { e.stopImmediatePropagation(); e.preventDefault(); swiped = false; }
    }, true);
  }

  /* ---------------- Chat list filters and the calls list ---------------- */

  let threadFilter = "all";
  let mainTab = "chats"; // chats | contacts | calls
  let callHistory = null; // decrypted call log entries, newest first (cleared on lock)
  let callHistoryLoading = false;

  document.querySelectorAll("#main-tabs button").forEach(btn => btn.addEventListener("click", () => {
    mainTab = btn.dataset.tab;
    document.querySelectorAll("#main-tabs button").forEach(b => b.classList.toggle("active", b === btn));
    document.getElementById("thread-filters").classList.toggle("hidden", mainTab !== "chats");
    document.getElementById("status-strip").classList.toggle("hidden", mainTab !== "chats");
    if (mainTab === "calls") loadCallHistory();
    renderThreadList();
  }));

  document.querySelectorAll("#thread-filters button").forEach(btn => btn.addEventListener("click", () => {
    threadFilter = btn.dataset.filter;
    document.querySelectorAll("#thread-filters button").forEach(b => b.classList.toggle("active", b === btn));
    renderThreadList();
  }));

  // The call log lives in each 1:1 chat as "call" messages (see
  // logCallToConversation); gather and decrypt them on demand.
  async function loadCallHistory() {
    if (callHistoryLoading) return;
    callHistoryLoading = true;
    const convs = [...conversations.values()].filter(c => !c.isGroup && c.otherUid);
    try {
      const lists = await Promise.all(convs.map(async c => {
        try {
          const snap = await fbDb.collection("conversations").doc(c.id).collection("messages")
            .where("type", "==", "call").get();
          const out = [];
          for (const doc of snap.docs) {
            const d = doc.data();
            if (d.deleted || (d.expiresAt && d.expiresAt.toMillis() <= Date.now())) continue;
            if (msgFlag("hiddenMsgs", c.id, doc.id)) continue;
            if (d.ts && d.ts.toMillis() <= chatDeletedAt(c.id)) continue;
            const cd = parseJson(await decryptMessage(d).catch(() => null));
            if (!cd) continue;
            out.push({
              convId: c.id, otherUid: c.otherUid, otherNickname: c.otherNickname,
              fromMe: d.from === myUid, outcome: cd.outcome, duration: cd.duration || 0, media: cd.media,
              ts: d.ts ? d.ts.toMillis() : 0,
            });
          }
          return out;
        } catch (e) {
          return [];
        }
      }));
      if (!myUid) return; // locked meanwhile
      callHistory = lists.flat().sort((a, b) => b.ts - a.ts).slice(0, 200);
    } finally {
      callHistoryLoading = false;
    }
    if (mainTab === "calls") renderThreadList();
  }

  function threadMatchesFilter(conv) {
    if (threadFilter === "unread") return conv.unread > 0;
    if (threadFilter === "groups") return conv.isGroup;
    return true;
  }

  function renderCallsList() {
    if (!callHistory) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = "Aramalar yükleniyor…";
      threadListEl.appendChild(li);
      return;
    }
    if (!callHistory.length) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = "Henüz arama yok.";
      threadListEl.appendChild(li);
      return;
    }
    callHistory.forEach(c => {
      const li = document.createElement("li");
      li.className = "has-avatar call-row";
      if (isMissedIncomingCall(c.fromMe, c.outcome)) li.classList.add("missed-call");
      li.innerHTML = `
        <span class="avatar"></span>
        <div class="thread-body">
          <div class="thread-row">
            <span class="thread-name"></span>
            <span class="thread-time"></span>
          </div>
          <div class="thread-row">
            <span class="thread-preview"></span>
          </div>
        </div>
        <button class="call-back-btn"></button>`;
      const avatarEl = li.querySelector(".avatar");
      watchProfile(c.otherUid);
      paintAvatar(avatarEl, c.otherUid, c.otherNickname);
      li.querySelector(".thread-name").textContent = "@" + c.otherNickname;
      li.querySelector(".thread-time").textContent = formatThreadTime(c.ts);
      li.querySelector(".thread-preview").textContent = callLogText(c.fromMe, c.outcome, c.duration, c.media);
      const back = li.querySelector(".call-back-btn");
      back.textContent = c.media === "video" ? "📹" : "📞";
      back.title = c.media === "video" ? "Görüntülü ara" : "Sesli ara";
      back.addEventListener("click", e => {
        e.stopPropagation();
        startCall(c.otherUid, c.otherNickname, c.media === "video");
      });
      li.addEventListener("click", () => openConversation(c.convId, c.otherUid, c.otherNickname));
      threadListEl.appendChild(li);
    });
  }

  function renderThreadList() {
    threadListEl.innerHTML = "";
    if (mainTab === "calls") {
      renderCallsList();
      return;
    }
    if (mainTab === "contacts") {
      renderContactsList();
      return;
    }
    const pins = pinnedConvIds();
    const archived = archivedConvIds();
    const all = Array.from(conversations.values()).filter(c => !chatHiddenForMe(c));
    const archivedCount = all.filter(c => archived.includes(c.id)).length;
    if (showingArchived && !archivedCount) showingArchived = false;
    const filtering = threadFilter !== "all";
    const list = sortThreads(all.filter(c => filtering
      ? threadMatchesFilter(c) && !archived.includes(c.id)
      : archived.includes(c.id) === showingArchived), pins);
    if (!filtering && (showingArchived || archivedCount)) {
      const row = document.createElement("li");
      row.className = "archive-row";
      row.textContent = showingArchived ? "← Arşivlenmiş sohbetler" : "🗄️ Arşivlenmiş (" + archivedCount + ")";
      row.addEventListener("click", () => { showingArchived = !showingArchived; renderThreadList(); });
      threadListEl.appendChild(row);
      if (showingArchived) {
        const hint = document.createElement("li");
        hint.className = "archive-hint";
        hint.textContent = "Arşivlenen sohbetler ana listede görünmez ama silinmez; mesajlar gelmeye devam eder. Çıkarmak için sohbete uzun bas.";
        threadListEl.appendChild(hint);
      }
    }
    if (!list.length && (filtering || !archivedCount)) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = threadFilter === "unread" ? "Okunmamış sohbet yok."
        : threadFilter === "groups" ? "Henüz grup yok."
        : "Henüz sohbet yok. '+' ile bir kişinin kullanıcı adını ekle.";
      li.style.cursor = "default";
      threadListEl.appendChild(li);
      return;
    }
    list.forEach(conv => {
      const li = document.createElement("li");
      if (conv.unread > 0) li.classList.add("unread");
      li.classList.add("has-avatar");
      li.innerHTML = `
        <span class="avatar"></span>
        <div class="thread-body">
          <div class="thread-row">
            <span class="thread-name"></span>
            <span class="thread-time"></span>
          </div>
          <div class="thread-row">
            <span class="thread-preview"></span>
            <span class="thread-badge hidden">0</span>
          </div>
        </div>`;
      const avatarEl = li.querySelector(".avatar");
      if (conv.isGroup && conv.groupAvatar) {
        avatarEl.style.backgroundImage = 'url("' + conv.groupAvatar + '")';
      } else if (conv.isGroup) {
        avatarEl.textContent = "👥";
        avatarEl.style.backgroundColor = "#2a2e37";
      } else {
        watchProfile(conv.otherUid);
        paintAvatar(avatarEl, conv.otherUid, conv.otherNickname);
      }
      const displayName = conv.isGroup ? `👥 ${conv.groupName} (${conv.participants.length})` : "@" + conv.otherNickname;
      li.querySelector(".thread-name").textContent = displayName + (conv.muted ? " 🔕" : "");
      if (pins.includes(conv.id)) {
        li.classList.add("pinned");
        li.querySelector(".thread-time").textContent = "📌 ";
      }
      li.querySelector(".thread-time").textContent += formatThreadTime(conv.lastTs || conv.updatedAt);
      if (!conv.isGroup && myBlocked[conv.otherUid]) {
        li.classList.add("blocked");
        li.querySelector(".thread-preview").textContent = "🚫 Engellendi";
      } else {
        const previewEl = li.querySelector(".thread-preview");
        if (isChatLocked(conv.id)) previewEl.textContent = "🔒 Kilitli sohbet";
        else if (conv.lastPreview) appendFormatted(previewEl, conv.lastPreview);
        else previewEl.textContent = "Aç ve sohbet et";
        if (conv.lastIsMissedCall && !isChatLocked(conv.id)) li.classList.add("missed-call");
      }
      if (conv.unread > 0) {
        const badge = li.querySelector(".thread-badge");
        badge.textContent = (conv.lastMentionsMe ? "@ " : "") + (conv.unread > 99 ? "99+" : String(conv.unread));
        badge.classList.remove("hidden");
      }
      attachLongPress(li, () => showThreadActions(conv));
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
  // Opens the 1:1 chat with a user (creating it the first time).
  async function startConversationWith(otherUid, otherNickname) {
    const convId = convIdFor(myUid, otherUid);
    if (!conversations.has(convId)) {
      const data = {
        participants: [myUid, otherUid],
        participantNicknames: { [myUid]: myNickname, [otherUid]: otherNickname },
        unreadCount: { [myUid]: 0, [otherUid]: 0 },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (defaultDisappearingSeconds()) data.disappearingSeconds = defaultDisappearingSeconds();
      await fbDb.collection("conversations").doc(convId).set(data, { merge: true });
    }
    openConversation(convId, otherUid, otherNickname);
  }

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
      document.getElementById("new-thread-modal").classList.add("hidden");
      await startConversationWith(q.docs[0].id, q.docs[0].data().nickname);
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
        admins: [myUid],
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...(defaultDisappearingSeconds() ? { disappearingSeconds: defaultDisappearingSeconds() } : {}),
      });
      document.getElementById("new-group-modal").classList.add("hidden");
      openConversation(convRef.id, null, null, { isGroup: true, groupName, participants });
    } catch (e) {
      alert("Grup oluşturulamadı: " + e.message);
    }
  });

  function lockVault() {
    stopAllLiveLocations(); // while the keys are still there to write the last update
    forgetSearchAndLiveData();
    closePhotoEditor(null);
    closeQrModal();
    forgetStatusVideos();
    hideToast();
    ["event-modal", "storage-modal"].forEach(id => document.getElementById(id).classList.add("hidden"));
    ["sticker-picker", "broadcast-modal", "chat-unlock-modal", "contact-picker-modal"].forEach(id => document.getElementById(id).classList.add("hidden"));
    stopAllMessengerListeners();
    myPrivateKey = null;
    myPublicKey = null;
    // Nothing that can decrypt the vault, and nothing already decrypted,
    // stays in memory or on the page while locked; unlocking re-derives it.
    leaveComposer();
    hideActionSheet();
    closeImageViewer();
    mediaGallery.classList.add("hidden");
    forgetLargeFiles();
    showingArchived = false;
    currentLocalKey = null;
    currentBioKey = null;
    localSessionData = null;
    chunkedPlainCache.clear();
    currentMessages = [];
    messageListEl.innerHTML = "";
    document.getElementById("thread-list").innerHTML = "";
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
      writeLastSeen();
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
    document.getElementById("avatar-msg").textContent = "";
    renderMyProfile();
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
      msgEl.textContent = "Kullanıcı adı en az 3 karakter olmalı (harf, Türkçe harfler dahil, rakam, alt çizgi).";
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
    await saveLocalBlob(newKey, await sealSession(localSessionData || {}));
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
    const bioPlugin = biometricKeyPlugin();
    if (bioPlugin) {
      try {
        const { available } = await bioPlugin.available();
        if (!available) {
          msgEl.textContent = "Bu telefonda kayıtlı güçlü bir parmak izi/yüz tanıma yok. Önce telefon ayarlarından ekle.";
          return;
        }
        if (!currentLocalKey) return;
        const { secret, sealed } = await bioPlugin.enroll();
        currentBioKey = await bioKeyFromSecret(secret);
        localStorage.setItem(STORAGE_BIO_SEALED, sealed);
        await saveLocalBlob(currentLocalKey, await sealSession(localSessionData || {}));
        renderBiometricButtons();
        msgEl.textContent = "Biyometrik kilit açıldı: kasayı açmak için artık PIN'in yanında parmak izin de gerekiyor.";
      } catch (e) {
        msgEl.textContent = "Biyometrik kayıt başarısız: " + e.message;
      }
      return;
    }
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
    const enabled = biometricKeyPlugin()
      ? !!localStorage.getItem(STORAGE_BIO_SEALED)
      : !!localStorage.getItem(STORAGE_BIOMETRIC);
    document.getElementById("enable-biometric-btn").classList.toggle("hidden", enabled);
    document.getElementById("disable-biometric-btn").classList.toggle("hidden", !enabled);
  }

  document.getElementById("disable-biometric-btn").addEventListener("click", async () => {
    if (!confirm("Biyometrik onay kaldırılsın mı? Kilit yalnızca PIN ile açılacak.")) return;
    if (biometricKeyPlugin()) {
      if (!currentLocalKey) return;
      // Re-save the session without the biometric layer before dropping the key.
      currentBioKey = null;
      await saveLocalBlob(currentLocalKey, localSessionData || {});
      forgetBiometricKey();
    }
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
    forgetBiometricKey();
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
        else if (m.type === "audio") text = "🎤 Sesli mesaj";
        else if (m.type === "poll") text = "📊 Anket";
        else if (m.type === "location") text = "📍 Konum";
        else if (m.type === "contact") text = "👤 Kişi";
        else if (m.type === "livelocation") text = "📍 Canlı konum";
        else if (m.type === "sticker") text = "🌟 Çıkartma";
        else if (m.type === "event") text = "📅 Etkinlik";
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
    if (isChatLocked(convId) && !(await confirmChatUnlock())) {
      pendingJumpMsgId = null;
      return;
    }
    closeThreadSearch();
    leaveComposer();
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
    document.querySelector(".thread-header-titles").classList.add("clickable");
    const conv = conversations.get(convId);
    if (conv) conv.unread = 0;
    fbDb.collection("conversations").doc(convId).update({ [`unreadCount.${myUid}`]: 0 }).catch(() => {});
    if (activeIsGroup) {
      await Promise.all(activeOtherUids.map(u => getPublicKeyForUid(u)));
      threadTypingEl.classList.add("hidden");
      clearInterval(presenceTick);
      renderThreadHeaderProfile(); // groups show no avatar or presence
      // Not gated by updateBlockUi() for a group, so reset explicitly.
      messageInput.disabled = false;
      document.getElementById("message-send-btn").disabled = false;
      attachPhotoBtn.disabled = false;
      document.getElementById("composer-camera-btn").disabled = false;
      document.getElementById("voice-btn").disabled = false;
      threadBlockedBanner.classList.add("hidden");
    } else {
      await getPublicKeyForUid(otherUid);
      listenToTyping(convId, otherUid);
      startThreadPresence();
      updateBlockUi();
    }
    listenToMessages(convId);
    renderPinnedBar();
    hideMentionPicker();
    mediaGallery.classList.add("hidden");
    applyWallpaper();
    updateComposerMode();
    updateDisappearingUi();
    updateMuteUi();
  }

  /* ---------------- Statuses (24-hour stories) ----------------
     A status is encrypted like a message, for the author's 1:1 contacts
     (audience); it expires after 24 hours. Viewers add themselves to
     "viewers", so the author sees who looked at it. */

  const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
  const STATUS_SHOW_MS = 5000;
  const STATUS_COLORS = ["#2f6f4f", "#3b4f9a", "#8a3b6f", "#9a5b2f", "#2f7a8a", "#5a2f8a"];
  const statusStrip = document.getElementById("status-strip");
  const statusViewer = document.getElementById("status-viewer");
  const statusDocs = new Map(); // id -> { id, from, ts, expiresAt, viewers, raw }
  const statusPlain = new Map(); // id -> decrypted { kind, text, color, image } (or null on failure)
  let statusUnsubs = [];
  let statusTimer = null;
  let statusQueue = [];
  let statusIndex = 0;

  function statusAudience() {
    const uids = new Set();
    conversations.forEach(conv => {
      if (conv.isGroup) return;
      conv.participants.forEach(u => { if (u !== myUid && !myBlocked[u]) uids.add(u); });
    });
    const privacy = statusPrivacy();
    let list = [...uids];
    if (privacy.mode === "except") list = list.filter(u => !privacy.uids.includes(u));
    if (privacy.mode === "only") list = list.filter(u => privacy.uids.includes(u));
    return list.slice(0, 500);
  }

  function nicknameOf(uid) {
    if (uid === myUid) return myNickname;
    for (const conv of conversations.values()) {
      if (conv.participantNicknames && conv.participantNicknames[uid]) return conv.participantNicknames[uid];
    }
    return "?";
  }

  function liveStatuses(from) {
    const now = Date.now();
    return [...statusDocs.values()]
      .filter(s => s.from === from && s.expiresAt > now)
      .sort((a, b) => a.ts - b.ts);
  }

  function startStatusListeners() {
    stopStatusListeners();
    const onSnap = snap => {
      snap.docChanges().forEach(change => {
        const id = change.doc.id;
        if (change.type === "removed") {
          statusDocs.delete(id);
          statusPlain.delete(id);
          return;
        }
        const d = change.doc.data();
        const expiresAt = d.expiresAt && d.expiresAt.toMillis ? d.expiresAt.toMillis() : 0;
        if (expiresAt <= Date.now()) {
          // Nobody needs an expired status: its author tidies it away.
          if (d.from === myUid) deleteStatusWithChunks(change.doc.ref).catch(() => {});
          statusDocs.delete(id);
          return;
        }
        statusDocs.set(id, {
          id, from: d.from, expiresAt, raw: d, viewers: d.viewers || {},
          ts: d.ts && d.ts.toMillis ? d.ts.toMillis() : Date.now(),
        });
      });
      renderStatusStrip();
    };
    const onErr = err => console.error("status listener error", err);
    const col = fbDb.collection("statuses");
    statusUnsubs = [
      col.where("audience", "array-contains", myUid).onSnapshot(onSnap, onErr),
      col.where("from", "==", myUid).onSnapshot(onSnap, onErr),
    ];
  }

  function stopStatusListeners() {
    statusUnsubs.forEach(u => u());
    statusUnsubs = [];
    statusDocs.clear();
    statusPlain.clear();
    closeStatusViewer();
    statusStrip.innerHTML = "";
  }

  function renderStatusStrip() {
    if (!myUid) return;
    statusStrip.innerHTML = "";
    const mine = liveStatuses(myUid);
    statusStrip.appendChild(statusStripItem(myUid, "Durumum", mine.length ? false : null, mine.length === 0));
    const authors = new Set();
    statusDocs.forEach(s => { if (s.from !== myUid && !myBlocked[s.from]) authors.add(s.from); });
    const items = [...authors].map(uid => {
      const list = liveStatuses(uid);
      return { uid, list, unseen: list.some(s => !s.viewers[myUid]), latest: list.length ? list[list.length - 1].ts : 0 };
    }).filter(i => i.list.length);
    // Unseen first, newest first, like WhatsApp.
    items.sort((a, b) => (b.unseen - a.unseen) || (b.latest - a.latest));
    items.forEach(i => statusStrip.appendChild(statusStripItem(i.uid, nicknameOf(i.uid), i.unseen, false)));
  }

  function statusStripItem(uid, label, unseen, isAdd) {
    const btn = document.createElement("button");
    btn.className = "status-item";
    const ring = document.createElement("span");
    ring.className = "status-ring" + (unseen ? " unseen" : "") + (isAdd ? " status-add" : "");
    const av = document.createElement("span");
    av.className = "avatar";
    watchProfile(uid);
    paintAvatar(av, uid, uid === myUid ? myNickname : label);
    ring.appendChild(av);
    const name = document.createElement("span");
    name.className = "status-name";
    name.textContent = label;
    btn.append(ring, name);
    btn.addEventListener("click", () => {
      if (uid === myUid) {
        const mine = liveStatuses(myUid);
        if (!mine.length) { showAddStatusMenu(); return; }
        showActionSheet("Durumum", [
          { label: "Durumumu gör", run: () => openStatusViewer(myUid) },
          { label: "Yeni durum ekle", run: showAddStatusMenu },
        ]);
      } else {
        openStatusViewer(uid);
      }
    });
    return btn;
  }

  function showAddStatusMenu() {
    showActionSheet("Yeni durum (24 saat)", [
      { label: "✏️ Yazı", run: addTextStatus },
      { label: "🖼️ Fotoğraf", run: () => document.getElementById("status-photo-input").click() },
      { label: "🎬 Video (en fazla 30 sn)", run: () => document.getElementById("status-video-input").click() },
      { label: "🔒 Durum gizliliği", run: showStatusPrivacyMenu },
    ]);
  }

  async function postStatus(payload) {
    const audience = statusAudience();
    if (!audience.length) {
      alert("Durum paylaşmak için önce en az bir kişiyle sohbetin olmalı.");
      return;
    }
    const key = await makeMessageKey(audience);
    if (!key) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key.aesKey, new TextEncoder().encode(JSON.stringify(payload))
    );
    try {
      await fbDb.collection("statuses").add({
        from: myUid,
        audience,
        kind: payload.kind,
        iv: b64encode(iv.buffer),
        ciphertext: b64encode(ciphertext),
        wrappedKeys: key.wrappedKeys,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
        expiresAt: firebase.firestore.Timestamp.fromMillis(Date.now() + STATUS_TTL_MS),
      });
    } catch (e) {
      alert(e && e.code === "permission-denied"
        ? "Paylaşılamadı: Firestore kurallarının güncellenmesi gerekiyor."
        : "Paylaşılamadı: " + e.message);
    }
  }

  function addTextStatus() {
    const text = prompt("Durumun:");
    if (text === null || !text.trim()) return;
    const color = STATUS_COLORS[Math.floor(Math.random() * STATUS_COLORS.length)];
    postStatus({ kind: "text", text: text.trim().slice(0, 700), color });
  }

  // A Firestore document is capped at 1MiB, so status photos are scaled
  // down until their (base64, encrypted) form fits comfortably.
  async function statusPhotoDataUrl(file) {
    const img = await new Promise((resolve, reject) => {
      readAsDataUrl(file).then(url => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("bu fotoğraf açılamadı"));
        i.src = url;
      }, reject);
    });
    let side = 1280;
    let quality = 0.8;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const jpeg = canvas.toDataURL("image/jpeg", quality);
      if (jpeg.length < 600000) return jpeg;
      side = Math.round(side * 0.8);
      quality = Math.max(0.5, quality - 0.08);
    }
    throw new Error("fotoğraf çok büyük");
  }

  document.getElementById("status-photo-input").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const image = await statusPhotoDataUrl(file);
      const caption = prompt("Açıklama (isteğe bağlı):") || "";
      await postStatus({ kind: "image", image, text: caption.trim().slice(0, 300) });
    } catch (err) {
      alert("Durum paylaşılamadı: " + err.message);
    }
  });

  async function decryptStatus(s) {
    if (statusPlain.has(s.id)) return statusPlain.get(s.id);
    let plain = null;
    try {
      plain = parseJson(await decryptMessage(s.raw));
    } catch (e) {
      plain = null;
    }
    statusPlain.set(s.id, plain);
    return plain;
  }

  function openStatusViewer(uid) {
    statusQueue = liveStatuses(uid);
    if (!statusQueue.length) return;
    // Start at the first one not seen yet.
    const firstUnseen = uid === myUid ? -1 : statusQueue.findIndex(s => !s.viewers[myUid]);
    statusIndex = firstUnseen >= 0 ? firstUnseen : 0;
    document.getElementById("status-author-name").textContent = uid === myUid ? "Durumum" : "@" + nicknameOf(uid);
    paintAvatar(document.getElementById("status-author-avatar"), uid, nicknameOf(uid));
    statusViewer.classList.remove("hidden");
    showStatusAt(statusIndex);
  }

  function closeStatusViewer() {
    clearTimeout(statusTimer);
    statusTimer = null;
    statusQueue = [];
    statusViewer.classList.add("hidden");
    document.getElementById("status-content").innerHTML = "";
  }

  async function showStatusAt(i) {
    clearTimeout(statusTimer);
    if (i < 0) i = 0;
    if (i >= statusQueue.length) { closeStatusViewer(); return; }
    statusIndex = i;
    const s = statusQueue[i];
    const progress = document.getElementById("status-progress");
    progress.innerHTML = "";
    statusQueue.forEach((_, j) => {
      const bar = document.createElement("span");
      if (j < i) bar.className = "done";
      const fill = document.createElement("i");
      if (j === i) {
        fill.style.transition = `width ${STATUS_SHOW_MS}ms linear`;
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = "100%"; }));
      }
      bar.appendChild(fill);
      progress.appendChild(bar);
    });
    const hoursAgo = Math.floor((Date.now() - s.ts) / 3600000);
    const minsAgo = Math.floor((Date.now() - s.ts) / 60000);
    document.getElementById("status-time").textContent =
      hoursAgo >= 1 ? hoursAgo + " saat önce" : minsAgo >= 1 ? minsAgo + " dakika önce" : "az önce";
    const content = document.getElementById("status-content");
    content.innerHTML = "";
    const plain = await decryptStatus(s);
    if (statusQueue[statusIndex] !== s) return; // moved on while decrypting
    if (!plain) {
      const t = document.createElement("div");
      t.className = "status-text";
      t.textContent = "🔒 Bu durum açılamadı";
      content.appendChild(t);
    } else if (plain.kind === "video" && Number.isInteger(plain.n) && typeof plain.vIv === "string") {
      const wait = document.createElement("div");
      wait.className = "status-text";
      wait.textContent = "🎬 Video yükleniyor…";
      content.appendChild(wait);
      let url = null;
      try {
        url = await statusVideoUrl(s, plain);
      } catch (e) {
        wait.textContent = "🎬 Video açılamadı";
      }
      if (statusQueue[statusIndex] !== s) return;
      if (url) {
        content.innerHTML = "";
        const video = document.createElement("video");
        video.src = url;
        video.playsInline = true;
        video.autoplay = true;
        content.appendChild(video);
        if (plain.text) {
          const cap = document.createElement("div");
          cap.className = "status-caption";
          cap.textContent = plain.text;
          content.appendChild(cap);
        }
        const fill = document.querySelector("#status-progress span:nth-child(" + (statusIndex + 1) + ") i");
        if (fill) fill.style.transition = "none";
        video.addEventListener("timeupdate", () => {
          if (fill && video.duration) fill.style.width = (video.currentTime / video.duration * 100) + "%";
        });
        video.addEventListener("ended", () => { if (statusQueue[statusIndex] === s) showStatusAt(statusIndex + 1); });
        // Autoplay with sound can be refused: play muted then.
        video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
      }
    } else if (plain.kind === "image" && typeof plain.image === "string" && plain.image.startsWith("data:image/")) {
      const img = document.createElement("img");
      img.src = plain.image;
      img.alt = "";
      content.appendChild(img);
      if (plain.text) {
        const cap = document.createElement("div");
        cap.className = "status-caption";
        cap.textContent = plain.text;
        content.appendChild(cap);
      }
    } else {
      const t = document.createElement("div");
      t.className = "status-text";
      t.style.backgroundColor = STATUS_COLORS.includes(plain.color) ? plain.color : STATUS_COLORS[0];
      t.textContent = String(plain.text || "");
      content.appendChild(t);
    }
    const mine = s.from === myUid;
    document.getElementById("status-bottom").classList.toggle("hidden", !mine);
    statusReplyEl.classList.toggle("hidden", mine);
    if (mine) {
      const n = Object.keys(s.viewers).length;
      document.getElementById("status-viewers-btn").textContent = "👁 " + n + " görüntüleme";
    } else if (!s.viewers[myUid]) {
      s.viewers[myUid] = true;
      fbDb.collection("statuses").doc(s.id)
        .update({ [`viewers.${myUid}`]: firebase.firestore.FieldValue.serverTimestamp() })
        .catch(() => {});
    }
    // A video moves on when it ends (see above).
    if (!(plain && plain.kind === "video")) statusTimer = setTimeout(() => showStatusAt(statusIndex + 1), STATUS_SHOW_MS);
  }

  document.getElementById("status-close").addEventListener("click", closeStatusViewer);
  document.getElementById("status-content").addEventListener("click", e => {
    const rect = e.currentTarget.getBoundingClientRect();
    showStatusAt(statusIndex + (e.clientX - rect.left < rect.width / 3 ? -1 : 1));
  });
  document.getElementById("status-viewers-btn").addEventListener("click", () => {
    const s = statusQueue[statusIndex];
    if (!s) return;
    clearTimeout(statusTimer);
    const names = Object.keys(s.viewers).map(u => "@" + nicknameOf(u));
    alert(names.length ? "Görenler:\n" + names.join("\n") : "Henüz kimse görmedi.");
    statusTimer = setTimeout(() => showStatusAt(statusIndex + 1), STATUS_SHOW_MS);
  });
  document.getElementById("status-delete-btn").addEventListener("click", async () => {
    const s = statusQueue[statusIndex];
    if (!s) return;
    clearTimeout(statusTimer);
    if (!confirm("Bu durum silinsin mi?")) {
      statusTimer = setTimeout(() => showStatusAt(statusIndex + 1), STATUS_SHOW_MS);
      return;
    }
    try {
      await deleteStatusWithChunks(fbDb.collection("statuses").doc(s.id));
    } catch (e) {
      alert("Silinemedi: " + e.message);
    }
    statusQueue.splice(statusIndex, 1);
    showStatusAt(statusIndex);
  });

  /* ---------------- Group info and management ----------------
     Admins (conversation.admins; for older groups the creator) can rename
     the group, set its photo, add/remove members and make admins; anyone
     can leave. firestore.rules enforces the same. New members only get
     the keys of messages sent after they join. */

  const groupInfoModal = document.getElementById("group-info-modal");

  function activeGroup() {
    return activeIsGroup && activeConvId ? conversations.get(activeConvId) : null;
  }

  function amGroupAdmin(conv) {
    return !!(conv && conv.admins.includes(myUid));
  }

  // The open group's members changed: send to the current member list.
  function syncActiveGroup() {
    const conv = activeGroup();
    if (!conv) return;
    activeOtherUids = conv.participants.filter(u => u !== myUid);
    activeOtherUids.forEach(u => getPublicKeyForUid(u));
    document.getElementById("thread-title").textContent = `👥 ${conv.groupName} (${conv.participants.length})`;
    renderThreadHeaderProfile();
    if (!groupInfoModal.classList.contains("hidden")) renderGroupInfo();
  }

  async function updateGroup(fields) {
    const conv = activeGroup();
    if (!conv) return false;
    try {
      // Always write admins too, so older groups get the field the rules check.
      await fbDb.collection("conversations").doc(conv.id).update({ admins: conv.admins, ...fields });
      return true;
    } catch (e) {
      alert(e && e.code === "permission-denied"
        ? "Yapılamadı: yönetici değilsin ya da Firestore kurallarının güncellenmesi gerekiyor."
        : "Yapılamadı: " + e.message);
      return false;
    }
  }

  function renderGroupInfo() {
    const conv = activeGroup();
    if (!conv) return;
    const isAdmin = amGroupAdmin(conv);
    const avatar = document.getElementById("group-info-avatar");
    if (conv.groupAvatar) {
      avatar.style.backgroundImage = 'url("' + conv.groupAvatar + '")';
      avatar.textContent = "";
    } else {
      avatar.style.backgroundImage = "";
      avatar.textContent = "👥";
    }
    document.getElementById("group-info-name").textContent = conv.groupName || "Grup";
    document.getElementById("group-info-admin-actions").classList.toggle("hidden", !isAdmin);
    document.getElementById("group-info-count").textContent = conv.participants.length + " üye";
    const list = document.getElementById("group-info-members");
    list.innerHTML = "";
    conv.participants.forEach(uid => {
      const li = document.createElement("li");
      const av = document.createElement("span");
      av.className = "avatar small";
      const name = uid === myUid ? myNickname : (conv.participantNicknames[uid] || "?");
      watchProfile(uid);
      paintAvatar(av, uid, name);
      const label = document.createElement("span");
      label.className = "member-name";
      label.textContent = "@" + name + (uid === myUid ? " (sen)" : "");
      li.append(av, label);
      if (conv.admins.includes(uid)) {
        const badge = document.createElement("span");
        badge.className = "member-badge";
        badge.textContent = "Yönetici";
        li.appendChild(badge);
      }
      if (isAdmin && uid !== myUid) li.addEventListener("click", () => showMemberActions(conv, uid, name));
      list.appendChild(li);
    });
  }

  function showMemberActions(conv, uid, name) {
    const isMemberAdmin = conv.admins.includes(uid);
    showActionSheet("@" + name, [
      isMemberAdmin
        ? { label: "Yöneticilikten çıkar", run: () => updateGroup({ admins: conv.admins.filter(a => a !== uid) }) }
        : { label: "Yönetici yap", run: () => updateGroup({ admins: [...conv.admins, uid] }) },
      { label: "Gruptan çıkar", danger: true, run: () => {
        if (!confirm("@" + name + " gruptan çıkarılsın mı?")) return;
        updateGroup({
          participants: conv.participants.filter(u => u !== uid),
          admins: conv.admins.filter(a => a !== uid),
        });
      } },
    ]);
  }

  document.querySelector(".thread-header-titles").addEventListener("click", () => openChatMenu());
  document.getElementById("group-info-close").addEventListener("click", () => groupInfoModal.classList.add("hidden"));

  document.getElementById("group-rename-btn").addEventListener("click", () => {
    const conv = activeGroup();
    if (!conv) return;
    const name = prompt("Yeni grup adı:", conv.groupName || "");
    if (name === null) return;
    const trimmed = name.trim().slice(0, 60);
    if (trimmed && trimmed !== conv.groupName) updateGroup({ groupName: trimmed });
  });

  const groupPhotoInput = document.getElementById("group-photo-input");
  document.getElementById("group-photo-btn").addEventListener("click", () => groupPhotoInput.click());
  groupPhotoInput.addEventListener("change", async () => {
    const file = groupPhotoInput.files[0];
    groupPhotoInput.value = "";
    if (!file) return;
    try {
      await updateGroup({ groupAvatar: await makeAvatar(file) });
    } catch (e) {
      alert("Fotoğraf ayarlanamadı: " + e.message);
    }
  });

  document.getElementById("group-add-member-btn").addEventListener("click", async () => {
    const conv = activeGroup();
    if (!conv) return;
    const raw = prompt("Eklenecek kişinin kullanıcı adı:");
    if (raw === null) return;
    const nickname = normalizeNickname(raw);
    if (!nickname) return;
    if (conv.participants.length >= 20) {
      alert("Bir grupta en fazla 20 kişi olabilir.");
      return;
    }
    try {
      const q = await fbDb.collection("users").where("nickname", "==", nickname).limit(1).get();
      if (q.empty) {
        alert("Bu kullanıcı adıyla kayıtlı bir kullanıcı bulunamadı.");
        return;
      }
      const uid = q.docs[0].id;
      if (conv.participants.includes(uid)) {
        alert("Bu kişi zaten grupta.");
        return;
      }
      await updateGroup({
        participants: [...conv.participants, uid],
        [`participantNicknames.${uid}`]: q.docs[0].data().nickname,
        [`unreadCount.${uid}`]: 0,
      });
    } catch (e) {
      alert("Eklenemedi: " + e.message);
    }
  });

  document.getElementById("group-leave-btn").addEventListener("click", async () => {
    const conv = activeGroup();
    if (!conv || !confirm("Bu gruptan çıkılsın mı? Grubun yeni mesajlarını göremeyeceksin.")) return;
    const remaining = conv.participants.filter(u => u !== myUid);
    const update = { participants: remaining };
    if (amGroupAdmin(conv)) {
      // Don't leave a group without an admin: hand it to the next member.
      const admins = conv.admins.filter(a => a !== myUid);
      update.admins = admins.length || !remaining.length ? admins : [remaining[0]];
    }
    try {
      await fbDb.collection("conversations").doc(conv.id).update(update);
      groupInfoModal.classList.add("hidden");
    } catch (e) {
      alert("Gruptan çıkılamadı: " + e.message);
    }
  });

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
    document.getElementById("composer-camera-btn").disabled = isBlocked;
    document.getElementById("voice-btn").disabled = isBlocked;
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
    callFlipBtn.classList.toggle("hidden", !isVideoCall);
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
    // Tells the caller it is ringing here ("Çalıyor...").
    fbDb.collection("calls").doc(callId).update({ ringing: true }).catch(() => {});
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

  // Like WhatsApp: "Aranıyor..." until the call reaches the other phone,
  // then "Çalıyor...". It has reached it when their app shows the call
  // (it sets ringing on the call doc) or the push server delivered the
  // call notification to at least one of their devices.
  function showRemoteRinging(callId) {
    if (callId !== activeCallId || activeCallRole !== "caller" || callWasConnected) return;
    callStatusEl.textContent = isVideoCall ? "Görüntülü · Çalıyor..." : "Çalıyor...";
  }

  function ringPush(callId) {
    requestPush({ kind: "call", callId }).then(r => {
      if (r && r.data && r.data.sent > 0) showRemoteRinging(callId);
    });
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
    if (preset.native) {
      const plugin = alarmSoundPlugin();
      if (plugin) plugin.play({ loop: true }).catch(() => {});
      return;
    }
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
    const plugin = alarmSoundPlugin();
    if (plugin) plugin.stop().catch(() => {}); // harmless when nothing is playing
    if (ringToneTimer) { clearInterval(ringToneTimer); ringToneTimer = null; }
    if (ringToneCtx) { ringToneCtx.close().catch(() => {}); ringToneCtx = null; }
  }

  async function getMic(withVideo) {
    cameraFacing = "user";
    callLocalVideo.classList.remove("rear");
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
      if (activeCallRole === "caller" && data.status === "ringing" && data.ringing) showRemoteRinging(callId);
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

      ringPush(callDocRef.id);
      callRingPushTimer = setInterval(() => {
        if (activeCallId !== callDocRef.id || callWasConnected) {
          clearInterval(callRingPushTimer);
          callRingPushTimer = null;
          return;
        }
        ringPush(callDocRef.id);
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

  /* ---------------- Profiles: photo and online / last seen ----------------
     Stored on users/{uid} (readable by every signed-in user, like WhatsApp's
     "everyone" setting): avatar (a small JPEG data URL), lastSeen (a server
     timestamp refreshed every minute while the messenger is open) and
     hidePresence. As in WhatsApp, hiding your own presence also hides
     everyone else's from you. Needs the users rule in firestore.rules. */

  const PRESENCE_HEARTBEAT_MS = 60 * 1000;
  const PRESENCE_ONLINE_MS = 75 * 1000; // a missed heartbeat or two still counts as online
  const AVATAR_SIDE = 128;
  const AVATAR_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
  const profiles = new Map(); // uid -> { avatar, lastSeen, hidePresence }
  const profileUnsubs = new Map();
  let presenceHeartbeat = null;
  let presenceTick = null;
  let myPresenceKnown = false;
  let threadListRenderQueued = false;

  function myHideReadReceipts() {
    const me = profiles.get(myUid);
    return !!(me && me.hideReadReceipts);
  }

  function myHidePresence() {
    const me = profiles.get(myUid);
    return !!(me && me.hidePresence);
  }

  function watchProfile(uid) {
    if (!uid || profileUnsubs.has(uid)) return;
    const unsub = fbDb.collection("users").doc(uid).onSnapshot(doc => {
      const d = doc.data() || {};
      profiles.set(uid, {
        // Only our own JPEG data URLs: anything else (e.g. a remote URL that
        // would reveal the viewer's IP) is ignored.
        avatar: typeof d.avatar === "string" && AVATAR_RE.test(d.avatar) ? d.avatar : null,
        lastSeen: d.lastSeen && d.lastSeen.toMillis ? d.lastSeen.toMillis() : null,
        hidePresence: !!d.hidePresence,
        hideReadReceipts: !!d.hideReadReceipts,
        about: typeof d.about === "string" ? d.about.slice(0, 140) : "",
      });
      onProfileChanged(uid);
    }, () => {});
    profileUnsubs.set(uid, unsub);
  }

  function onProfileChanged(uid) {
    if (uid === myUid) {
      renderMyProfile();
      if (!myPresenceKnown) {
        myPresenceKnown = true;
        writeLastSeen();
      }
    }
    if (activeConvId && !activeIsGroup && (uid === activeOtherUid || uid === myUid)) renderThreadHeaderProfile();
    if (!threadListPanel.classList.contains("hidden") && !threadListRenderQueued) {
      threadListRenderQueued = true;
      requestAnimationFrame(() => { threadListRenderQueued = false; renderThreadList(); });
    }
  }

  function startPresence() {
    stopPresence();
    myPresenceKnown = false;
    watchProfile(myUid); // its first snapshot tells whether to write lastSeen
    presenceHeartbeat = setInterval(writeLastSeen, PRESENCE_HEARTBEAT_MS);
  }

  function stopPresence() {
    clearInterval(presenceHeartbeat);
    presenceHeartbeat = null;
    clearInterval(presenceTick);
    presenceTick = null;
    profileUnsubs.forEach(unsub => unsub());
    profileUnsubs.clear();
    profiles.clear();
    myPresenceKnown = false;
  }

  function writeLastSeen() {
    if (!myUid || !myPresenceKnown || myHidePresence() || document.hidden) return;
    fbDb.collection("users").doc(myUid)
      .update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  }

  function presenceText(uid) {
    const p = profiles.get(uid);
    if (!p || !p.lastSeen || p.hidePresence || myHidePresence()) return null;
    if (Date.now() - p.lastSeen < PRESENCE_ONLINE_MS) return "çevrimiçi";
    const seen = new Date(p.lastSeen);
    const time = seen.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    let day;
    if (seen.toDateString() === today.toDateString()) day = "bugün";
    else if (seen.toDateString() === yesterday.toDateString()) day = "dün";
    else day = seen.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" });
    return "son görülme: " + day + " " + time;
  }

  function avatarColor(uid) {
    let h = 0;
    for (const ch of String(uid || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return "hsl(" + h + ", 45%, 42%)";
  }

  function paintAvatar(el, uid, name) {
    const p = profiles.get(uid);
    if (p && p.avatar) {
      el.style.backgroundImage = 'url("' + p.avatar + '")';
      el.style.backgroundColor = "";
      el.textContent = "";
    } else {
      el.style.backgroundImage = "";
      el.style.backgroundColor = avatarColor(uid);
      el.textContent = String(name || "?").replace(/^@/, "").charAt(0).toUpperCase() || "?";
    }
  }

  const threadAvatarEl = document.getElementById("thread-avatar");
  const threadPresenceEl = document.getElementById("thread-presence");

  function renderThreadHeaderProfile() {
    const activeConv = activeConvId ? conversations.get(activeConvId) : null;
    if (activeIsGroup && activeConv && activeConv.groupAvatar) {
      threadAvatarEl.classList.remove("hidden");
      threadAvatarEl.style.backgroundImage = 'url("' + activeConv.groupAvatar + '")';
      threadAvatarEl.textContent = "";
      threadPresenceEl.classList.add("hidden");
      return;
    }
    if (!activeConvId || activeIsGroup || !activeOtherUid) {
      threadAvatarEl.classList.add("hidden");
      threadPresenceEl.classList.add("hidden");
      return;
    }
    const conv = conversations.get(activeConvId);
    threadAvatarEl.classList.remove("hidden");
    paintAvatar(threadAvatarEl, activeOtherUid, conv && conv.otherNickname);
    const text = presenceText(activeOtherUid);
    threadPresenceEl.textContent = text || "";
    threadPresenceEl.classList.toggle("hidden", !text);
  }

  function startThreadPresence() {
    clearInterval(presenceTick);
    if (activeOtherUid && !activeIsGroup) watchProfile(activeOtherUid);
    renderThreadHeaderProfile();
    // "çevrimiçi" turns into "son görülme" by time alone, so re-check.
    presenceTick = setInterval(renderThreadHeaderProfile, 30 * 1000);
  }

  function renderMyProfile() {
    const el = document.getElementById("my-avatar");
    if (el && myUid) paintAvatar(el, myUid, myNickname);
    const p = profiles.get(myUid);
    document.getElementById("avatar-remove-btn").classList.toggle("hidden", !(p && p.avatar));
    document.getElementById("presence-toggle").checked = !myHidePresence();
    document.getElementById("read-receipts-toggle").checked = !myHideReadReceipts();
    const aboutInput = document.getElementById("about-input");
    if (document.activeElement !== aboutInput) aboutInput.value = aboutOf(myUid);
    defaultDisappearingEl.value = String(defaultDisappearingSeconds());
  }

  function profileSaveError(e) {
    return e && e.code === "permission-denied"
      ? "Kaydedilemedi: Firestore kurallarının güncellenmesi gerekiyor (README > Firestore güvenlik kuralları)."
      : "Kaydedilemedi: " + (e && e.message);
  }

  // Centre-crops to a square and scales to AVATAR_SIDE, as a small JPEG.
  async function makeAvatar(file) {
    const dataUrl = await readAsDataUrl(file);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("bu fotoğraf açılamadı"));
      i.src = dataUrl;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIDE;
    canvas.getContext("2d").drawImage(img,
      (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
      0, 0, AVATAR_SIDE, AVATAR_SIDE);
    return canvas.toDataURL("image/jpeg", 0.8);
  }

  const avatarInput = document.getElementById("avatar-input");
  document.getElementById("avatar-pick-btn").addEventListener("click", () => avatarInput.click());
  avatarInput.addEventListener("change", async () => {
    const file = avatarInput.files[0];
    avatarInput.value = "";
    if (!file) return;
    const msgEl = document.getElementById("avatar-msg");
    try {
      const avatar = await makeAvatar(file);
      await fbDb.collection("users").doc(myUid).update({ avatar });
      msgEl.textContent = "Profil fotoğrafı güncellendi.";
    } catch (e) {
      msgEl.textContent = profileSaveError(e);
    }
  });
  document.getElementById("avatar-remove-btn").addEventListener("click", async () => {
    const msgEl = document.getElementById("avatar-msg");
    try {
      await fbDb.collection("users").doc(myUid).update({ avatar: firebase.firestore.FieldValue.delete() });
      msgEl.textContent = "Profil fotoğrafı kaldırıldı.";
    } catch (e) {
      msgEl.textContent = profileSaveError(e);
    }
  });
  document.getElementById("presence-toggle").addEventListener("change", async (e) => {
    const show = e.target.checked;
    const msgEl = document.getElementById("avatar-msg");
    try {
      await fbDb.collection("users").doc(myUid).update({
        hidePresence: !show,
        // Hiding also removes the last timestamp, so it isn't left behind.
        lastSeen: show ? firebase.firestore.FieldValue.serverTimestamp() : firebase.firestore.FieldValue.delete(),
      });
      msgEl.textContent = show ? "Çevrimiçi bilgin artık görünüyor." : "Çevrimiçi bilgin gizlendi.";
    } catch (err) {
      e.target.checked = !show;
      msgEl.textContent = profileSaveError(err);
    }
  });

  document.getElementById("read-receipts-toggle").addEventListener("change", async (e) => {
    const send = e.target.checked;
    const msgEl = document.getElementById("avatar-msg");
    try {
      await fbDb.collection("users").doc(myUid).update({ hideReadReceipts: !send });
      msgEl.textContent = send ? "Okundu bilgisi artık gönderiliyor." : "Okundu bilgisi kapatıldı.";
      if (activeConvId) renderMessages(currentMessages);
    } catch (err) {
      e.target.checked = !send;
      msgEl.textContent = profileSaveError(err);
    }
  });

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
        // Group read receipts are written only for recent messages, so opening
        // an old group doesn't send hundreds of writes for messages from before.
        const receiptFrom = snap.docs.length - GROUP_RECEIPT_RECENT;
        for (const [docIdx, doc] of snap.docs.entries()) {
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
            // With read receipts off, only "reached my phone" is sent.
            if (!myHideReadReceipts()) doc.ref.update({ read: true, delivered: true }).catch(() => {});
            else if (!d.delivered) doc.ref.update({ delivered: true }).catch(() => {});
          }
          if (activeIsGroup && d.from !== myUid && docIdx >= receiptFrom && !(d.readBy && d.readBy[myUid])) {
            const now = firebase.firestore.FieldValue.serverTimestamp();
            const receipt = { [`readBy.${myUid}`]: now };
            if (!(d.deliveredTo && d.deliveredTo[myUid])) receipt[`deliveredTo.${myUid}`] = now;
            doc.ref.update(receipt).catch(() => {});
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
            text: ["image", "file", "call", "audio", "poll", "location", "contact", "livelocation", "sticker", "event"].includes(d.type) ? null : plain,
            liveLocation: d.type === "livelocation" ? parseJson(plain) : null,
            event: d.type === "event" ? parseJson(plain) : null,
            rsvp: d.rsvp || {},
            sticker: d.type === "sticker" && isSticker(plain) ? plain : null,
            contact: d.type === "contact" ? parseJson(plain) : null,
            mentions: Array.isArray(d.mentions) ? d.mentions : [],
            readBy: receiptTimes(d.readBy),
            deliveredTo: receiptTimes(d.deliveredTo),
            played: !!d.played,
            poll: d.type === "poll" ? parseJson(plain) : null,
            votes: d.votes || {},
            location: d.type === "location" ? parseJson(plain) : null,
            delivered: !!d.delivered,
            image: d.type === "image" ? plain : null,
            audio: d.type === "audio" ? plain : null,
            replyTo: d.replyTo || null,
            viewOnce: !!d.viewOnce,
            file,
            call,
            ts: d.ts ? d.ts.toMillis() : Date.now(),
            read: !!d.read,
            expiresAtMillis,
            chunked: d.chunked || null,
            wrappedKey: (d.wrappedKeys && d.wrappedKeys[myUid]) || null,
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
  let starredOnly = false;
  const threadStarredBtn = document.getElementById("thread-starred-btn");
  threadStarredBtn.addEventListener("click", () => {
    starredOnly = !starredOnly;
    threadStarredBtn.classList.toggle("active", starredOnly);
    renderMessages(currentMessages);
  });

  function closeThreadSearch() {
    threadSearchBar.classList.add("hidden");
    threadSearchInput.value = "";
    searchQuery = "";
    starredOnly = false;
    threadStarredBtn.classList.remove("active");
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

  const LINK_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,:;'!?)\]]/g;

  // Plain text with http(s) links made tappable.
  // WhatsApp-style formatting: *kalın*, _italik_, ~üstü çizili~, `kod`.
  // A marker only counts at a word edge and around non-blank text, so
  // "2*3*4" or "dosya_adi_1" stay as typed. Links are never formatted.
  const FORMAT_RE = /(^|[\s.,!?;:'"(\[])([*_~`])(?!\s)([^\n]*?[^\s])\2(?=$|[\s.,!?;:'")\]])/;
  const FORMAT_TAGS = { "*": "strong", "_": "em", "~": "s", "`": "code" };

  function appendFormatted(container, text) {
    const m = FORMAT_RE.exec(text);
    if (!m) {
      if (text) container.appendChild(document.createTextNode(text));
      return;
    }
    const start = m.index + m[1].length;
    if (start) container.appendChild(document.createTextNode(text.slice(0, start)));
    const el = document.createElement(FORMAT_TAGS[m[2]]);
    if (m[2] === "`") el.textContent = m[3]; // nothing is formatted inside code
    else appendFormatted(el, m[3]);
    container.appendChild(el);
    appendFormatted(container, text.slice(m.index + m[0].length));
  }

  function appendLinkified(container, text) {
    let cursor = 0;
    for (const match of text.matchAll(LINK_RE)) {
      appendFormatted(container, text.slice(cursor, match.index));
      const a = document.createElement("a");
      a.className = "msg-link";
      a.href = match[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[0];
      container.appendChild(a);
      cursor = match.index + match[0].length;
    }
    appendFormatted(container, text.slice(cursor));
  }

  function appendHighlightedText(container, text, query) {
    if (!query) {
      appendLinkified(container, text);
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
    // Binary (large file) chunks are only fetched on tap; the message itself holds the metadata.
    const ciphertext = d.chunked && !d.chunked.bin ? await readChunkedCiphertext(d.chunked) : d.ciphertext;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64decode(d.iv)) },
      aesKey,
      b64decode(ciphertext)
    );
    const text = new TextDecoder().decode(plain);
    if (d.chunked && !d.chunked.bin) chunkedPlainCache.set(d.chunked.id, text);
    return text;
  }

  /* ---------------- Replies ----------------
     A reply stores only the replied-to message's id (replyTo, outside the
     encryption: an id reveals nothing). The quote is built locally from the
     already-decrypted copy, so it can never show anything the reader
     couldn't already read. */

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function messageSnippet(m) {
    if (!m) return "Mesaj bulunamadı";
    if (m.deleted) return "Bu mesaj silindi";
    if (m.poll) return "📊 " + (m.poll.question || "Anket");
    if (m.location) return "📍 Konum";
    if (m.contact) return "👤 @" + (m.contact.nickname || "kişi");
    if (m.liveLocation) return "📍 Canlı konum";
    if (m.sticker) return "🌟 Çıkartma";
    if (m.event) return "📅 " + (m.event.title || "Etkinlik");
    if (m.image) return "📷 Fotoğraf";
    if (m.audio) return "🎤 Sesli mesaj";
    if (m.file) return "📄 " + (m.file.name || "Dosya");
    if (m.call) return "📞 Arama";
    return m.text || "";
  }

  function messageSenderName(m) {
    if (!m) return "";
    if (m.from === "me") return "Sen";
    if (m.fromNickname) return "@" + m.fromNickname;
    const conv = conversations.get(activeConvId);
    return conv && conv.otherNickname ? "@" + conv.otherNickname : "";
  }

  function renderQuote(original, id) {
    const quote = document.createElement("span");
    quote.className = "msg-quote";
    quote.dataset.quoteOf = id;
    const sender = document.createElement("span");
    sender.className = "msg-quote-sender";
    sender.textContent = messageSenderName(original);
    const text = document.createElement("span");
    text.className = "msg-quote-text";
    text.textContent = messageSnippet(original);
    quote.appendChild(sender);
    quote.appendChild(text);
    return quote;
  }

  let replyingToId = null;
  const replyBar = document.getElementById("reply-bar");

  function startReply(msgId) {
    const m = currentMessages.find(x => x.id === msgId);
    if (!m) return;
    replyingToId = msgId;
    document.getElementById("reply-bar-sender").textContent = messageSenderName(m);
    document.getElementById("reply-bar-snippet").textContent = messageSnippet(m);
    replyBar.classList.remove("hidden");
    messageInput.focus();
  }

  function cancelReply() {
    replyingToId = null;
    replyBar.classList.add("hidden");
  }

  // Extra message fields for the next send; consumes the pending reply.
  function takeReplyFields() {
    const fields = replyingToId ? { replyTo: replyingToId } : null;
    cancelReply();
    return fields;
  }

  document.getElementById("reply-bar-cancel").addEventListener("click", cancelReply);

  /* ---------------- Polls and locations ---------------- */

  // A poll's question and options are encrypted like any message; votes
  // are { uid: optionIndex } on the message, each person changing only
  // their own (firestore.rules). An index alone reveals nothing.
  function renderPoll(m) {
    const box = document.createElement("div");
    const q = document.createElement("span");
    q.className = "poll-question";
    q.textContent = "📊 " + (m.poll.question || "");
    box.appendChild(q);
    // A vote is one option index, or a list of them in a multiple-choice poll.
    const choices = Object.values(m.votes || {}).map(pollChoices).filter(c => c.length);
    const mineChoices = pollChoices((m.votes || {})[myUid]);
    const total = choices.length;
    if (m.poll.multi) {
      const hint = document.createElement("span");
      hint.className = "poll-total";
      hint.textContent = "Birden fazla seçebilirsin";
      box.appendChild(hint);
    }
    (m.poll.options || []).forEach((opt, idx) => {
      const count = choices.filter(c => c.includes(idx)).length;
      const btn = document.createElement("button");
      btn.className = "poll-opt" + (mineChoices.includes(idx) ? " mine" : "");
      btn.dataset.msgId = m.id;
      btn.dataset.idx = String(idx);
      const bar = document.createElement("span");
      bar.className = "poll-bar";
      bar.style.width = (total ? Math.round(count / total * 100) : 0) + "%";
      const label = document.createElement("span");
      label.className = "poll-opt-label";
      label.textContent = (mineChoices.includes(idx) ? "✓ " : "") + opt;
      const c = document.createElement("span");
      c.className = "poll-opt-count";
      c.textContent = String(count);
      btn.append(bar, label, c);
      box.appendChild(btn);
    });
    const t = document.createElement("span");
    t.className = "poll-total";
    t.textContent = total + (m.poll.multi ? " kişi oy verdi" : " oy");
    box.appendChild(t);
    return box;
  }

  function pollChoices(v) {
    if (Number.isInteger(v)) return [v];
    return Array.isArray(v) ? v.filter(Number.isInteger) : [];
  }

  async function votePoll(msgId, idx) {
    const m = currentMessages.find(x => x.id === msgId);
    if (!m) return;
    const mine = pollChoices((m.votes || {})[myUid]);
    let value;
    if (m.poll && m.poll.multi) {
      const next = mine.includes(idx) ? mine.filter(i => i !== idx) : [...mine, idx].sort((a, b) => a - b);
      value = next.length ? next : firebase.firestore.FieldValue.delete();
    } else {
      value = mine.length === 1 && mine[0] === idx ? firebase.firestore.FieldValue.delete() : idx;
    }
    try {
      await fbDb.collection("conversations").doc(activeConvId).collection("messages").doc(msgId).update({
        [`votes.${myUid}`]: value,
      });
    } catch (e) {
      alert(e && e.code === "permission-denied"
        ? "Oy verilemedi: Firestore kurallarının güncellenmesi gerekiyor."
        : "Oy verilemedi: " + e.message);
    }
  }

  function renderLocation(loc) {
    const card = document.createElement("div");
    card.className = "location-card";
    const title = document.createElement("span");
    title.className = "loc-title";
    title.textContent = "📍 Konum";
    card.appendChild(title);
    const lat = Number(loc.lat), lng = Number(loc.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const coords = document.createElement("span");
      coords.textContent = lat.toFixed(5) + ", " + lng.toFixed(5);
      card.appendChild(coords);
      if (Number.isFinite(Number(loc.acc))) {
        const acc = document.createElement("span");
        acc.className = "loc-acc";
        acc.textContent = "±" + Math.round(Number(loc.acc)) + " m";
        card.appendChild(acc);
      }
      // A link, not an embedded map: nothing is fetched until it's tapped.
      const a = document.createElement("a");
      a.className = "msg-link";
      a.href = "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lng + "#map=17/" + lat + "/" + lng;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Haritada aç";
      card.appendChild(a);
    }
    return card;
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Bugün";
    if (d.toDateString() === yesterday.toDateString()) return "Dün";
    return d.toLocaleDateString("tr-TR", d.getFullYear() === today.getFullYear()
      ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
  }

  // Ids already on screen, so only newly arrived messages animate in.
  let shownMsgIds = new Set();
  let shownMsgConv = null;

  function renderMessages(msgs) {
    messageListEl.innerHTML = "";
    const query = searchQuery.trim();
    let matchCount = 0;
    let lastDay = null;
    // A run of messages from the same person: only the first has a tail.
    let lastFrom = null;
    const animate = shownMsgConv === activeConvId;
    const decorate = (el, m) => {
      if (m.from !== lastFrom) el.classList.add("tail");
      lastFrom = m.from;
      if (animate && !shownMsgIds.has(m.id)) el.classList.add("appear");
    };
    msgs.forEach(m => {
      if (m.expiresAtMillis && m.expiresAtMillis <= Date.now()) return;
      if (msgFlag("hiddenMsgs", activeConvId, m.id)) return; // deleted for me
      if (m.ts <= chatDeletedAt(activeConvId)) return; // chat deleted for me after this
      if (starredOnly && !msgFlag("starred", activeConvId, m.id)) return;
      if (query) {
        // Images, call log entries and deleted messages aren't searchable
        // (no text to match), so hide them while filtering; only text
        // messages containing the query are shown.
        if (m.deleted || m.image || !m.text || !m.text.toLowerCase().includes(query.toLowerCase())) return;
        matchCount++;
      }
      const day = new Date(m.ts).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        lastFrom = null;
        const sep = document.createElement("div");
        sep.className = "day-sep";
        sep.textContent = dayLabel(m.ts);
        messageListEl.appendChild(sep);
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
        decorate(div, m);
        attachLongPress(div, () => showMessageActions(m));
        messageListEl.appendChild(div);
        return;
      }
      if (m.call) {
        lastFrom = null;
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
        attachLongPress(callDiv, () => showMessageActions(m));
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
      if (m.replyTo) div.appendChild(renderQuote(msgs.find(q => q.id === m.replyTo), m.replyTo));
      if (m.poll) {
        div.appendChild(renderPoll(m));
      } else if (m.location) {
        div.appendChild(renderLocation(m.location));
      } else if (m.contact) {
        div.appendChild(renderContactCard(m.contact));
      } else if (m.liveLocation) {
        div.appendChild(renderLiveLocation(m));
      } else if (m.event) {
        div.appendChild(renderEvent(m));
      } else if (m.sticker) {
        div.classList.add("sticker");
        const img = document.createElement("img");
        img.className = "sticker-img";
        img.src = m.sticker;
        img.alt = "Çıkartma";
        div.appendChild(img);
      } else if (m.image && m.viewOnce) {
        const vo = document.createElement("span");
        vo.className = "view-once";
        vo.dataset.msgId = m.id;
        vo.textContent = m.from === "me" ? "👁️ Tek seferlik fotoğraf" : "👁️ Fotoğraf · açmak için dokun";
        div.appendChild(vo);
      } else if (m.image) {
        const img = document.createElement("img");
        img.src = m.image;
        div.appendChild(img);
      } else if (m.audio && m.viewOnce) {
        const vo = document.createElement("span");
        vo.className = "view-once";
        vo.dataset.msgId = m.id;
        vo.textContent = m.from === "me" ? "🎤 Tek seferlik sesli mesaj" : "🎤 Tek seferlik sesli mesaj · dinlemek için dokun";
        div.appendChild(vo);
      } else if (m.audio) {
        div.appendChild(renderVoiceMessage(m));
      } else if (m.file) {
        const mime = m.file.mime || "";
        // Large files (chunked bytes) play from a local blob URL once downloaded.
        const fileUrl = m.file.binary ? largeFileUrls.get(m.id) : m.file.dataUrl;
        if (fileUrl && (mime.startsWith("video/") || mime.startsWith("audio/"))) {
          const media = document.createElement(mime.startsWith("video/") ? "video" : "audio");
          media.controls = true;
          media.preload = "metadata";
          media.playsInline = true;
          media.src = fileUrl;
          div.appendChild(media);
        }
        if (m.file.binary && !fileUrl) {
          const dl = document.createElement("button");
          dl.className = "large-dl";
          dl.dataset.msgId = m.id;
          dl.textContent = (mime.startsWith("video/") ? "▶ Videoyu aç" : "⬇ İndir") +
            (m.file.size ? " · " + formatFileSize(m.file.size) : "");
          div.appendChild(dl);
        }
        const link = document.createElement("a");
        link.className = "file-attachment";
        link.href = fileUrl || "#";
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
        if (activeIsGroup) highlightMentions(span);
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
      if (msgFlag("starred", activeConvId, m.id)) {
        const star = document.createElement("span");
        star.className = "msg-star";
        star.textContent = "⭐";
        metaRow.appendChild(star);
      }
      if (m.audio && m.from === "me" && m.played && !activeIsGroup) {
        const played = document.createElement("span");
        played.className = "msg-played";
        played.textContent = "🎧 dinlendi";
        metaRow.appendChild(played);
      }
      if (m.from === "me") {
        const tick = document.createElement("span");
        // ✓ sent, ✓✓ reached their phone, blue ✓✓ read. Like WhatsApp, with
        // our own read receipts off we don't see theirs either (1:1 only:
        // group receipts are always on). In a group: once everyone has.
        const st = messageReceiptState(m);
        tick.className = "msg-tick" + (st === "read" ? " read" : "");
        tick.textContent = st === "sent" ? "✓" : "✓✓";
        metaRow.appendChild(tick);
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
      decorate(div, m);
      attachLongPress(div, () => showMessageActions(m));
      attachSwipeReply(div, () => startReply(m.id));
      messageListEl.appendChild(div);
    });
    shownMsgIds = new Set(msgs.map(x => x.id));
    shownMsgConv = activeConvId;
    messageListEl.scrollTop = messageListEl.scrollHeight;
    renderPinnedBar();
    // Opened from a search result: show that message.
    if (pendingJumpMsgId && msgs.some(x => x.id === pendingJumpMsgId)) {
      const id = pendingJumpMsgId;
      pendingJumpMsgId = null;
      setTimeout(() => jumpToMessage(id), 50);
    }
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
    if (!reactionPicker.classList.contains("hidden") && !e.target.closest("#reaction-picker") && !e.target.closest("#action-sheet")) {
      hideReactionPicker();
    }
  });

  function openReactionPicker(msgId, anchor) {
    const rect = anchor.getBoundingClientRect();
    reactionTargetMsgId = msgId;
    reactionPicker.classList.remove("hidden");
    const pickerRect = reactionPicker.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - pickerRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pickerRect.width - 8));
    reactionPicker.style.left = left + "px";
    reactionPicker.style.top = Math.max(8, rect.top - pickerRect.height - 8) + "px";
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Older WebViews: copy through a temporary textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  async function deleteForEveryone(msgId) {
    if (!confirm("Bu mesaj herkesten silinsin mi?")) return;
    try {
      // Erase the content and its keys too, not just hide it: a "deleted"
      // flag alone would leave the encrypted message readable in Firestore.
      const erase = firebase.firestore.FieldValue.delete();
      await fbDb.collection("conversations").doc(activeConvId).collection("messages").doc(msgId).update({
        deleted: true,
        deletedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ciphertext: erase,
        iv: erase,
        wrappedKeys: erase,
      });
      const deletedMsg = currentMessages.find(m => m.id === msgId);
      if (deletedMsg) await deleteChunks(deletedMsg.chunked);
    } catch (e) {
      alert("Silinemedi: " + e.message);
    }
  }

  async function promptEditMessage(msg) {
    const newText = prompt("Mesajı düzenle:", msg.text || "");
    if (newText === null) return;
    const trimmed = newText.trim();
    if (!trimmed || trimmed === msg.text) return;
    try {
      await editMessage(activeConvId, activeOtherUids, msg.id, trimmed);
    } catch (e) {
      alert("Düzenlenemedi: " + e.message);
    }
  }

  // Long-press on a message: WhatsApp's action menu.
  function showMessageActions(m) {
    const bubble = messageListEl.querySelector('[data-msg-id="' + CSS.escape(m.id) + '"]');
    const convId = activeConvId;
    const starred = msgFlag("starred", convId, m.id);
    const actions = [];
    if (!m.deleted && !m.call) {
      actions.push({ label: "↩ Yanıtla", run: () => startReply(m.id) });
      if (bubble) actions.push({ label: "🙂 Tepki ver", run: () => openReactionPicker(m.id, bubble) });
    }
    if (!m.deleted && !m.call) {
      const pinned = activeConv() && activeConv().pinnedMessage === m.id;
      actions.push({ label: pinned ? "📌 Sabitlemeyi kaldır" : "📌 Sabitle", run: () => setPinnedMessage(pinned ? null : m.id) });
    }
    if (m.text) actions.push({ label: "📋 Kopyala", run: () => copyText(m.text) });
    if (m.sticker && !chatPrefs().stickers.includes(m.sticker)) {
      actions.push({ label: "🌟 Çıkartmalarıma ekle", run: () => saveSticker(m.sticker) });
    }
    if (!m.deleted && !m.viewOnce && (m.type === "text" || m.type === "image" || m.type === "file" || m.type === "audio")) {
      actions.push({ label: "➡️ İlet", run: () => openForwardModal(m.id) });
    }
    if (!m.deleted) {
      actions.push({ label: starred ? "⭐ Yıldızı kaldır" : "⭐ Yıldızla", run: async () => {
        await setMsgFlag("starred", convId, m.id, !starred);
        renderMessages(currentMessages);
      } });
    }
    if (m.from === "me" && m.type === "text" && !m.deleted) {
      actions.push({ label: "✎ Düzenle", run: () => promptEditMessage(m) });
    }
    if (m.from === "me" && !m.deleted && !m.call) {
      actions.push({ label: "ℹ️ Bilgi", run: () => showMessageInfo(m) });
    }
    actions.push({ label: "🙈 Benden sil", danger: true, run: async () => {
      await setMsgFlag("hiddenMsgs", convId, m.id, true);
      renderMessages(currentMessages);
    } });
    if (m.from === "me" && !m.deleted && !m.call) {
      actions.push({ label: "🗑 Herkesten sil", danger: true, run: () => deleteForEveryone(m.id) });
    }
    showActionSheet(m.text ? m.text.slice(0, 80) : messageSnippet(m), actions);
  }

  const largeFileUrls = new Map(); // msg id -> blob: URL of a downloaded large file
  const largeFileLoading = new Set();

  async function openLargeFile(msgId, btn) {
    const m = currentMessages.find(x => x.id === msgId);
    if (!m || !m.chunked || !m.wrappedKey || largeFileLoading.has(msgId)) return;
    largeFileLoading.add(msgId);
    try {
      const blob = await downloadLargeFile(m.wrappedKey, m.chunked, m.file.mime, p => {
        btn.textContent = "İndiriliyor… %" + Math.round(p * 100);
      });
      largeFileUrls.set(msgId, URL.createObjectURL(blob));
      renderMessages(currentMessages);
    } catch (e) {
      btn.textContent = "İndirilemedi, tekrar dene";
    } finally {
      largeFileLoading.delete(msgId);
    }
  }

  function forgetLargeFiles() {
    largeFileUrls.forEach(url => URL.revokeObjectURL(url));
    largeFileUrls.clear();
  }

  // Opening a view-once photo shows it full screen once; closing the viewer
  // deletes the message (and its chunks) for both sides.
  async function openViewOnce(msgId, el) {
    const m = currentMessages.find(x => x.id === msgId);
    if (!m || m.from === "me") return;
    if (m.audio && el) {
      playViewOnceAudio(m, el);
      return;
    }
    if (!m.image) return;
    openImageViewer(m.image, {
      viewOnce: true,
      onClose: async () => {
        try {
          await fbDb.collection("conversations").doc(activeConvId).collection("messages").doc(msgId).delete();
          await deleteChunks(m.chunked);
        } catch (e) {}
      },
    });
  }

  messageListEl.addEventListener("click", async (e) => {
    const badge = e.target.closest(".msg-reaction-badge");
    if (badge && badge.classList.contains("mine")) {
      await setMyReaction(activeConvId, badge.dataset.msgId, badge.dataset.emoji);
      return;
    }
    const link = e.target.closest(".msg-link");
    if (link) {
      // In the Android app, open links in the phone's browser, not the app.
      const updatePlugin = appUpdatePlugin();
      if (updatePlugin) {
        e.preventDefault();
        updatePlugin.openExternal({ url: link.href }).catch(() => {});
      }
      return;
    }
    const speedBtn = e.target.closest(".voice-speed");
    if (speedBtn) {
      cycleVoiceSpeed(speedBtn);
      return;
    }
    const rsvpBtn = e.target.closest(".event-rsvp-btn");
    if (rsvpBtn) {
      setRsvp(rsvpBtn.dataset.msgId, rsvpBtn.dataset.rsvp);
      return;
    }
    const icsBtn = e.target.closest(".event-ics-btn");
    if (icsBtn) {
      saveEventToCalendar(icsBtn.dataset.msgId);
      return;
    }
    const liveStop = e.target.closest(".live-stop-btn");
    if (liveStop) {
      const m = currentMessages.find(x => x.id === liveStop.dataset.msgId);
      liveStop.disabled = true;
      stopLiveLocation(liveStop.dataset.msgId, m);
      return;
    }
    const contactBtn = e.target.closest(".contact-msg-btn");
    if (contactBtn) {
      openContactChat(contactBtn.dataset.uid);
      return;
    }
    const pollOpt = e.target.closest(".poll-opt");
    if (pollOpt) {
      votePoll(pollOpt.dataset.msgId, Number(pollOpt.dataset.idx));
      return;
    }
    const largeDl = e.target.closest(".large-dl");
    if (largeDl) {
      openLargeFile(largeDl.dataset.msgId, largeDl);
      return;
    }
    const fileLink = e.target.closest(".file-attachment");
    if (fileLink && fileLink.getAttribute("href") === "#") {
      e.preventDefault(); // a large file not downloaded yet
      return;
    }
    const viewOnce = e.target.closest(".msg-bubble.them .view-once");
    if (viewOnce) {
      openViewOnce(viewOnce.dataset.msgId, viewOnce);
      return;
    }
    const quote = e.target.closest(".msg-quote");
    if (quote) {
      const target = messageListEl.querySelector('.msg-bubble[data-msg-id="' + CSS.escape(quote.dataset.quoteOf) + '"]');
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.remove("flash");
        void target.offsetWidth; // restart the animation
        target.classList.add("flash");
      }
      return;
    }
    if (e.target.tagName === "IMG" && e.target.closest(".msg-bubble")) {
      openImageViewer(e.target.src);
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
      } else if (msg.type === "file" && msg.file.binary) {
        const url = largeFileUrls.get(msg.id);
        if (!url) {
          alert("Büyük bir dosyayı iletmeden önce bir kez açman gerekiyor.");
          return;
        }
        const blob = await (await fetch(url)).blob();
        await sendLargeFileTo(targetConvId, otherUids, new File([blob], msg.file.name || "dosya", { type: msg.file.mime || "" }));
      } else if (msg.type === "file") {
        await sendEncryptedTo(targetConvId, otherUids, JSON.stringify(msg.file), "file");
      } else if (msg.type === "audio") {
        await sendEncryptedTo(targetConvId, otherUids, msg.audio, "audio");
      }
    } catch (e) {
      alert("İletilemedi: " + e.message);
    }
  }

  async function wrapAesKeyForPublicKey(rawAesKey, publicKey) {
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey);
    return b64encode(wrapped);
  }

  async function sendEncrypted(payloadText, type, extraFields) {
    // Capture these locally: the user may navigate away from the conversation
    // (clearing activeConvId/activeOtherUids) while this async send is still
    // in flight, and the write below must still target the right thread.
    return sendEncryptedTo(activeConvId, activeOtherUids, payloadText, type, extraFields);
  }

  // extraFields: unencrypted metadata stored on the message, e.g. { replyTo }.
  async function sendEncryptedTo(convId, otherUids, payloadText, type, extraFields) {
    if (!convId || !otherUids || !otherUids.length) return;
    // Blocking only applies to 1:1 threads; groups don't expose a block UI.
    if (otherUids.length === 1 && myBlocked[otherUids[0]]) return;
    const key = await makeMessageKey(otherUids);
    if (!key) return;
    const { aesKey, wrappedKeys } = key;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(payloadText)
    );

    const expiresAt = messageExpiry(convId);
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
    if (extraFields) Object.assign(msgData, extraFields);
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
    await afterMessageSent(convId, otherUids, msgRef, type);
    return msgRef;
  }

  // A fresh AES key for one message, wrapped for me and every recipient.
  async function makeMessageKey(otherUids) {
    const otherPublicKeys = await Promise.all(otherUids.map(u => getPublicKeyForUid(u)));
    if (otherPublicKeys.some(k => !k)) {
      alert("Bir alıcının açık anahtarı bulunamadı.");
      return null;
    }
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const rawAes = await crypto.subtle.exportKey("raw", aesKey);
    const wrappedKeys = { [myUid]: await wrapAesKeyForPublicKey(rawAes, myPublicKey) };
    for (let i = 0; i < otherUids.length; i++) {
      wrappedKeys[otherUids[i]] = await wrapAesKeyForPublicKey(rawAes, otherPublicKeys[i]);
    }
    return { aesKey, wrappedKeys };
  }

  function messageExpiry(convId) {
    const conv = conversations.get(convId);
    const disappearingSeconds = conv ? (conv.disappearingSeconds || 0) : 0;
    return disappearingSeconds > 0
      ? firebase.firestore.Timestamp.fromMillis(Date.now() + disappearingSeconds * 1000)
      : null;
  }

  async function afterMessageSent(convId, otherUids, msgRef, type) {
    if (type !== "call") requestPush({ kind: "message", convId, msgId: msgRef.id });
    const convUpdate = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    otherUids.forEach(u => { convUpdate[`unreadCount.${u}`] = firebase.firestore.FieldValue.increment(1); });
    await fbDb.collection("conversations").doc(convId).update(convUpdate);
  }

  /* ---------------- Large files (videos) ----------------
     Big files are never turned into one base64 string: the file is read in
     BIN_CHUNK_BYTES slices, each encrypted on its own (same message key,
     a per-chunk IV) and stored as Firestore bytes, so memory holds only a
     few chunks and storage is ~1x the file instead of ~1.8x. The message
     carries only the encrypted name/type/size, and chunked: { conv, id, n,
     bin: true, iv }. Recipients download on tap (downloadLargeFile). */

  const BIN_CHUNK_BYTES = 900 * 1024;
  const LARGE_FILE_MAX = 200 * 1024 * 1024;

  // Chunk i's IV: the message's base IV with its last 4 bytes XOR i, so
  // no two chunks share an IV under the same key.
  function chunkIv(baseIv, i) {
    const iv = new Uint8Array(baseIv);
    const view = new DataView(iv.buffer);
    view.setUint32(8, view.getUint32(8) ^ i);
    return iv;
  }

  async function sendLargeFileTo(convId, otherUids, file, extraFields, onProgress) {
    if (!convId || !otherUids || !otherUids.length) return;
    if (otherUids.length === 1 && myBlocked[otherUids[0]]) return;
    const key = await makeMessageKey(otherUids);
    if (!key) return;
    const { aesKey, wrappedKeys } = key;
    const metaIv = crypto.getRandomValues(new Uint8Array(12));
    const meta = await crypto.subtle.encrypt({ name: "AES-GCM", iv: metaIv }, aesKey,
      new TextEncoder().encode(JSON.stringify({ name: file.name, mime: file.type, size: file.size, binary: true })));
    const baseIv = crypto.getRandomValues(new Uint8Array(12));
    const messagesCol = fbDb.collection("conversations").doc(convId).collection("messages");
    const chunked = {
      conv: convId, id: messagesCol.doc().id, n: Math.max(1, Math.ceil(file.size / BIN_CHUNK_BYTES)),
      bin: true, iv: b64encode(baseIv.buffer),
    };
    const expiresAt = messageExpiry(convId);
    // Chunks go first, so a reader never sees the message without them;
    // a few per batch keeps each request well under Firestore's 10MiB.
    for (let i = 0; i < chunked.n; i += 4) {
      const batch = fbDb.batch();
      for (let j = i; j < Math.min(i + 4, chunked.n); j++) {
        const plain = await file.slice(j * BIN_CHUNK_BYTES, (j + 1) * BIN_CHUNK_BYTES).arrayBuffer();
        const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkIv(baseIv, j) }, aesKey, plain);
        const chunk = { from: myUid, chunkOf: chunked.id, idx: j, bin: firebase.firestore.Blob.fromUint8Array(new Uint8Array(enc)) };
        if (expiresAt) chunk.expiresAt = expiresAt;
        batch.set(chunkRef(chunked, j), chunk);
      }
      await batch.commit();
      if (onProgress) onProgress(Math.min(i + 4, chunked.n) / chunked.n);
    }
    const msgData = {
      from: myUid,
      type: "file",
      iv: b64encode(metaIv.buffer),
      ciphertext: b64encode(meta),
      wrappedKeys,
      chunked,
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      read: false,
    };
    if (expiresAt) msgData.expiresAt = expiresAt;
    if (extraFields) Object.assign(msgData, extraFields);
    const msgRef = await messagesCol.add(msgData);
    await afterMessageSent(convId, otherUids, msgRef, "file");
  }

  // Downloads and decrypts a large file's chunks into a Blob.
  async function downloadLargeFile(wrappedKey, chunked, mime, onProgress) {
    const rawAes = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, myPrivateKey, b64decode(wrappedKey));
    const aesKey = await crypto.subtle.importKey("raw", rawAes, { name: "AES-GCM" }, false, ["decrypt"]);
    const baseIv = new Uint8Array(b64decode(chunked.iv));
    const type = mime || "application/octet-stream";
    // Grown chunk by chunk rather than from one array of parts: the browser
    // can keep a big Blob on disk, so memory doesn't hold the file twice.
    let blob = new Blob([], { type });
    for (let i = 0; i < chunked.n; i++) {
      const snap = await chunkRef(chunked, i).get();
      if (!snap.exists) throw new Error("eksik parça");
      const enc = snap.data().bin.toUint8Array();
      const part = await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkIv(baseIv, i) }, aesKey, enc);
      blob = new Blob([blob, part], { type });
      if (onProgress) onProgress((i + 1) / chunked.n);
    }
    return blob;
  }

  document.getElementById("message-send-btn").addEventListener("click", sendMessage);
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });
  messageInput.addEventListener("input", notifyTyping);

  // Like WhatsApp: 🎤 while the box is empty, ➤ once there is text.
  const messageInputRow = document.querySelector(".message-input-row");
  function updateComposerMode() {
    messageInputRow.classList.toggle("has-text", !!messageInput.value.trim());
  }
  messageInput.addEventListener("input", updateComposerMode);
  document.getElementById("composer-camera-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    cameraInput.click();
  });

  async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    messageInput.value = "";
    updateComposerMode();
    hideMentionPicker();
    try {
      const fields = takeReplyFields() || {};
      const mentions = activeIsGroup ? mentionedUids(text) : [];
      if (mentions.length) fields.mentions = mentions;
      await sendEncrypted(text, "text", Object.keys(fields).length ? fields : null);
    } catch (e) {
      alert("Mesaj gönderilemedi: " + e.message);
    }
  }

  // 📎 opens a small menu: take a photo with the camera, or pick from the
  // gallery/files. The camera input has capture="environment", which opens
  // the camera directly on phones (and in the Android app).
  const attachMenu = document.getElementById("attach-menu");
  const cameraInput = document.getElementById("camera-input");
  attachPhotoBtn.addEventListener("click", () => attachMenu.classList.toggle("hidden"));
  document.getElementById("attach-camera-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    cameraInput.click();
  });
  document.getElementById("attach-gallery-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    photoInput.click();
  });
  const pollModal = document.getElementById("poll-modal");
  document.getElementById("attach-poll-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    document.getElementById("poll-question").value = "";
    document.getElementById("poll-multi").checked = false;
    const opts = document.getElementById("poll-options");
    opts.innerHTML = "";
    for (let i = 0; i < 2; i++) addPollOptionInput();
    pollModal.classList.remove("hidden");
  });
  function addPollOptionInput() {
    const opts = document.getElementById("poll-options");
    if (opts.children.length >= 10) return;
    const input = document.createElement("input");
    input.className = "poll-option-input";
    input.type = "text";
    input.maxLength = 100;
    input.placeholder = "Seçenek " + (opts.children.length + 1);
    opts.appendChild(input);
  }
  document.getElementById("poll-add-option").addEventListener("click", addPollOptionInput);
  document.getElementById("poll-cancel").addEventListener("click", () => pollModal.classList.add("hidden"));
  document.getElementById("poll-send").addEventListener("click", async () => {
    const question = document.getElementById("poll-question").value.trim();
    const options = Array.from(document.querySelectorAll(".poll-option-input")).map(i => i.value.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      alert("Bir soru ve en az 2 seçenek yaz.");
      return;
    }
    pollModal.classList.add("hidden");
    try {
      const poll = { question, options };
      if (document.getElementById("poll-multi").checked) poll.multi = true;
      await sendEncrypted(JSON.stringify(poll), "poll", takeReplyFields());
    } catch (e) {
      alert("Anket gönderilemedi: " + e.message);
    }
  });

  document.getElementById("attach-location-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    showActionSheet("Konum paylaş", [
      { label: "📍 Şu anki konum", run: sendCurrentLocation },
      { label: "🔴 Canlı konum · 15 dakika", run: () => startLiveLocation(15) },
      { label: "🔴 Canlı konum · 1 saat", run: () => startLiveLocation(60) },
      { label: "🔴 Canlı konum · 8 saat", run: () => startLiveLocation(480) },
    ]);
  });

  function sendCurrentLocation() {
    if (!navigator.geolocation) {
      alert("Bu cihaz konum paylaşmayı desteklemiyor.");
      return;
    }
    if (!confirm("Şu anki konumun bu sohbete gönderilsin mi?")) return;
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
      try {
        await sendEncrypted(JSON.stringify({ lat, lng, acc }), "location", takeReplyFields());
      } catch (e) {
        alert("Konum gönderilemedi: " + e.message);
      }
    }, err => {
      alert(err.code === 1 ? "Konum izni verilmedi." : "Konum alınamadı.");
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  }

  /* ---------------- Pinned message ----------------
     conversation.pinnedMessage holds the id of one message shown in a bar
     under the header (any participant may change it, like WhatsApp). The
     id reveals nothing; the bar's text comes from the decrypted copy. */

  function activeConv() {
    return activeConvId ? conversations.get(activeConvId) : null;
  }

  async function setPinnedMessage(msgId) {
    const convId = activeConvId;
    if (!convId) return;
    try {
      await fbDb.collection("conversations").doc(convId).update({
        pinnedMessage: msgId || firebase.firestore.FieldValue.delete(),
      });
    } catch (e) {
      alert(e && e.code === "permission-denied"
        ? "Sabitlenemedi: Firestore kurallarının güncellenmesi gerekiyor."
        : "Sabitlenemedi: " + e.message);
    }
  }

  function renderPinnedBar() {
    const bar = document.getElementById("pinned-bar");
    const conv = activeConv();
    const id = conv && conv.pinnedMessage;
    const m = id ? currentMessages.find(x => x.id === id) : null;
    // Gone (deleted, expired) or not loaded yet: no bar.
    if (!m || m.deleted || msgFlag("hiddenMsgs", activeConvId, m.id)) {
      bar.classList.add("hidden");
      return;
    }
    const who = activeIsGroup ? messageSenderName(m) + ": " : "";
    document.getElementById("pinned-bar-text").textContent = who + messageSnippet(m);
    bar.classList.remove("hidden");
  }

  // Scrolls the chat to a message and briefly highlights it.
  function jumpToMessage(msgId) {
    const el = messageListEl.querySelector('.msg-bubble[data-msg-id="' + CSS.escape(msgId) + '"]');
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
  }

  document.getElementById("pinned-bar-text").addEventListener("click", () => {
    const conv = activeConv();
    if (conv && conv.pinnedMessage) jumpToMessage(conv.pinnedMessage);
  });
  document.getElementById("pinned-bar-unpin").addEventListener("click", () => setPinnedMessage(null));

  /* ---------------- @mentions in groups ----------------
     Typing "@" offers the group's members; a sent message lists the
     mentioned uids in "mentions" (outside the encryption, like replyTo:
     the members are already known to everyone in the group). The push
     worker notifies a mentioned member even if they muted the group. */

  const NICK_CHARS = "a-z0-9_çğıöşü";
  const mentionPicker = document.getElementById("mention-picker");

  function groupMembersForMention() {
    const conv = activeGroup();
    if (!conv) return [];
    return conv.participants
      .filter(u => u !== myUid)
      .map(uid => ({ uid, nickname: conv.participantNicknames[uid] || "" }))
      .filter(mb => mb.nickname);
  }

  function mentionPattern(nickname) {
    return new RegExp("(^|\\s)@" + nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![" + NICK_CHARS + "])");
  }

  function mentionedUids(text) {
    return groupMembersForMention().filter(mb => mentionPattern(mb.nickname).test(text)).map(mb => mb.uid);
  }

  // Wraps known @nicknames in a message's text (not inside links).
  function highlightMentions(container) {
    const conv = activeGroup();
    if (!conv) return;
    const known = new Map(Object.entries(conv.participantNicknames).map(([uid, n]) => [n, uid]));
    known.set(myNickname, myUid);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const re = new RegExp("@([" + NICK_CHARS + "]+)", "g");
    nodes.forEach(node => {
      if (node.parentElement && node.parentElement.closest("a")) return;
      const text = node.nodeValue;
      let frag = null;
      let last = 0;
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(text))) {
        const uid = known.get(match[1]);
        if (!uid) continue;
        frag = frag || document.createDocumentFragment();
        frag.append(text.slice(last, match.index));
        const span = document.createElement("span");
        span.className = "mention" + (uid === myUid ? " me" : "");
        span.textContent = match[0];
        frag.append(span);
        last = match.index + match[0].length;
      }
      if (frag) {
        frag.append(text.slice(last));
        node.replaceWith(frag);
      }
    });
  }

  function hideMentionPicker() {
    mentionPicker.classList.add("hidden");
    mentionPicker.innerHTML = "";
  }

  function updateMentionPicker() {
    if (!activeIsGroup) { hideMentionPicker(); return; }
    const caret = messageInput.selectionStart == null ? messageInput.value.length : messageInput.selectionStart;
    const match = messageInput.value.slice(0, caret).match(/(^|\s)@(\S*)$/);
    if (!match) { hideMentionPicker(); return; }
    const prefix = normalizeNickname(match[2]);
    const members = groupMembersForMention().filter(mb => mb.nickname.startsWith(prefix)).slice(0, 8);
    if (!members.length) { hideMentionPicker(); return; }
    mentionPicker.innerHTML = "";
    members.forEach(mb => {
      const btn = document.createElement("button");
      const av = document.createElement("span");
      av.className = "avatar small";
      watchProfile(mb.uid);
      paintAvatar(av, mb.uid, mb.nickname);
      const label = document.createElement("span");
      label.textContent = "@" + mb.nickname;
      btn.append(av, label);
      // Keep the keyboard open while picking.
      btn.addEventListener("mousedown", e => e.preventDefault());
      btn.addEventListener("click", () => {
        const value = messageInput.value;
        const start = caret - match[2].length - 1;
        const insert = "@" + mb.nickname + " ";
        messageInput.value = value.slice(0, start) + insert + value.slice(caret);
        updateComposerMode();
        const pos = start + insert.length;
        messageInput.setSelectionRange(pos, pos);
        messageInput.focus();
        hideMentionPicker();
      });
      mentionPicker.appendChild(btn);
    });
    mentionPicker.classList.remove("hidden");
  }

  messageInput.addEventListener("input", updateMentionPicker);
  messageInput.addEventListener("blur", () => setTimeout(hideMentionPicker, 150));

  /* ---------------- Voice messages: speed and "played" ---------------- */

  const VOICE_RATES = [1, 1.5, 2];
  const voiceRates = new Map(); // msg id -> chosen playback speed

  function voiceRateLabel(rate) {
    return String(rate).replace(".", ",") + "×";
  }

  function renderVoiceMessage(m) {
    const row = document.createElement("div");
    row.className = "voice-row";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = m.audio;
    const rate = voiceRates.get(m.id) || 1;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    if (m.from === "them" && !activeIsGroup && !m.played) {
      // Written once listening stops, not on play: the write re-renders the
      // chat, which would cut the playback off.
      const convId = activeConvId;
      const markPlayed = () => {
        if (m.played) return;
        m.played = true;
        fbDb.collection("conversations").doc(convId).collection("messages").doc(m.id)
          .update({ played: true }).catch(() => {});
      };
      audio.addEventListener("pause", markPlayed);
      audio.addEventListener("ended", markPlayed);
    }
    const speed = document.createElement("button");
    speed.className = "voice-speed";
    speed.dataset.msgId = m.id;
    speed.textContent = voiceRateLabel(rate);
    row.append(audio, speed);
    return row;
  }

  function cycleVoiceSpeed(btn) {
    const current = voiceRates.get(btn.dataset.msgId) || 1;
    const next = VOICE_RATES[(VOICE_RATES.indexOf(current) + 1) % VOICE_RATES.length];
    voiceRates.set(btn.dataset.msgId, next);
    btn.textContent = voiceRateLabel(next);
    const audio = btn.parentElement.querySelector("audio");
    if (audio) {
      audio.defaultPlaybackRate = next;
      audio.playbackRate = next;
    }
  }

  /* ---------------- Contact cards ----------------
     A "contact" message carries { uid, nickname } (encrypted). Tapping it
     opens a chat with that user, looked up by uid so a renamed user is
     still found. */

  const UID_RE = /^[A-Za-z0-9]{1,128}$/;

  function renderContactCard(c) {
    const box = document.createElement("div");
    box.className = "contact-card";
    const head = document.createElement("div");
    head.className = "contact-head";
    const av = document.createElement("span");
    av.className = "avatar small";
    const validUid = typeof c.uid === "string" && UID_RE.test(c.uid);
    if (validUid) {
      watchProfile(c.uid);
      paintAvatar(av, c.uid, c.nickname || "?");
    }
    const name = document.createElement("span");
    name.className = "contact-name";
    name.textContent = "@" + (c.nickname || "?");
    head.append(av, name);
    box.appendChild(head);
    if (validUid && c.uid !== myUid) {
      const btn = document.createElement("button");
      btn.className = "contact-msg-btn";
      btn.dataset.uid = c.uid;
      btn.textContent = "💬 Mesaj gönder";
      box.appendChild(btn);
    }
    return box;
  }

  async function openContactChat(uid) {
    if (!uid || !UID_RE.test(uid)) return;
    try {
      const doc = await fbDb.collection("users").doc(uid).get();
      if (!doc.exists) {
        alert("Bu kullanıcı artık yok.");
        return;
      }
      await startConversationWith(uid, doc.data().nickname);
    } catch (e) {
      alert("Sohbet açılamadı: " + e.message);
    }
  }

  async function sendContact(contact) {
    try {
      await sendEncrypted(JSON.stringify({ uid: contact.uid, nickname: contact.nickname }), "contact", takeReplyFields());
    } catch (e) {
      alert("Kişi gönderilemedi: " + e.message);
    }
  }

  document.getElementById("attach-contact-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    const contacts = [...conversations.values()]
      .filter(c => !c.isGroup && c.otherUid && !myBlocked[c.otherUid] && !activeOtherUids.includes(c.otherUid))
      .map(c => ({ uid: c.otherUid, nickname: c.otherNickname }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname, "tr"));
    const actions = contacts.map(ct => ({ label: "@" + ct.nickname, run: () => sendContact(ct) }));
    actions.push({ label: "✏️ Kullanıcı adı yaz…", run: async () => {
      const raw = prompt("Paylaşılacak kişinin kullanıcı adı:");
      if (raw === null) return;
      const nickname = normalizeNickname(raw);
      if (!nickname) return;
      try {
        const q = await fbDb.collection("users").where("nickname", "==", nickname).limit(1).get();
        if (q.empty) {
          alert("Bu kullanıcı adıyla kayıtlı bir kullanıcı bulunamadı.");
          return;
        }
        await sendContact({ uid: q.docs[0].id, nickname: q.docs[0].data().nickname });
      } catch (e) {
        alert("Kişi gönderilemedi: " + e.message);
      }
    } });
    showActionSheet("Kişi paylaş", actions);
  });

  /* ---------------- Media, files and links of a chat ---------------- */

  const mediaGallery = document.getElementById("media-gallery");
  const mediaGalleryBody = document.getElementById("media-gallery-body");
  let mediaTab = "media";

  function galleryMessages() {
    const now = Date.now();
    return currentMessages
      .filter(m => !m.deleted && !(m.expiresAtMillis && m.expiresAtMillis <= now) && !msgFlag("hiddenMsgs", activeConvId, m.id))
      .slice()
      .reverse(); // newest first
  }

  function isVideoFile(m) {
    return !!(m.file && (m.file.mime || "").startsWith("video/"));
  }

  function galleryEmpty(text) {
    const p = document.createElement("p");
    p.className = "media-empty";
    p.textContent = text;
    mediaGalleryBody.appendChild(p);
  }

  function galleryRow(icon, title, sub) {
    const row = document.createElement("button");
    row.className = "media-row";
    const i = document.createElement("span");
    i.className = "media-row-icon";
    i.textContent = icon;
    const info = document.createElement("span");
    info.className = "media-row-info";
    const t = document.createElement("span");
    t.className = "media-row-title";
    t.textContent = title;
    const s2 = document.createElement("span");
    s2.className = "media-row-sub";
    s2.textContent = sub;
    info.append(t, s2);
    row.append(i, info);
    return row;
  }

  function renderMediaGallery() {
    mediaGallery.querySelectorAll(".media-tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === mediaTab));
    mediaGalleryBody.innerHTML = "";
    const msgs = galleryMessages();
    const dateOf = m => new Date(m.ts).toLocaleDateString("tr-TR");
    if (mediaTab === "media") {
      const items = msgs.filter(m => (m.image && !m.viewOnce) || isVideoFile(m));
      if (!items.length) return galleryEmpty("Bu sohbette henüz fotoğraf ya da video yok.");
      const grid = document.createElement("div");
      grid.className = "media-grid";
      items.forEach(m => {
        const cell = document.createElement("button");
        cell.className = "media-thumb";
        if (m.image) {
          const img = document.createElement("img");
          img.src = m.image;
          img.alt = "";
          cell.appendChild(img);
          cell.addEventListener("click", () => openImageViewer(m.image));
        } else {
          const url = m.file.binary ? largeFileUrls.get(m.id) : m.file.dataUrl;
          if (url) {
            const v = document.createElement("video");
            v.src = url;
            v.muted = true;
            v.preload = "metadata";
            v.playsInline = true;
            cell.appendChild(v);
          }
          const play = document.createElement("span");
          play.className = "media-play";
          play.textContent = "▶";
          cell.appendChild(play);
          cell.addEventListener("click", () => {
            mediaGallery.classList.add("hidden");
            jumpToMessage(m.id);
          });
        }
        grid.appendChild(cell);
      });
      mediaGalleryBody.appendChild(grid);
    } else if (mediaTab === "files") {
      const items = msgs.filter(m => m.file && !isVideoFile(m));
      if (!items.length) return galleryEmpty("Bu sohbette henüz dosya yok.");
      items.forEach(m => {
        const row = galleryRow("📄", m.file.name || "Dosya", [m.file.size ? formatFileSize(m.file.size) : "", dateOf(m)].filter(Boolean).join(" · "));
        row.addEventListener("click", () => {
          mediaGallery.classList.add("hidden");
          jumpToMessage(m.id);
        });
        mediaGalleryBody.appendChild(row);
      });
    } else {
      let count = 0;
      msgs.forEach(m => {
        if (!m.text) return;
        (m.text.match(LINK_RE) || []).forEach(url => {
          count++;
          const row = galleryRow("🔗", url, dateOf(m));
          row.addEventListener("click", () => {
            const updatePlugin = appUpdatePlugin();
            if (updatePlugin) updatePlugin.openExternal({ url }).catch(() => {});
            else window.open(url, "_blank", "noopener,noreferrer");
          });
          mediaGalleryBody.appendChild(row);
        });
      });
      if (!count) galleryEmpty("Bu sohbette henüz bağlantı yok.");
    }
  }

  document.getElementById("thread-media-btn").addEventListener("click", () => {
    mediaTab = "media";
    renderMediaGallery();
    mediaGallery.classList.remove("hidden");
  });
  mediaGallery.querySelectorAll(".media-tabs button").forEach(b => b.addEventListener("click", () => {
    mediaTab = b.dataset.tab;
    renderMediaGallery();
  }));
  document.getElementById("media-gallery-close").addEventListener("click", () => mediaGallery.classList.add("hidden"));

  /* ---------------- Theme ----------------
     Dark, light or the phone's setting. Only the messenger changes; the
     calculator in front always looks the same. A plain localStorage value:
     it says nothing about what's inside the vault. */

  const THEME_KEY = "calcut_theme";
  const themeSelect = document.getElementById("theme-select");
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function storedTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return ["dark", "light", "system"].includes(t) ? t : "dark";
    } catch (e) {
      return "dark";
    }
  }

  function applyTheme() {
    const t = storedTheme();
    const light = t === "light" || (t === "system" && !!darkQuery && !darkQuery.matches);
    document.documentElement.dataset.theme = light ? "light" : "dark";
    themeSelect.value = t;
  }

  themeSelect.addEventListener("change", () => {
    try { localStorage.setItem(THEME_KEY, themeSelect.value); } catch (e) {}
    applyTheme();
  });
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener("change", applyTheme);
  applyTheme();

  /* ---------------- Per-device chat settings ----------------
     Wallpapers, locked chats, broadcast lists and saved stickers live in
     the PIN-encrypted vault (localSessionData), like pins and stars: they
     never leave this device. */

  function chatPrefs() {
    const d = localSessionData || {};
    return {
      wallpapers: d.wallpapers && typeof d.wallpapers === "object" ? d.wallpapers : {},
      lockedChats: Array.isArray(d.lockedChats) ? d.lockedChats : [],
      broadcastLists: Array.isArray(d.broadcastLists) ? d.broadcastLists : [],
      stickers: Array.isArray(d.stickers) ? d.stickers : [],
    };
  }

  async function setChatPref(name, value) {
    if (!localSessionData || !currentLocalKey) return false;
    localSessionData[name] = value;
    try {
      await saveLocalBlob(currentLocalKey, await sealSession(localSessionData));
      return true;
    } catch (e) {
      alert("Bu cihazda kaydedilemedi (depolama dolu olabilir).");
      return false;
    }
  }

  function loadImageFile(file) {
    return readAsDataUrl(file).then(url => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("bu fotoğraf açılamadı"));
      img.src = url;
    }));
  }

  // Picks one photo with a temporary file input.
  function pickPhoto() {
    return new Promise(resolve => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.addEventListener("change", () => resolve(input.files[0] || null));
      input.click();
    });
  }

  /* ---------------- Chat menu (tap the chat's name) ---------------- */

  function openChatMenu() {
    const conv = activeConv();
    if (!conv) return;
    const about = activeIsGroup ? "" : aboutOf(conv.otherUid);
    showActionSheet(activeIsGroup ? conv.groupName : "@" + conv.otherNickname + (about ? " · " + about : ""), chatMenuActions());
  }

  // ⋮ in the chat header: the chat's own buttons (kept hidden in
  // .thread-actions, so their handlers and states stay where they are),
  // then the chat menu.
  function openThreadMenu() {
    const conv = activeConv();
    if (!conv) return;
    const btn = id => document.getElementById(id);
    const actions = [
      { label: "🔍 Sohbette ara", run: () => btn("thread-search-btn").click() },
      { label: "🖼 Medya, dosyalar ve bağlantılar", run: () => btn("thread-media-btn").click() },
      { label: "⏳ Kaybolan mesajlar" + (conv.disappearingSeconds ? " (açık)" : ""), run: () => btn("thread-disappearing-btn").click() },
      { label: (conv.muted ? "🔔 " : "🔕 ") + btn("thread-mute-btn").title, run: () => btn("thread-mute-btn").click() },
    ];
    if (!btn("thread-block-btn").classList.contains("hidden")) {
      actions.push({ label: "🚫 " + btn("thread-block-btn").title, danger: !myBlocked[activeOtherUid], run: () => btn("thread-block-btn").click() });
    }
    showActionSheet(activeIsGroup ? conv.groupName : "@" + conv.otherNickname, actions.concat(chatMenuActions()));
  }

  document.getElementById("thread-menu-btn").addEventListener("click", openThreadMenu);

  function chatMenuActions() {
    const convId = activeConvId;
    const conv = activeConv();
    if (!convId || !conv) return [];
    const actions = [];
    if (activeIsGroup) {
      actions.push({ label: "👥 Grup bilgisi", run: () => { renderGroupInfo(); groupInfoModal.classList.remove("hidden"); } });
    }
    actions.push({ label: "🎨 Duvar kağıdı", run: chooseWallpaper });
    actions.push({ label: "🔔 Bildirim sesi" + (chatSoundFor(convId) ? " (özel)" : ""), run: chooseChatSound });
    actions.push(isChatLocked(convId)
      ? { label: "🔓 Sohbet kilidini kaldır", run: () => toggleChatLock(convId) }
      : { label: "🔒 Sohbeti kilitle", run: () => toggleChatLock(convId) });
    actions.push({ label: "📤 Sohbeti dışa aktar", run: exportChat });
    const pinned = pinnedConvIds().includes(convId);
    const archived = archivedConvIds().includes(convId);
    if (!archived) actions.push({ label: pinned ? "📌 Sabitlemeyi kaldır" : "📌 Sabitle", run: () => togglePin(convId) });
    actions.push({ label: archived ? "🗄️ Arşivden çıkar" : "🗄️ Arşivle", run: () => toggleArchive(convId) });
    actions.push({ label: "🗑 Sohbeti sil", danger: true, run: () => askDeleteChat(conv) });
    return actions;
  }

  /* ---------------- Wallpapers ---------------- */

  const WALLPAPER_COLORS = [
    { name: "Gece mavisi", value: "#0f1b2d" },
    { name: "Orman", value: "#10251b" },
    { name: "Bordo", value: "#2a1018" },
    { name: "Mor", value: "#1e1530" },
    { name: "Kahve", value: "#261b12" },
    { name: "Gri", value: "#1d1f24" },
  ];
  const WALLPAPER_PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

  function applyWallpaper() {
    const wp = activeConvId ? chatPrefs().wallpapers[activeConvId] : null;
    if (wp && WALLPAPER_PHOTO_RE.test(wp)) {
      messageListEl.style.background = 'center / cover no-repeat url("' + wp + '")';
    } else if (wp && WALLPAPER_COLORS.some(c => c.value === wp)) {
      messageListEl.style.background = wp;
    } else {
      messageListEl.style.background = "";
    }
  }

  async function setWallpaper(convId, value) {
    const wallpapers = { ...chatPrefs().wallpapers };
    if (value) wallpapers[convId] = value;
    else delete wallpapers[convId];
    if (await setChatPref("wallpapers", wallpapers)) applyWallpaper();
  }

  function chooseWallpaper() {
    const convId = activeConvId;
    const actions = WALLPAPER_COLORS.map(c => ({ label: "🎨 " + c.name, run: () => setWallpaper(convId, c.value) }));
    actions.push({ label: "🖼️ Fotoğraf seç", run: async () => {
      const file = await pickPhoto();
      if (!file) return;
      try {
        const img = await loadImageFile(file);
        const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // Darkened, so the bubbles stay readable on any photo.
        ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await setWallpaper(convId, canvas.toDataURL("image/jpeg", 0.6));
      } catch (e) {
        alert("Duvar kağıdı ayarlanamadı: " + e.message);
      }
    } });
    actions.push({ label: "↺ Varsayılan", run: () => setWallpaper(convId, null) });
    showActionSheet("Duvar kağıdı (yalnızca bu cihazda)", actions);
  }

  /* ---------------- Chat lock ----------------
     A locked chat asks for the fingerprint (or the vault PIN) every time
     it is opened, and its preview is hidden in the chat list. */

  function isChatLocked(convId) {
    return chatPrefs().lockedChats.includes(convId);
  }

  function askVaultPin() {
    const modal = document.getElementById("chat-unlock-modal");
    const input = document.getElementById("chat-unlock-pin");
    const errEl = document.getElementById("chat-unlock-error");
    input.value = "";
    errEl.textContent = "";
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 50);
    return new Promise(resolve => {
      const done = ok => {
        modal.classList.add("hidden");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        input.removeEventListener("keydown", onKey);
        resolve(ok);
      };
      const onOk = async () => {
        try {
          await loadLocalBlob(await deriveLocalKey(input.value.trim()));
          done(true);
        } catch (e) {
          errEl.textContent = "Yanlış PIN.";
        }
      };
      const onCancel = () => done(false);
      const onKey = e => { if (e.key === "Enter") onOk(); };
      const okBtn = document.getElementById("chat-unlock-ok");
      const cancelBtn = document.getElementById("chat-unlock-cancel");
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      input.addEventListener("keydown", onKey);
    });
  }

  async function confirmChatUnlock() {
    const plugin = biometricKeyPlugin();
    const sealed = localStorage.getItem(STORAGE_BIO_SEALED);
    if (plugin && sealed) {
      try {
        await plugin.unlock({ sealed });
        return true;
      } catch (e) { /* fall back to the PIN */ }
    } else if (localStorage.getItem(STORAGE_BIOMETRIC) && window.PublicKeyCredential) {
      if (await verifyBiometricIfEnabled()) return true;
    }
    return askVaultPin();
  }

  async function toggleChatLock(convId) {
    const locked = chatPrefs().lockedChats;
    if (locked.includes(convId)) {
      if (!(await confirmChatUnlock())) return;
      await setChatPref("lockedChats", locked.filter(id => id !== convId));
    } else {
      await setChatPref("lockedChats", [...locked, convId]);
      alert("Sohbet kilitlendi. Açmak için her seferinde parmak izi ya da PIN istenecek.");
    }
  }

  /* ---------------- Export a chat ---------------- */

  async function exportChat() {
    const conv = activeConv();
    if (!conv) return;
    if (!confirm("Sohbet şifresiz bir metin dosyası olarak dışa aktarılacak. Fotoğraf ve dosyalar eklenmez. Devam edilsin mi?")) return;
    const title = activeIsGroup ? conv.groupName : "@" + conv.otherNickname;
    const fmt = t => new Date(t).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const now = Date.now();
    const lines = currentMessages
      .filter(m => !msgFlag("hiddenMsgs", activeConvId, m.id) && !(m.expiresAtMillis && m.expiresAtMillis <= now))
      .map(m => {
        const who = m.from === "me" ? "@" + myNickname : "@" + (m.fromNickname || conv.otherNickname || "?");
        let body;
        if (m.deleted) body = "Bu mesaj silindi";
        else if (m.call) body = callLogText(m.from === "me", m.call.outcome, m.call.duration || 0, m.call.media);
        else if (m.type === "text") body = m.text;
        else body = messageSnippet(m);
        return `[${fmt(m.ts)}] ${who}: ${body}`;
      });
    const text = `${title} sohbeti · ${fmt(now)}\n\n${lines.join("\n")}\n`;
    const fileName = "sohbet-" + (activeIsGroup ? "grup" : conv.otherNickname) + ".txt";
    const file = new File([text], fileName, { type: "text/plain" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ---------------- Group invite codes ----------------
     An admin creates a random code (conversation.inviteCode). Whoever has
     "calcut-davet:<group id>.<code>" can add themselves to the group
     (firestore.rules: joinsWithInviteCode). Resetting the code makes old
     ones useless. */

  const INVITE_PREFIX = "calcut-davet:";

  function randomInviteCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(15));
    return Array.from(bytes, b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("") + "x"; // 16 chars
  }

  async function shareInvite(text) {
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    copyText(text);
  }

  document.getElementById("group-invite-btn").addEventListener("click", async () => {
    const conv = activeGroup();
    if (!conv || !amGroupAdmin(conv)) return;
    let code = conv.inviteCode;
    if (!code) {
      code = randomInviteCode();
      if (!(await updateGroup({ inviteCode: code }))) return;
    }
    const text = INVITE_PREFIX + conv.id + "." + code;
    showActionSheet("Davet kodu: " + text, [
      { label: "📤 Paylaş / kopyala", run: () => shareInvite("\"" + conv.groupName + "\" grubuna katılmak için calcut'ta Gruba katıl'a bu kodu yapıştır:\n" + text) },
      { label: "♻️ Yeni kod (eskisi geçersiz olur)", run: () => updateGroup({ inviteCode: randomInviteCode() }) },
      { label: "⛔ Davet kodunu kapat", danger: true, run: () => updateGroup({ inviteCode: firebase.firestore.FieldValue.delete() }) },
    ]);
  });

  function parseInvite(raw) {
    const m = /calcut-davet:([A-Za-z0-9]{1,128})\.([a-z0-9]{16,64})/.exec(raw || "");
    return m ? { convId: m[1], code: m[2] } : null;
  }

  document.getElementById("group-join-btn").addEventListener("click", async () => {
    const raw = prompt("Davet kodunu yapıştır:");
    if (raw === null) return;
    const invite = parseInvite(raw);
    if (!invite) {
      alert("Bu bir davet kodu değil.");
      return;
    }
    if (conversations.has(invite.convId)) {
      alert("Zaten bu gruptasın.");
      return;
    }
    try {
      await fbDb.collection("conversations").doc(invite.convId).update({
        participants: firebase.firestore.FieldValue.arrayUnion(myUid),
        [`participantNicknames.${myUid}`]: myNickname,
        [`unreadCount.${myUid}`]: 0,
        joinCode: invite.code,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      document.getElementById("new-group-modal").classList.add("hidden");
      alert("Gruba katıldın. Katılmadan önceki mesajlar sende görünmez.");
    } catch (e) {
      alert(e && (e.code === "permission-denied" || e.code === "not-found")
        ? "Katılınamadı: kod geçersiz ya da artık kullanılmıyor (grup dolu da olabilir)."
        : "Katılınamadı: " + e.message);
    }
  });

  /* ---------------- Broadcast messages ----------------
     One message sent to each chosen contact separately, in their own 1:1
     chat (they don't see each other). Lists can be saved on this device. */

  const broadcastModal = document.getElementById("broadcast-modal");

  function broadcastContacts() {
    return [...conversations.values()]
      .filter(c => !c.isGroup && c.otherUid && !myBlocked[c.otherUid])
      .map(c => ({ uid: c.otherUid, nickname: c.otherNickname, convId: c.id }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname, "tr"));
  }

  function renderBroadcastModal() {
    const listsEl = document.getElementById("broadcast-lists");
    const contactsEl = document.getElementById("broadcast-contacts");
    listsEl.innerHTML = "";
    contactsEl.innerHTML = "";
    chatPrefs().broadcastLists.forEach((list, idx) => {
      const chip = document.createElement("button");
      chip.className = "broadcast-chip";
      chip.textContent = "📋 " + list.name + " (" + list.uids.length + ")";
      chip.addEventListener("click", () => {
        contactsEl.querySelectorAll("input").forEach(cb => { cb.checked = list.uids.includes(cb.value); });
      });
      attachLongPress(chip, async () => {
        if (!confirm("\"" + list.name + "\" listesi silinsin mi?")) return;
        await setChatPref("broadcastLists", chatPrefs().broadcastLists.filter((_, i) => i !== idx));
        renderBroadcastModal();
      });
      listsEl.appendChild(chip);
    });
    const contacts = broadcastContacts();
    if (!contacts.length) {
      contactsEl.textContent = "Toplu mesaj için önce kişilerle sohbet başlatmalısın.";
      return;
    }
    contacts.forEach(c => {
      const label = document.createElement("label");
      label.className = "toggle-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = c.uid;
      const span = document.createElement("span");
      span.textContent = "@" + c.nickname;
      label.append(cb, span);
      contactsEl.appendChild(label);
    });
  }

  document.getElementById("broadcast-open-btn").addEventListener("click", () => {
    document.getElementById("new-thread-modal").classList.add("hidden");
    document.getElementById("broadcast-text").value = "";
    document.getElementById("broadcast-save").checked = false;
    renderBroadcastModal();
    broadcastModal.classList.remove("hidden");
  });
  document.getElementById("broadcast-cancel").addEventListener("click", () => broadcastModal.classList.add("hidden"));
  document.getElementById("broadcast-send").addEventListener("click", async () => {
    const btn = document.getElementById("broadcast-send");
    const text = document.getElementById("broadcast-text").value.trim();
    const uids = [...document.querySelectorAll("#broadcast-contacts input:checked")].map(cb => cb.value);
    if (!text || !uids.length) {
      alert("Bir mesaj yaz ve en az bir kişi seç.");
      return;
    }
    if (document.getElementById("broadcast-save").checked) {
      const name = (prompt("Liste adı:") || "").trim().slice(0, 40);
      if (name) await setChatPref("broadcastLists", [...chatPrefs().broadcastLists, { name, uids }].slice(-20));
    }
    btn.disabled = true;
    const contacts = broadcastContacts();
    const failed = [];
    for (let i = 0; i < uids.length; i++) {
      const c = contacts.find(x => x.uid === uids[i]);
      if (!c) continue;
      btn.textContent = "Gönderiliyor " + (i + 1) + "/" + uids.length;
      try {
        await sendEncryptedTo(c.convId, [c.uid], text, "text");
      } catch (e) {
        failed.push("@" + c.nickname);
      }
    }
    btn.disabled = false;
    btn.textContent = "Gönder";
    broadcastModal.classList.add("hidden");
    alert(failed.length ? "Şunlara gönderilemedi: " + failed.join(", ") : uids.length + " kişiye gönderildi.");
  });

  /* ---------------- Live location ----------------
     A "livelocation" message holds { lat, lng, acc, until, updated,
     stopped } (encrypted). While sharing, the sender re-encrypts it with
     the newest position every LIVE_UPDATE_MS. Sharing needs the app open:
     a web page can't follow the position in the background. */

  const LIVE_UPDATE_MS = 20000;
  const liveShares = new Map(); // msg id -> { convId, otherUids, until, watchId, timer, last, pos }

  async function writeLiveLocation(share, msgId, payload) {
    // Taken before any await: locking clears the keys right after asking
    // for the final "stopped" update.
    const me = myUid;
    const myPub = myPublicKey;
    if (!me || !myPub) return;
    const otherKeys = await Promise.all(share.otherUids.map(u => getPublicKeyForUid(u)));
    if (otherKeys.some(k => !k)) return;
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const rawAes = await crypto.subtle.exportKey("raw", aesKey);
    const wrappedKeys = { [me]: await wrapAesKeyForPublicKey(rawAes, myPub) };
    for (let i = 0; i < otherKeys.length; i++) wrappedKeys[share.otherUids[i]] = await wrapAesKeyForPublicKey(rawAes, otherKeys[i]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(JSON.stringify(payload))
    );
    await fbDb.collection("conversations").doc(share.convId).collection("messages").doc(msgId).update({
      iv: b64encode(iv.buffer), ciphertext: b64encode(ciphertext), wrappedKeys,
    });
  }

  function startLiveLocation(minutes) {
    if (!navigator.geolocation) {
      alert("Bu cihaz konum paylaşmayı desteklemiyor.");
      return;
    }
    const label = minutes >= 60 ? (minutes / 60) + " saat" : minutes + " dakika";
    if (!confirm("Canlı konumun " + label + " boyunca bu sohbetle paylaşılsın mı? Paylaşım uygulama açıkken güncellenir.")) return;
    const convId = activeConvId;
    const otherUids = activeOtherUids.slice();
    const replyFields = takeReplyFields();
    navigator.geolocation.getCurrentPosition(async pos => {
      const until = Date.now() + minutes * 60000;
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      try {
        const ref = await sendEncryptedTo(convId, otherUids, JSON.stringify({ ...p, until, updated: Date.now() }), "livelocation", replyFields);
        if (!ref) return;
        const share = { convId, otherUids, until, last: Date.now(), pos: p };
        share.watchId = navigator.geolocation.watchPosition(next => {
          share.pos = { lat: next.coords.latitude, lng: next.coords.longitude, acc: next.coords.accuracy };
          if (Date.now() - share.last < LIVE_UPDATE_MS) return;
          share.last = Date.now();
          writeLiveLocation(share, ref.id, { ...share.pos, until, updated: Date.now() }).catch(() => {});
        }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
        share.timer = setTimeout(() => stopLiveLocation(ref.id), until - Date.now());
        liveShares.set(ref.id, share);
      } catch (e) {
        alert("Canlı konum paylaşılamadı: " + e.message);
      }
    }, err => {
      alert(err.code === 1 ? "Konum izni verilmedi." : "Konum alınamadı.");
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  }

  // m (optional): the rendered message, for a share started before a restart.
  async function stopLiveLocation(msgId, m) {
    const share = liveShares.get(msgId);
    liveShares.delete(msgId);
    if (share) {
      navigator.geolocation.clearWatch(share.watchId);
      clearTimeout(share.timer);
    }
    const target = share || (m && { convId: activeConvId, otherUids: activeOtherUids.slice() });
    const pos = share ? share.pos : m && m.liveLocation;
    if (!target || !pos) return;
    await writeLiveLocation(target, msgId, {
      lat: pos.lat, lng: pos.lng, acc: pos.acc, until: Date.now(), updated: Date.now(), stopped: true,
    }).catch(() => {});
  }

  function stopAllLiveLocations() {
    [...liveShares.keys()].forEach(id => stopLiveLocation(id));
  }

  function liveLocationActive(loc) {
    return !!loc && !loc.stopped && Number(loc.until) > Date.now();
  }

  function renderLiveLocation(m) {
    const loc = m.liveLocation;
    const box = renderLocation(loc);
    box.classList.add("live");
    const title = box.querySelector(".loc-title");
    const active = liveLocationActive(loc);
    if (title) title.textContent = active ? "🔴 Canlı konum" : "📍 Canlı konum sona erdi";
    const info = document.createElement("span");
    info.className = "loc-acc";
    if (active) {
      const left = Math.max(1, Math.round((loc.until - Date.now()) / 60000));
      const upd = new Date(loc.updated || m.ts).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
      info.textContent = (left >= 60 ? Math.round(left / 60) + " saat" : left + " dk") + " kaldı · son güncelleme " + upd;
    } else {
      info.textContent = "Son konum";
    }
    box.insertBefore(info, title ? title.nextSibling : box.firstChild);
    if (m.from === "me" && active) {
      const stop = document.createElement("button");
      stop.className = "live-stop-btn";
      stop.dataset.msgId = m.id;
      stop.textContent = "⏹ Paylaşımı durdur";
      box.appendChild(stop);
    }
    return box;
  }

  /* ---------------- Camera flip in video calls ---------------- */

  const callFlipBtn = document.getElementById("call-flip-btn");
  let cameraFacing = "user";

  callFlipBtn.addEventListener("click", async () => {
    if (!localStream || !peerConnection) return;
    const next = cameraFacing === "user" ? "environment" : "user";
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next } } });
    } catch (e) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next } });
      } catch (e2) {
        alert("Diğer kamera açılamadı.");
        return;
      }
    }
    const newTrack = stream.getVideoTracks()[0];
    if (!newTrack || !localStream || !peerConnection) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    newTrack.enabled = !isCameraOff;
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
    if (sender) await sender.replaceTrack(newTrack);
    localStream.getVideoTracks().forEach(t => { localStream.removeTrack(t); t.stop(); });
    localStream.addTrack(newTrack);
    callLocalVideo.srcObject = localStream;
    cameraFacing = next;
    callLocalVideo.classList.toggle("rear", next === "environment");
  });

  /* ---------------- Photo editor (draw, text, crop, rotate) ----------------
     A single photo picked for sending opens here first. */

  const PE_COLORS = ["#ffffff", "#111111", "#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#af52de"];
  const PE_MAX_SIDE = 1600;
  const photoEditor = document.getElementById("photo-editor");
  const peCanvas = document.getElementById("pe-canvas");
  const peCropBox = document.getElementById("pe-crop-box");
  let peTool = "draw";
  let peColor = PE_COLORS[2];
  let peHistory = [];
  let peResolve = null;
  let peCrop = null; // { x, y, w, h } in canvas pixels

  function peSnapshot() {
    const copy = document.createElement("canvas");
    copy.width = peCanvas.width;
    copy.height = peCanvas.height;
    copy.getContext("2d").drawImage(peCanvas, 0, 0);
    peHistory.push(copy);
    if (peHistory.length > 6) peHistory.shift();
  }

  function peSetCanvasFrom(source, w, h) {
    peCanvas.width = w;
    peCanvas.height = h;
    peCanvas.getContext("2d").drawImage(source, 0, 0, w, h);
  }

  function pePoint(e) {
    const r = peCanvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (peCanvas.width / r.width), y: (e.clientY - r.top) * (peCanvas.height / r.height) };
  }

  function peSetTool(tool) {
    peTool = tool;
    photoEditor.querySelectorAll(".pe-tools [data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
    peCrop = null;
    peCropBox.classList.add("hidden");
    document.getElementById("pe-crop-apply").classList.add("hidden");
  }

  function peShowCropBox() {
    if (!peCrop) return;
    const r = peCanvas.getBoundingClientRect();
    const stage = peCanvas.parentElement.getBoundingClientRect();
    const sx = r.width / peCanvas.width;
    const sy = r.height / peCanvas.height;
    Object.assign(peCropBox.style, {
      left: (r.left - stage.left + peCrop.x * sx) + "px",
      top: (r.top - stage.top + peCrop.y * sy) + "px",
      width: peCrop.w * sx + "px",
      height: peCrop.h * sy + "px",
    });
    peCropBox.classList.remove("hidden");
  }

  let peDrawing = null;
  peCanvas.addEventListener("pointerdown", e => {
    e.preventDefault();
    peCanvas.setPointerCapture(e.pointerId);
    const p = pePoint(e);
    if (peTool === "draw") {
      peSnapshot();
      const ctx = peCanvas.getContext("2d");
      ctx.strokeStyle = peColor;
      ctx.lineWidth = Math.max(4, peCanvas.width / 120);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      peDrawing = p;
    } else if (peTool === "text") {
      const text = prompt("Yazı:");
      if (!text || !text.trim()) return;
      peSnapshot();
      const ctx = peCanvas.getContext("2d");
      const size = Math.max(24, Math.round(peCanvas.width / 14));
      ctx.font = "bold " + size + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = size / 8;
      ctx.strokeStyle = peColor === "#111111" ? "#ffffff" : "#000000";
      ctx.strokeText(text.trim(), p.x, p.y);
      ctx.fillStyle = peColor;
      ctx.fillText(text.trim(), p.x, p.y);
    } else if (peTool === "crop") {
      peDrawing = p;
      peCrop = { x: p.x, y: p.y, w: 0, h: 0 };
    }
  });
  peCanvas.addEventListener("pointermove", e => {
    if (!peDrawing) return;
    const p = pePoint(e);
    if (peTool === "draw") {
      const ctx = peCanvas.getContext("2d");
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else if (peTool === "crop") {
      const x = Math.max(0, Math.min(peDrawing.x, p.x));
      const y = Math.max(0, Math.min(peDrawing.y, p.y));
      peCrop = { x, y, w: Math.min(peCanvas.width, Math.max(peDrawing.x, p.x)) - x, h: Math.min(peCanvas.height, Math.max(peDrawing.y, p.y)) - y };
      peShowCropBox();
    }
  });
  const peEnd = () => {
    if (peTool === "crop" && peCrop && peCrop.w > 20 && peCrop.h > 20) {
      document.getElementById("pe-crop-apply").classList.remove("hidden");
    }
    peDrawing = null;
  };
  peCanvas.addEventListener("pointerup", peEnd);
  peCanvas.addEventListener("pointercancel", peEnd);

  document.getElementById("pe-crop-apply").addEventListener("click", () => {
    if (!peCrop) return;
    peSnapshot();
    const c = peCrop;
    const copy = document.createElement("canvas");
    copy.width = Math.round(c.w);
    copy.height = Math.round(c.h);
    copy.getContext("2d").drawImage(peCanvas, c.x, c.y, c.w, c.h, 0, 0, copy.width, copy.height);
    peSetCanvasFrom(copy, copy.width, copy.height);
    peSetTool("draw");
  });
  document.getElementById("pe-rotate").addEventListener("click", () => {
    peSnapshot();
    const copy = document.createElement("canvas");
    copy.width = peCanvas.height;
    copy.height = peCanvas.width;
    const ctx = copy.getContext("2d");
    ctx.translate(copy.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(peCanvas, 0, 0);
    peSetCanvasFrom(copy, copy.width, copy.height);
    peSetTool(peTool === "crop" ? "draw" : peTool);
  });
  document.getElementById("pe-undo").addEventListener("click", () => {
    const prev = peHistory.pop();
    if (prev) peSetCanvasFrom(prev, prev.width, prev.height);
  });
  photoEditor.querySelectorAll(".pe-tools [data-tool]").forEach(b => b.addEventListener("click", () => peSetTool(b.dataset.tool)));
  PE_COLORS.forEach(color => {
    const b = document.createElement("button");
    b.className = "pe-color" + (color === peColor ? " active" : "");
    b.style.background = color;
    b.addEventListener("click", () => {
      peColor = color;
      document.querySelectorAll(".pe-color").forEach(x => x.classList.toggle("active", x === b));
    });
    document.getElementById("pe-colors").appendChild(b);
  });

  function closePhotoEditor(result) {
    photoEditor.classList.add("hidden");
    peHistory = [];
    const resolve = peResolve;
    peResolve = null;
    if (resolve) resolve(result);
  }

  document.getElementById("pe-cancel").addEventListener("click", () => closePhotoEditor(null));
  document.getElementById("pe-send").addEventListener("click", () => {
    peCanvas.toBlob(blob => {
      closePhotoEditor(blob ? new File([blob], "foto.jpg", { type: "image/jpeg" }) : null);
    }, "image/jpeg", 0.9);
  });

  // Resolves with the edited photo as a File, or null if cancelled.
  async function openPhotoEditor(file) {
    let img;
    try {
      img = await loadImageFile(file);
    } catch (e) {
      return file; // a format the browser can't draw (e.g. HEIC): send as it is
    }
    const scale = Math.min(1, PE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    peSetCanvasFrom(img, Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale));
    peHistory = [];
    peSetTool("draw");
    photoEditor.classList.remove("hidden");
    return new Promise(resolve => { peResolve = resolve; });
  }

  /* ---------------- Stickers ----------------
     A sticker is a small rounded square image (data URL, encrypted like a
     photo) shown without a bubble. Saved stickers stay on this device. */

  const STICKER_SIDE = 320;
  const STICKER_RE = /^data:image\/(webp|png);base64,[A-Za-z0-9+/=]+$/;
  const MAX_SAVED_STICKERS = 24;
  const stickerPicker = document.getElementById("sticker-picker");

  function isSticker(v) {
    return typeof v === "string" && v.length < 300000 && STICKER_RE.test(v);
  }

  async function makeSticker(file) {
    const img = await loadImageFile(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = STICKER_SIDE;
    const ctx = canvas.getContext("2d");
    const r = STICKER_SIDE * 0.18;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(STICKER_SIDE, 0, STICKER_SIDE, STICKER_SIDE, r);
    ctx.arcTo(STICKER_SIDE, STICKER_SIDE, 0, STICKER_SIDE, r);
    ctx.arcTo(0, STICKER_SIDE, 0, 0, r);
    ctx.arcTo(0, 0, STICKER_SIDE, 0, r);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, STICKER_SIDE, STICKER_SIDE);
    const webp = canvas.toDataURL("image/webp", 0.8);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  }

  async function saveSticker(dataUrl) {
    const list = chatPrefs().stickers.filter(s => s !== dataUrl);
    return setChatPref("stickers", [dataUrl, ...list].slice(0, MAX_SAVED_STICKERS));
  }

  function renderStickerPicker() {
    const grid = document.getElementById("sticker-grid");
    grid.innerHTML = "";
    const list = chatPrefs().stickers.filter(isSticker);
    if (!list.length) {
      grid.textContent = "Henüz çıkartman yok. Bir fotoğraftan yap ya da gelen bir çıkartmaya uzun basıp kaydet.";
      return;
    }
    list.forEach(src => {
      const b = document.createElement("button");
      b.className = "sticker-cell";
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      b.appendChild(img);
      b.addEventListener("click", async () => {
        stickerPicker.classList.add("hidden");
        try {
          await sendEncrypted(src, "sticker", takeReplyFields());
        } catch (e) {
          alert("Çıkartma gönderilemedi: " + e.message);
        }
      });
      attachLongPress(b, async () => {
        if (!confirm("Bu çıkartma silinsin mi?")) return;
        await setChatPref("stickers", chatPrefs().stickers.filter(s => s !== src));
        renderStickerPicker();
      });
      grid.appendChild(b);
    });
  }

  document.getElementById("attach-sticker-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    renderStickerPicker();
    stickerPicker.classList.remove("hidden");
  });
  document.getElementById("sticker-close").addEventListener("click", () => stickerPicker.classList.add("hidden"));
  const stickerPhotoInput = document.getElementById("sticker-photo-input");
  document.getElementById("sticker-make").addEventListener("click", () => stickerPhotoInput.click());
  stickerPhotoInput.addEventListener("change", async () => {
    const file = stickerPhotoInput.files[0];
    stickerPhotoInput.value = "";
    if (!file) return;
    try {
      await saveSticker(await makeSticker(file));
      renderStickerPicker();
    } catch (e) {
      alert("Çıkartma yapılamadı: " + e.message);
    }
  });

  /* ---------------- Search across all chats ----------------
     Names match right away; messages are searched in a decrypted index of
     each chat's latest SEARCH_PER_CHAT messages, built on first use and
     dropped when the vault locks. Locked chats are left out. */

  const SEARCH_PER_CHAT = 300;
  const globalSearchInput = document.getElementById("global-search-input");
  const globalSearchResults = document.getElementById("global-search-results");
  let messageIndex = null; // convId -> [{ id, text, ts, fromMe, from }]
  let messageIndexAt = 0;
  let messageIndexBuilding = null;
  let pendingJumpMsgId = null;
  let globalSearchTimer = null;

  async function buildMessageIndex() {
    const index = new Map();
    const convs = [...conversations.values()].filter(c => !isChatLocked(c.id));
    await Promise.all(convs.map(async c => {
      try {
        const snap = await fbDb.collection("conversations").doc(c.id).collection("messages")
          .orderBy("ts", "desc").limit(SEARCH_PER_CHAT).get();
        const out = [];
        for (const doc of snap.docs) {
          const d = doc.data();
          if (d.type !== "text" || d.deleted) continue;
          if (d.expiresAt && d.expiresAt.toMillis() <= Date.now()) continue;
          if (msgFlag("hiddenMsgs", c.id, doc.id)) continue;
          if (d.ts && d.ts.toMillis() <= chatDeletedAt(c.id)) continue;
          const text = await decryptMessage(d).catch(() => null);
          if (text) out.push({ id: doc.id, text, ts: d.ts ? d.ts.toMillis() : 0, fromMe: d.from === myUid, from: d.from });
        }
        index.set(c.id, out);
      } catch (e) { /* skip this chat */ }
    }));
    return index;
  }

  function ensureMessageIndex() {
    if (messageIndex && Date.now() - messageIndexAt < 60000) return Promise.resolve(messageIndex);
    if (!messageIndexBuilding) {
      messageIndexBuilding = buildMessageIndex().then(index => {
        messageIndexBuilding = null;
        if (!myUid) return null; // locked meanwhile
        messageIndex = index;
        messageIndexAt = Date.now();
        return index;
      });
    }
    return messageIndexBuilding;
  }

  function clearGlobalSearch() {
    globalSearchInput.value = "";
    globalSearchResults.classList.add("hidden");
    globalSearchResults.innerHTML = "";
    threadListPanel.classList.remove("searching");
  }

  function convTitle(c) {
    return c.isGroup ? "👥 " + c.groupName : "@" + c.otherNickname;
  }

  function openConvFromSearch(c, msgId) {
    pendingJumpMsgId = msgId || null;
    clearGlobalSearch();
    openConversation(c.id, c.otherUid, c.otherNickname, {
      isGroup: c.isGroup, groupName: c.groupName, participants: c.participants,
    });
  }

  function searchSnippet(text, q) {
    const i = text.toLowerCase().indexOf(q);
    const start = Math.max(0, i - 30);
    return (start ? "…" : "") + text.slice(start, i + q.length + 60);
  }

  async function runGlobalSearch() {
    const q = globalSearchInput.value.trim().toLocaleLowerCase("tr");
    if (!q) { clearGlobalSearch(); return; }
    threadListPanel.classList.add("searching");
    globalSearchResults.classList.remove("hidden");
    const head = title => {
      const h = document.createElement("p");
      h.className = "search-section";
      h.textContent = title;
      globalSearchResults.appendChild(h);
    };
    const row = (title, sub, onClick) => {
      const b = document.createElement("button");
      b.className = "media-row";
      const info = document.createElement("span");
      info.className = "media-row-info";
      const t = document.createElement("span");
      t.className = "media-row-title";
      t.textContent = title;
      const s = document.createElement("span");
      s.className = "media-row-sub";
      s.textContent = sub;
      info.append(t, s);
      b.appendChild(info);
      b.addEventListener("click", onClick);
      globalSearchResults.appendChild(b);
    };
    const render = index => {
      if (globalSearchInput.value.trim().toLocaleLowerCase("tr") !== q) return; // typed on
      globalSearchResults.innerHTML = "";
      const convs = [...conversations.values()];
      const nameHits = convs.filter(c => convTitle(c).toLocaleLowerCase("tr").includes(q));
      if (nameHits.length) {
        head("Sohbetler");
        nameHits.forEach(c => row(convTitle(c), c.lastPreview && !isChatLocked(c.id) ? c.lastPreview : "", () => openConvFromSearch(c)));
      }
      if (!index) {
        head("Mesajlar");
        const p = document.createElement("p");
        p.className = "media-empty";
        p.textContent = "Mesajlarda aranıyor…";
        globalSearchResults.appendChild(p);
        return;
      }
      const hits = [];
      index.forEach((msgs, convId) => {
        const c = conversations.get(convId);
        if (!c) return;
        msgs.forEach(m => { if (m.text.toLocaleLowerCase("tr").includes(q)) hits.push({ c, m }); });
      });
      hits.sort((a, b) => b.m.ts - a.m.ts);
      if (hits.length) {
        head("Mesajlar");
        hits.slice(0, 50).forEach(({ c, m }) => {
          const who = m.fromMe ? "Sen" : c.isGroup ? "@" + (c.participantNicknames[m.from] || "?") : "@" + c.otherNickname;
          row(convTitle(c) + " · " + formatThreadTime(m.ts), who + ": " + searchSnippet(m.text, q), () => openConvFromSearch(c, m.id));
        });
      }
      if (!nameHits.length && !hits.length) {
        const p = document.createElement("p");
        p.className = "media-empty";
        p.textContent = "Sonuç yok.";
        globalSearchResults.appendChild(p);
      }
    };
    render(messageIndex && Date.now() - messageIndexAt < 60000 ? messageIndex : null);
    render(await ensureMessageIndex());
  }

  globalSearchInput.addEventListener("input", () => {
    clearTimeout(globalSearchTimer);
    globalSearchTimer = setTimeout(runGlobalSearch, 250);
  });

  function forgetSearchAndLiveData() {
    messageIndex = null;
    messageIndexBuilding = null;
    pendingJumpMsgId = null;
    clearGlobalSearch();
  }

  /* ---------------- "Hakkımda" (about) ---------------- */

  function aboutOf(uid) {
    const p = profiles.get(uid);
    return (p && p.about) || "";
  }

  document.getElementById("about-save").addEventListener("click", async () => {
    const msgEl = document.getElementById("avatar-msg");
    const about = document.getElementById("about-input").value.trim().slice(0, 140);
    try {
      await fbDb.collection("users").doc(myUid).update({
        about: about || firebase.firestore.FieldValue.delete(),
      });
      msgEl.textContent = about ? "Hakkımda kaydedildi." : "Hakkımda silindi.";
    } catch (e) {
      msgEl.textContent = profileSaveError(e);
    }
  });

  /* ---------------- Default timer for new chats ---------------- */

  const defaultDisappearingEl = document.getElementById("default-disappearing");

  function defaultDisappearingSeconds() {
    const v = localSessionData && Number(localSessionData.defaultDisappearing);
    return [86400, 604800, 7776000].includes(v) ? v : 0;
  }

  defaultDisappearingEl.addEventListener("change", async () => {
    if (!localSessionData || !currentLocalKey) return;
    localSessionData.defaultDisappearing = Number(defaultDisappearingEl.value) || 0;
    await saveLocalPrefs();
  });

  /* ---------------- QR codes: show mine, scan someone's ----------------
     The code is "calcut-kisi:<uid>:<nickname>"; scanning looks the user up
     by uid (so a renamed user is still found) and opens a chat. Scanning
     needs the browser's BarcodeDetector (Chrome / Android). */

  const QR_PREFIX = "calcut-kisi:";
  const qrModal = document.getElementById("qr-modal");
  const qrVideo = document.getElementById("qr-video");
  let qrStream = null;
  let qrTimer = null;

  function parseContactQr(text) {
    const m = /^calcut-kisi:([A-Za-z0-9]{1,128})(?::(.*))?$/.exec((text || "").trim());
    return m ? { uid: m[1], nickname: m[2] || "" } : null;
  }

  function stopQrScan() {
    clearInterval(qrTimer);
    qrTimer = null;
    if (qrStream) qrStream.getTracks().forEach(t => t.stop());
    qrStream = null;
    qrVideo.srcObject = null;
    qrVideo.classList.add("hidden");
  }

  function closeQrModal() {
    stopQrScan();
    qrModal.classList.add("hidden");
  }

  document.getElementById("qr-close").addEventListener("click", closeQrModal);

  document.getElementById("my-qr-btn").addEventListener("click", () => {
    if (!myUid || typeof qrcode !== "function") return;
    const qr = qrcode(0, "M");
    qr.addData(QR_PREFIX + myUid + ":" + myNickname, "Byte");
    qr.make();
    document.getElementById("qr-title").textContent = "QR kodum · @" + myNickname;
    document.getElementById("qr-code").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
    document.getElementById("qr-hint").textContent = "Karşındaki kişi calcut'ta + → \"QR kod okut\" ile bunu okutunca seninle sohbet açılır.";
    qrModal.classList.remove("hidden");
  });

  async function onContactQr(text) {
    const c = parseContactQr(text);
    if (!c) return false;
    closeQrModal();
    if (c.uid === myUid) {
      alert("Bu senin kendi QR kodun.");
      return true;
    }
    await openContactChat(c.uid);
    return true;
  }

  document.getElementById("qr-scan-btn").addEventListener("click", async () => {
    document.getElementById("new-thread-modal").classList.add("hidden");
    if (!("BarcodeDetector" in window)) {
      alert("Bu cihaz QR kod okutmayı desteklemiyor. Kişinin kullanıcı adını yazarak ekleyebilirsin.");
      return;
    }
    let detector;
    try {
      detector = new BarcodeDetector({ formats: ["qr_code"] });
      qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch (e) {
      stopQrScan();
      alert("Kamera açılamadı.");
      return;
    }
    document.getElementById("qr-title").textContent = "QR kod okut";
    document.getElementById("qr-code").innerHTML = "";
    document.getElementById("qr-hint").textContent = "Kamerayı kişinin QR koduna tut.";
    qrVideo.srcObject = qrStream;
    qrVideo.classList.remove("hidden");
    qrModal.classList.remove("hidden");
    await qrVideo.play().catch(() => {});
    let busy = false;
    qrTimer = setInterval(async () => {
      if (busy || !qrStream) return;
      busy = true;
      try {
        const codes = await detector.detect(qrVideo);
        for (const code of codes) {
          if (await onContactQr(code.rawValue)) return;
        }
      } catch (e) { /* keep trying */ }
      busy = false;
    }, 400);
  });

  /* ---------------- Picking contacts (status privacy) ---------------- */

  function pickContacts(title, preselected) {
    const modal = document.getElementById("contact-picker-modal");
    const list = document.getElementById("contact-picker-list");
    document.getElementById("contact-picker-title").textContent = title;
    list.innerHTML = "";
    broadcastContacts().forEach(c => {
      const label = document.createElement("label");
      label.className = "toggle-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = c.uid;
      cb.checked = preselected.includes(c.uid);
      const span = document.createElement("span");
      span.textContent = "@" + c.nickname;
      label.append(cb, span);
      list.appendChild(label);
    });
    modal.classList.remove("hidden");
    return new Promise(resolve => {
      const ok = document.getElementById("contact-picker-ok");
      const cancel = document.getElementById("contact-picker-cancel");
      const done = result => {
        modal.classList.add("hidden");
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        resolve(result);
      };
      const onOk = () => done([...list.querySelectorAll("input:checked")].map(cb => cb.value));
      const onCancel = () => done(null);
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
    });
  }

  /* ---------------- Status privacy ----------------
     Who a new status is encrypted for: all contacts, all except some, or
     only some. Kept on this device (localSessionData.statusPrivacy). */

  function statusPrivacy() {
    const p = localSessionData && localSessionData.statusPrivacy;
    if (!p || !["except", "only"].includes(p.mode) || !Array.isArray(p.uids)) return { mode: "all", uids: [] };
    return p;
  }

  async function setStatusPrivacy(p) {
    if (!localSessionData || !currentLocalKey) return;
    localSessionData.statusPrivacy = p;
    await saveLocalPrefs();
  }

  function showStatusPrivacyMenu() {
    const p = statusPrivacy();
    const mark = mode => (p.mode === mode ? "✓ " : "");
    showActionSheet("Durumumu kimler görsün? (yeni durumlar için)", [
      { label: mark("all") + "Tüm kişilerim", run: () => setStatusPrivacy({ mode: "all", uids: [] }) },
      { label: mark("except") + "Kişilerim, şunlar hariç…", run: async () => {
        const uids = await pickContacts("Durumunu görmeyecek kişiler", p.mode === "except" ? p.uids : []);
        if (uids) await setStatusPrivacy({ mode: "except", uids });
      } },
      { label: mark("only") + "Yalnızca şunlarla paylaş…", run: async () => {
        const uids = await pickContacts("Durumunu görecek kişiler", p.mode === "only" ? p.uids : []);
        if (uids) await setStatusPrivacy({ mode: "only", uids });
      } },
    ]);
  }

  /* ---------------- Replying to / reacting to a status ----------------
     Goes as a normal message into the 1:1 chat with its author, quoting
     what the status was. */

  const statusReplyEl = document.getElementById("status-reply");
  const statusReplyInput = document.getElementById("status-reply-input");

  async function replyToStatus(text) {
    const s = statusQueue[statusIndex];
    if (!s || s.from === myUid || !text) return;
    const plain = statusPlain.get(s.id);
    const what = plain && plain.kind === "image" ? "📷 Fotoğraf" + (plain.text ? ": " + plain.text : "")
      : plain ? String(plain.text || "").slice(0, 80) : "Durum";
    const convId = convIdFor(myUid, s.from);
    try {
      if (!conversations.has(convId)) {
        await fbDb.collection("conversations").doc(convId).set({
          participants: [myUid, s.from],
          participantNicknames: { [myUid]: myNickname, [s.from]: nicknameOf(s.from) },
          unreadCount: { [myUid]: 0, [s.from]: 0 },
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      await sendEncryptedTo(convId, [s.from], "↩️ Durumuna yanıt (" + what + ")\n" + text, "text");
      const sent = document.getElementById("status-time");
      sent.textContent = "Gönderildi ✓";
    } catch (e) {
      alert("Yanıt gönderilemedi: " + e.message);
    }
  }

  statusReplyInput.addEventListener("focus", () => clearTimeout(statusTimer));
  statusReplyInput.addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("status-reply-send").click();
  });
  document.getElementById("status-reply-send").addEventListener("click", async () => {
    const text = statusReplyInput.value.trim();
    if (!text) return;
    statusReplyInput.value = "";
    statusReplyInput.blur();
    await replyToStatus(text);
    statusTimer = setTimeout(() => showStatusAt(statusIndex + 1), 1500);
  });
  statusReplyEl.querySelectorAll(".status-reactions button").forEach(b => b.addEventListener("click", async () => {
    clearTimeout(statusTimer);
    b.classList.add("sent");
    await replyToStatus(b.dataset.emoji);
    setTimeout(() => b.classList.remove("sent"), 800);
    statusTimer = setTimeout(() => showStatusAt(statusIndex + 1), 1500);
  }));

  /* ---------------- View-once voice messages ---------------- */

  let voiceOnce = false;
  const voiceOnceBtn = document.getElementById("voice-preview-once");
  voiceOnceBtn.addEventListener("click", () => {
    voiceOnce = !voiceOnce;
    voiceOnceBtn.classList.toggle("active", voiceOnce);
    voiceOnceBtn.title = voiceOnce ? "Tek seferlik: açık" : "Tek seferlik";
  });

  // Plays once, then deletes the message (and its chunks) for both sides.
  function playViewOnceAudio(m, el) {
    const convId = activeConvId;
    const audio = new Audio(m.audio);
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      try {
        await fbDb.collection("conversations").doc(convId).collection("messages").doc(m.id).delete();
        await deleteChunks(m.chunked);
      } catch (e) {}
    };
    el.textContent = "🎤 Çalınıyor… (bittiğinde silinir)";
    audio.addEventListener("ended", finish);
    audio.addEventListener("error", () => { el.textContent = "🎤 Çalınamadı"; });
    audio.play().catch(() => { el.textContent = "🎤 Çalınamadı, tekrar dokun"; });
  }

  /* ---------------- Toast ---------------- */

  const toastEl = document.getElementById("toast");
  let toastTimer = null;

  function showToast(text, ms) {
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.classList.remove("hidden");
    if (ms) toastTimer = setTimeout(hideToast, ms);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.add("hidden");
  }

  /* ---------------- Video statuses ----------------
     Up to STATUS_VIDEO_MAX_S seconds. Big videos are re-recorded at 480p
     first. The bytes are encrypted with the status key and stored in
     statuses/{id}/chunks (written before the status itself). */

  const STATUS_VIDEO_MAX_S = 30;
  const STATUS_VIDEO_KEEP_BYTES = 6 * 1024 * 1024; // smaller files go as they are
  const STATUS_VIDEO_MAX_BYTES = 14 * 1024 * 1024;
  const STATUS_CHUNK_CHARS = 700 * 1024;
  const statusVideoUrls = new Map(); // status id -> blob: URL

  function loadVideoMeta(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.preload = "auto";
      v.playsInline = true;
      v.muted = true;
      v.onloadedmetadata = () => resolve(v);
      v.onerror = () => reject(new Error("video açılamadı"));
      v.src = url;
    });
  }

  // Re-records the video at 480p (and at most STATUS_VIDEO_MAX_S seconds)
  // by playing it into a canvas; takes as long as the video plays.
  async function shrinkStatusVideo(file, onProgress) {
    const url = URL.createObjectURL(file);
    try {
      const v = await loadVideoMeta(url);
      const length = Math.min(v.duration || 0, STATUS_VIDEO_MAX_S);
      if (file.size <= STATUS_VIDEO_KEEP_BYTES && v.duration <= STATUS_VIDEO_MAX_S + 0.5) return file;
      if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
        throw new Error("bu cihaz videoyu küçültemiyor; daha kısa bir video seç");
      }
      const scale = Math.min(1, 480 / Math.min(v.videoWidth, v.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(v.videoWidth * scale / 2) * 2;
      canvas.height = Math.round(v.videoHeight * scale / 2) * 2;
      const ctx = canvas.getContext("2d");
      const stream = canvas.captureStream(30);
      let audioCtx = null;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctx();
        const dest = audioCtx.createMediaStreamDestination();
        audioCtx.createMediaElementSource(v).connect(dest); // not to the speakers
        dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        v.muted = false;
      } catch (e) { /* no sound then */ }
      const mime = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find(t => MediaRecorder.isTypeSupported(t)) || "";
      const recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 1000000, audioBitsPerSecond: 64000 });
      const parts = [];
      recorder.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
      const done = new Promise(resolve => { recorder.onstop = resolve; });
      let frame = null;
      const draw = () => {
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        if (onProgress && length) onProgress(Math.min(1, v.currentTime / length));
        if (v.currentTime >= length || v.ended) {
          if (recorder.state !== "inactive") recorder.stop();
          v.pause();
          return;
        }
        frame = requestAnimationFrame(draw);
      };
      recorder.start(1000);
      await v.play();
      draw();
      await done;
      cancelAnimationFrame(frame);
      stream.getTracks().forEach(t => t.stop());
      if (audioCtx) audioCtx.close().catch(() => {});
      return new Blob(parts, { type: recorder.mimeType || "video/webm" });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function postVideoStatus(file) {
    const audience = statusAudience();
    if (!audience.length) {
      alert("Durum paylaşmak için önce en az bir kişiyle sohbetin olmalı.");
      return;
    }
    showToast("Video hazırlanıyor…");
    const blob = await shrinkStatusVideo(file, p => showToast("Video hazırlanıyor… %" + Math.round(p * 100)));
    if (blob.size > STATUS_VIDEO_MAX_BYTES) throw new Error("video çok büyük; daha kısa bir video seç");
    const caption = (prompt("Açıklama (isteğe bağlı):") || "").trim().slice(0, 300);
    const key = await makeMessageKey(audience);
    if (!key) return;
    const vIv = crypto.getRandomValues(new Uint8Array(12));
    const data = b64encode(await crypto.subtle.encrypt({ name: "AES-GCM", iv: vIv }, key.aesKey, await blob.arrayBuffer()));
    const ref = fbDb.collection("statuses").doc();
    const n = Math.ceil(data.length / STATUS_CHUNK_CHARS);
    for (let i = 0; i < n; i += 4) {
      showToast("Video yükleniyor… %" + Math.round(i / n * 100));
      const batch = fbDb.batch();
      for (let j = i; j < Math.min(i + 4, n); j++) {
        batch.set(ref.collection("chunks").doc(String(j)), { from: myUid, idx: j, data: data.slice(j * STATUS_CHUNK_CHARS, (j + 1) * STATUS_CHUNK_CHARS) });
      }
      await batch.commit();
    }
    const payload = { kind: "video", mime: blob.type || "video/webm", n, vIv: b64encode(vIv.buffer), text: caption };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key.aesKey, new TextEncoder().encode(JSON.stringify(payload)));
    await ref.set({
      from: myUid,
      audience,
      kind: "video",
      iv: b64encode(iv.buffer),
      ciphertext: b64encode(ciphertext),
      wrappedKeys: key.wrappedKeys,
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      expiresAt: firebase.firestore.Timestamp.fromMillis(Date.now() + STATUS_TTL_MS),
    });
    showToast("Video durumu paylaşıldı ✓", 2500);
  }

  const statusVideoInput = document.getElementById("status-video-input");
  statusVideoInput.addEventListener("change", async () => {
    const file = statusVideoInput.files[0];
    statusVideoInput.value = "";
    if (!file) return;
    try {
      await postVideoStatus(file);
    } catch (e) {
      hideToast();
      alert("Video durumu paylaşılamadı: " + (e && e.code === "permission-denied" ? "Firestore kurallarının güncellenmesi gerekiyor." : e.message));
    }
  });

  async function statusVideoUrl(s, plain) {
    if (statusVideoUrls.has(s.id)) return statusVideoUrls.get(s.id);
    const wrapped = s.raw.wrappedKeys && s.raw.wrappedKeys[myUid];
    if (!wrapped) throw new Error("no key");
    const rawAes = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, myPrivateKey, b64decode(wrapped));
    const aesKey = await crypto.subtle.importKey("raw", rawAes, { name: "AES-GCM" }, false, ["decrypt"]);
    const snap = await fbDb.collection("statuses").doc(s.id).collection("chunks").get();
    const parts = snap.docs.map(d => d.data()).sort((a, b) => a.idx - b.idx);
    if (parts.length !== plain.n) throw new Error("incomplete");
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64decode(plain.vIv)) }, aesKey, b64decode(parts.map(p => p.data).join(""))
    );
    const url = URL.createObjectURL(new Blob([bytes], { type: typeof plain.mime === "string" && plain.mime.startsWith("video/") ? plain.mime : "video/webm" }));
    statusVideoUrls.set(s.id, url);
    return url;
  }

  async function deleteStatusWithChunks(ref) {
    const chunks = await ref.collection("chunks").get().catch(() => null);
    await ref.delete();
    if (chunks) await Promise.all(chunks.docs.map(d => d.ref.delete().catch(() => {})));
  }

  function forgetStatusVideos() {
    statusVideoUrls.forEach(url => URL.revokeObjectURL(url));
    statusVideoUrls.clear();
  }

  /* ---------------- Events ----------------
     An "event" message: { title, when, place } (encrypted). Replies are
     rsvp.{uid} = "yes" | "maybe" | "no" on the message, each person only
     their own (firestore.rules). */

  const eventModal = document.getElementById("event-modal");
  const RSVP_LABELS = { yes: "✓ Katılıyorum", maybe: "? Belki", no: "✕ Katılmıyorum" };

  document.getElementById("attach-event-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    document.getElementById("event-title").value = "";
    document.getElementById("event-place").value = "";
    const soon = new Date(Date.now() + 86400000);
    soon.setMinutes(0, 0, 0);
    const pad = x => String(x).padStart(2, "0");
    document.getElementById("event-when").value =
      `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:00`;
    eventModal.classList.remove("hidden");
  });
  document.getElementById("event-cancel").addEventListener("click", () => eventModal.classList.add("hidden"));
  document.getElementById("event-send").addEventListener("click", async () => {
    const title = document.getElementById("event-title").value.trim();
    const when = new Date(document.getElementById("event-when").value).getTime();
    const place = document.getElementById("event-place").value.trim();
    if (!title || !Number.isFinite(when)) {
      alert("Etkinlik adı ve tarihi gerekli.");
      return;
    }
    eventModal.classList.add("hidden");
    try {
      await sendEncrypted(JSON.stringify({ title, when, place }), "event", takeReplyFields());
    } catch (e) {
      alert("Etkinlik gönderilemedi: " + e.message);
    }
  });

  function formatEventTime(ms) {
    return new Date(ms).toLocaleString("tr-TR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  }

  function renderEvent(m) {
    const ev = m.event;
    const box = document.createElement("div");
    box.className = "event-card";
    const title = document.createElement("span");
    title.className = "event-title";
    title.textContent = "📅 " + String(ev.title || "Etkinlik");
    box.appendChild(title);
    if (Number.isFinite(Number(ev.when))) {
      const when = document.createElement("span");
      when.className = "event-when";
      when.textContent = "🕒 " + formatEventTime(Number(ev.when)) + (Number(ev.when) < Date.now() ? " (geçti)" : "");
      box.appendChild(when);
    }
    if (ev.place) {
      const place = document.createElement("span");
      place.className = "event-place";
      place.textContent = "📍 " + String(ev.place);
      box.appendChild(place);
    }
    const rsvp = m.rsvp || {};
    const mine = rsvp[myUid];
    const row = document.createElement("div");
    row.className = "event-rsvp";
    Object.keys(RSVP_LABELS).forEach(k => {
      const count = Object.values(rsvp).filter(v => v === k).length;
      const b = document.createElement("button");
      b.className = "event-rsvp-btn" + (mine === k ? " mine" : "");
      b.dataset.msgId = m.id;
      b.dataset.rsvp = k;
      b.textContent = RSVP_LABELS[k] + (count ? " · " + count : "");
      row.appendChild(b);
    });
    box.appendChild(row);
    const ics = document.createElement("button");
    ics.className = "event-ics-btn";
    ics.dataset.msgId = m.id;
    ics.textContent = "🗓 Takvime ekle";
    box.appendChild(ics);
    return box;
  }

  async function setRsvp(msgId, value) {
    const m = currentMessages.find(x => x.id === msgId);
    if (!m) return;
    const same = (m.rsvp || {})[myUid] === value;
    try {
      await fbDb.collection("conversations").doc(activeConvId).collection("messages").doc(msgId).update({
        [`rsvp.${myUid}`]: same ? firebase.firestore.FieldValue.delete() : value,
      });
    } catch (e) {
      alert(e && e.code === "permission-denied"
        ? "Yanıt verilemedi: Firestore kurallarının güncellenmesi gerekiyor."
        : "Yanıt verilemedi: " + e.message);
    }
  }

  // A small .ics file the phone's calendar app can open.
  function eventIcs(ev) {
    const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const esc = t => String(t || "").replace(/[\\,;]/g, c => "\\" + c).replace(/\n/g, "\\n");
    const start = Number(ev.when);
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//calcut//TR", "BEGIN:VEVENT",
      "UID:" + start + "-" + Math.random().toString(36).slice(2) + "@calcut",
      "DTSTAMP:" + stamp(Date.now()), "DTSTART:" + stamp(start), "DTEND:" + stamp(start + 3600000),
      "SUMMARY:" + esc(ev.title), ev.place ? "LOCATION:" + esc(ev.place) : null,
      "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean).join("\r\n");
  }

  async function saveEventToCalendar(msgId) {
    const m = currentMessages.find(x => x.id === msgId);
    if (!m || !m.event || !Number.isFinite(Number(m.event.when))) return;
    const file = new File([eventIcs(m.event)], "etkinlik.ics", { type: "text/calendar" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = "etkinlik.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ---------------- Storage ----------------
     How much each chat's photos, videos, voice messages and files take in
     the database (estimated from the message sizes, without downloading
     them), and deleting them for everyone to free space. */

  const STORAGE_MEDIA_TYPES = ["image", "file", "audio", "sticker"];
  const storageModal = document.getElementById("storage-modal");

  function estimatedBytes(d) {
    if (d.chunked) return d.chunked.n * (d.chunked.bin ? BIN_CHUNK_BYTES * 1.37 : CHUNK_CHARS);
    return (d.ciphertext || "").length;
  }

  function formatBytes(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  async function chatStorage(c) {
    const snap = await fbDb.collection("conversations").doc(c.id).collection("messages").orderBy("ts").get();
    let total = 0;
    const media = [];
    snap.docs.forEach(doc => {
      const d = doc.data();
      const bytes = estimatedBytes(d);
      total += bytes;
      if (STORAGE_MEDIA_TYPES.includes(d.type) && !d.deleted) media.push({ ref: doc.ref, chunked: d.chunked || null, bytes });
    });
    return { c, total, count: snap.size, media, mediaBytes: media.reduce((a, m) => a + m.bytes, 0) };
  }

  async function openStorage() {
    const list = document.getElementById("storage-list");
    const summary = document.getElementById("storage-summary");
    list.innerHTML = "";
    summary.textContent = "Hesaplanıyor…";
    storageModal.classList.remove("hidden");
    const rows = (await Promise.all([...conversations.values()].map(c => chatStorage(c).catch(() => null)))).filter(Boolean);
    rows.sort((a, b) => b.total - a.total);
    const total = rows.reduce((a, r) => a + r.total, 0);
    summary.textContent = "Toplam yaklaşık " + formatBytes(total) + " (ücretsiz kota: 1 GB). Bir sohbete dokunup medyasını silebilirsin.";
    rows.forEach(r => {
      const row = galleryRow(r.c.isGroup ? "👥" : "💬", r.c.isGroup ? r.c.groupName : "@" + r.c.otherNickname,
        formatBytes(r.total) + " · " + r.count + " mesaj · medya " + formatBytes(r.mediaBytes) + " (" + r.media.length + ")");
      row.addEventListener("click", () => {
        if (!r.media.length) {
          alert("Bu sohbette silinecek medya yok.");
          return;
        }
        if (!confirm("Bu sohbetteki " + r.media.length + " fotoğraf, video, sesli mesaj ve dosya (" + formatBytes(r.mediaBytes) + ") herkesten silinsin mi? Geri alınamaz.")) return;
        deleteChatMedia(r).then(openStorage);
      });
      list.appendChild(row);
    });
  }

  async function deleteChatMedia(r) {
    showToast("Siliniyor…");
    for (let i = 0; i < r.media.length; i++) {
      showToast("Siliniyor… " + (i + 1) + "/" + r.media.length);
      const m = r.media[i];
      await m.ref.delete().catch(() => {});
      await deleteChunks(m.chunked).catch(() => {});
    }
    showToast("Silindi ✓", 2000);
  }

  document.getElementById("storage-btn").addEventListener("click", openStorage);
  document.getElementById("storage-close").addEventListener("click", () => storageModal.classList.add("hidden"));

  /* ---------------- Per-chat notification sound ----------------
     A chat can ring with its own sound while the app is open. Background
     notifications don't say which chat they're from (by design), so those
     use the sound set in Settings. Kept on this device. */

  function chatSoundFor(convId) {
    const m = localSessionData && localSessionData.chatSounds;
    const id = m && typeof m === "object" ? m[convId] : null;
    return id && SOUND_PRESETS[id] ? id : null;
  }

  function chooseChatSound() {
    const convId = activeConvId;
    if (!convId || !localSessionData) return;
    const current = chatSoundFor(convId);
    const set = async id => {
      const sounds = { ...(localSessionData.chatSounds || {}) };
      if (id) sounds[convId] = id;
      else delete sounds[convId];
      localSessionData.chatSounds = sounds;
      await saveLocalPrefs();
      if (id) playSoundOnce(id);
    };
    const actions = [{ label: (current ? "" : "✓ ") + "Varsayılan (Ayarlar'daki)", run: () => set(null) }];
    Object.keys(SOUND_PRESETS).forEach(id => {
      actions.push({ label: (current === id ? "✓ " : "") + SOUND_PRESETS[id].name, run: () => set(id) });
    });
    showActionSheet("Bu sohbetin bildirim sesi (uygulama açıkken)", actions);
  }

  const viewOnceInput = document.getElementById("viewonce-input");
  document.getElementById("attach-viewonce-btn").addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    viewOnceInput.click();
  });
  viewOnceInput.addEventListener("change", () => {
    const files = Array.from(viewOnceInput.files || []);
    viewOnceInput.value = "";
    sendPickedFiles(files, { viewOnce: true });
  });
  // Several photos/files can be picked at once (like WhatsApp's gallery
  // picker); they go one after another, in the order picked, and only the
  // first carries a pending reply.
  const MAX_FILES_PER_SEND = 30;

  [photoInput, cameraInput].forEach(input => input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    input.value = "";
    sendPickedFiles(files);
  }));

  const uploadStatusEl = document.getElementById("upload-status");

  // opts.viewOnce: send photos as view-once (opened once, then deleted).
  async function sendPickedFiles(files, opts) {
    opts = opts || {};
    if (!files.length) return;
    // A single photo can be drawn on, captioned, cropped or rotated first.
    if (files.length === 1 && files[0].type.startsWith("image/") && files[0].type !== "image/gif") {
      const edited = await openPhotoEditor(files[0]);
      if (!edited) return;
      files = [edited];
    }
    if (files.length > MAX_FILES_PER_SEND) {
      alert("Tek seferde en fazla " + MAX_FILES_PER_SEND + " dosya seçebilirsin.");
      return;
    }
    // Large payloads are split over chunk documents (see CHUNK_CHARS), but
    // a file is still held several times over in memory while it's encoded
    // and encrypted, and stored at ~1.8x its size in Firestore's 1GiB free
    // quota, so there is a cap rather than none.
    const maxSize = 50 * 1024 * 1024;
    // Videos and other big files go through the chunked-bytes path, which
    // allows much larger files (LARGE_FILE_MAX) without the memory cost.
    const isLarge = f => !f.type.startsWith("image/") && (f.type.startsWith("video/") || f.size > 2 * 1024 * 1024);
    const limitOf = f => (isLarge(f) && !opts.viewOnce ? LARGE_FILE_MAX : maxSize);
    const tooBig = files.filter(f => f.size > limitOf(f));
    const toSend = files.filter(f => f.size <= limitOf(f));
    let replyFields = takeReplyFields();
    const failed = [];
    for (const file of toSend) {
      const isImage = file.type.startsWith("image/");
      try {
        const dataUrl = await readAsDataUrl(file);
        if (!isImage && !opts.viewOnce && isLarge(file)) {
          await sendLargeFileTo(activeConvId, activeOtherUids, file, replyFields, p => {
            uploadStatusEl.textContent = file.name + " gönderiliyor… %" + Math.round(p * 100);
            uploadStatusEl.classList.remove("hidden");
          });
          uploadStatusEl.classList.add("hidden");
        } else if (isImage) {
          const fields = opts.viewOnce ? { ...(replyFields || {}), viewOnce: true } : replyFields;
          await sendEncrypted(await shrinkPhoto(dataUrl, file.type), "image", fields);
        } else if (opts.viewOnce) {
          throw new Error("tek seferlik yalnızca fotoğraf olabilir");
        } else {
          const payload = JSON.stringify({ name: file.name, mime: file.type, size: file.size, dataUrl });
          await sendEncrypted(payload, "file", replyFields);
        }
        replyFields = null;
      } catch (e) {
        failed.push(file.name + " (" + e.message + ")");
      }
    }
    const problems = [];
    uploadStatusEl.classList.add("hidden");
    if (tooBig.length) problems.push("Boyut sınırını aştığı için gönderilmedi (fotoğraf 50MB, video/dosya 200MB): " + tooBig.map(f => f.name).join(", "));
    if (failed.length) problems.push("Gönderilemedi: " + failed.join(", "));
    if (problems.length) alert(problems.join("\n"));
  }

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Phone photos are often 3-8MB; like WhatsApp, send them scaled to at
  // most PHOTO_MAX_SIDE px as JPEG, which looks the same on a phone and
  // sends several times faster. GIFs (animation) and photos that are
  // already small enough go as they are.
  const PHOTO_MAX_SIDE = 1600;

  async function shrinkPhoto(dataUrl, mime) {
    if (mime === "image/gif") return dataUrl;
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("decode"));
        i.src = dataUrl;
      });
      const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const jpeg = canvas.toDataURL("image/jpeg", 0.82);
      return jpeg.length < dataUrl.length ? jpeg : dataUrl;
    } catch (e) {
      return dataUrl; // a format the browser can't draw (e.g. HEIC): send the original
    }
  }

  /* ---------------- Voice messages ---------------- */

  const VOICE_MAX_MS = 5 * 60 * 1000;
  const inputRow = document.querySelector(".message-input-row");
  const voiceTimerEl = document.getElementById("voice-timer");
  let voiceRecorder = null;
  let voiceChunks = [];
  let voiceStartedAt = 0;
  let voiceTick = null;
  let voiceSendOnStop = false;

  function voiceMimeType() {
    if (!window.MediaRecorder) return null;
    // Opus in WebM on Android/Chrome, AAC in MP4 on iPhone/Safari.
    return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"]
      .find(t => MediaRecorder.isTypeSupported(t)) || "";
  }

  function formatVoiceTime(ms) {
    const sec = Math.floor(ms / 1000);
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  async function startVoiceRecording() {
    const mimeType = voiceMimeType();
    if (mimeType === null) {
      alert("Bu cihaz ses kaydını desteklemiyor.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("Mikrofon erişimi reddedildi veya kullanılamıyor.");
      return;
    }
    voiceChunks = [];
    voiceSendOnStop = false;
    voiceRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    voiceRecorder.ondataavailable = e => { if (e.data && e.data.size) voiceChunks.push(e.data); };
    voiceRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const send = voiceSendOnStop;
      const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || mimeType || "audio/webm" });
      voiceRecorder = null;
      voiceChunks = [];
      endVoiceUi();
      if (!send || !blob.size) return;
      if (send === "preview") {
        showVoicePreview(blob);
        return;
      }
      try {
        await sendEncrypted(await readAsDataUrl(blob), "audio", takeReplyFields());
      } catch (e) {
        alert("Sesli mesaj gönderilemedi: " + e.message);
      }
    };
    voiceRecorder.start();
    voiceStartedAt = Date.now();
    voiceTimerEl.textContent = "0:00";
    inputRow.classList.add("recording");
    voiceTick = setInterval(() => {
      const elapsed = Date.now() - voiceStartedAt;
      voiceTimerEl.textContent = formatVoiceTime(elapsed);
      if (elapsed >= VOICE_MAX_MS) stopVoiceRecording(true);
    }, 250);
  }

  function stopVoiceRecording(send) {
    if (!voiceRecorder || voiceRecorder.state === "inactive") return;
    voiceSendOnStop = send;
    voiceRecorder.stop();
  }

  // ⏹ stops the recording without sending it, to listen to it first.
  const voicePreview = document.getElementById("voice-preview");
  const voicePreviewAudio = document.getElementById("voice-preview-audio");
  let voicePreviewBlob = null;

  function showVoicePreview(blob) {
    discardVoicePreview();
    voicePreviewBlob = blob;
    voicePreviewAudio.src = URL.createObjectURL(blob);
    voicePreview.classList.remove("hidden");
    inputRow.classList.add("previewing");
  }

  function discardVoicePreview() {
    if (voicePreviewAudio.src) {
      voicePreviewAudio.pause();
      URL.revokeObjectURL(voicePreviewAudio.src);
      voicePreviewAudio.removeAttribute("src");
    }
    voicePreviewBlob = null;
    voiceOnce = false;
    const onceBtn = document.getElementById("voice-preview-once");
    onceBtn.classList.remove("active");
    onceBtn.title = "Tek seferlik";
    voicePreview.classList.add("hidden");
    inputRow.classList.remove("previewing");
  }

  document.getElementById("voice-stop-btn").addEventListener("click", () => stopVoiceRecording("preview"));
  document.getElementById("voice-preview-delete").addEventListener("click", discardVoicePreview);
  document.getElementById("voice-preview-send").addEventListener("click", async () => {
    const blob = voicePreviewBlob;
    const once = voiceOnce;
    discardVoicePreview();
    if (!blob) return;
    try {
      const fields = takeReplyFields() || {};
      if (once) fields.viewOnce = true;
      await sendEncrypted(await readAsDataUrl(blob), "audio", Object.keys(fields).length ? fields : null);
    } catch (e) {
      alert("Sesli mesaj gönderilemedi: " + e.message);
    }
  });

  // Leaving a chat (or locking) drops a pending reply and discards a recording.
  function leaveComposer() {
    cancelReply();
    attachMenu.classList.add("hidden");
    stopVoiceRecording(false);
    discardVoicePreview();
  }

  function endVoiceUi() {
    clearInterval(voiceTick);
    voiceTick = null;
    inputRow.classList.remove("recording");
  }

  document.getElementById("voice-btn").addEventListener("click", startVoiceRecording);
  document.getElementById("voice-send-btn").addEventListener("click", () => stopVoiceRecording(true));
  document.getElementById("voice-cancel-btn").addEventListener("click", () => stopVoiceRecording(false));

  /* ---------------- Full-screen photo viewer ---------------- */

  const imageViewer = document.getElementById("image-viewer");

  let imageViewerOnClose = null;

  // opts.viewOnce hides the download button; opts.onClose runs when closed.
  function openImageViewer(src, opts) {
    opts = opts || {};
    document.getElementById("image-viewer-img").src = src;
    const download = document.getElementById("image-viewer-download");
    download.href = src;
    download.download = "foto" + (src.startsWith("data:image/png") ? ".png" : ".jpg");
    download.classList.toggle("hidden", !!opts.viewOnce);
    imageViewerOnClose = opts.onClose || null;
    imageViewer.classList.remove("hidden");
  }

  function closeImageViewer() {
    if (imageViewer.classList.contains("hidden")) return;
    imageViewer.classList.add("hidden");
    document.getElementById("image-viewer-img").src = "";
    const onClose = imageViewerOnClose;
    imageViewerOnClose = null;
    if (onClose) onClose();
  }

  imageViewer.addEventListener("click", (e) => {
    if (e.target.closest("#image-viewer-download")) return;
    closeImageViewer();
  });

  document.getElementById("thread-back-btn").addEventListener("click", () => {
    leaveComposer();
    clearInterval(presenceTick);
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

  document.getElementById("thread-delete-btn").addEventListener("click", () => {
    const conv = activeConv();
    if (conv) askDeleteChat(conv);
  });

})();

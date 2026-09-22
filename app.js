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

  document.querySelectorAll(".btn[data-num]").forEach(btn => {
    btn.addEventListener("click", () => { inputNumber(btn.dataset.num); renderCalc(); });
  });
  document.querySelectorAll(".btn[data-op]").forEach(btn => {
    btn.addEventListener("click", () => { inputOp(btn.dataset.op); renderCalc(); });
  });
  document.querySelectorAll(".btn[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "clear") clearAll();
      else if (action === "sign") signToggle();
      else if (action === "percent") percent();
      else if (action === "equals") { equals(); return; }
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
    if (fbAuth.currentUser && myPrivateKey) {
      enterMessenger();
    } else {
      openAuthPanel();
    }
  }

  async function unlockWithPin(pin) {
    const key = await deriveLocalKey(pin);
    if (!vaultExists()) {
      await saveLocalBlob(key, {});
      return true;
    }
    try {
      await loadLocalBlob(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function tryAutoUnlock(pin) {
    if (!vaultExists()) return false; // require explicit setup via triple-tap gesture first
    const key = await deriveLocalKey(pin);
    try {
      await loadLocalBlob(key);
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
  let myEmail = null;
  let myPrivateKey = null;
  let myPublicKey = null;
  const publicKeyCache = new Map(); // uid -> CryptoKey

  const authTitle = document.getElementById("auth-title");
  const authEmailInput = document.getElementById("auth-email-input");
  const authPasswordInput = document.getElementById("auth-password-input");
  const authSubmitBtn = document.getElementById("auth-submit-btn");
  const authToggleBtn = document.getElementById("auth-toggle-btn");
  const authBackBtn = document.getElementById("auth-back-btn");
  const authError = document.getElementById("auth-error");
  let authMode = "login"; // or "signup"

  function openAuthPanel() {
    authPanel.classList.remove("hidden");
    appPanel.classList.add("hidden");
    authError.textContent = "";
    authPasswordInput.value = "";
  }

  authToggleBtn.addEventListener("click", () => {
    authMode = authMode === "login" ? "signup" : "login";
    authTitle.textContent = authMode === "login" ? "Giriş Yap" : "Hesap Oluştur";
    authSubmitBtn.textContent = authMode === "login" ? "Giriş Yap" : "Kayıt Ol";
    authToggleBtn.textContent = authMode === "login" ? "Hesabın yok mu? Kayıt ol" : "Zaten hesabın var mı? Giriş yap";
    authError.textContent = "";
  });

  authBackBtn.addEventListener("click", closeVaultToCalculator);

  async function generateKeyPair() {
    return crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function signUp(email, password) {
    const cred = await fbAuth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
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

    await fbDb.collection("users").doc(uid).set({
      email: email.toLowerCase(),
      publicKeyJwk: pubJwk,
      pkSalt: b64encode(pkSalt.buffer),
      encPrivateKey: { iv: b64encode(iv.buffer), data: b64encode(encPriv) },
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    myUid = uid;
    myEmail = email.toLowerCase();
    myPrivateKey = keyPair.privateKey;
    myPublicKey = keyPair.publicKey;
    publicKeyCache.set(uid, keyPair.publicKey);
  }

  async function logIn(email, password) {
    const cred = await fbAuth.signInWithEmailAndPassword(email, password);
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
    myEmail = data.email;
    myPrivateKey = privateKey;
    myPublicKey = publicKey;
    publicKeyCache.set(uid, publicKey);
  }

  authSubmitBtn.addEventListener("click", async () => {
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;
    if (!email || password.length < 6) {
      authError.textContent = "Geçerli bir e-posta ve en az 6 karakterli parola gir.";
      return;
    }
    authError.textContent = "";
    authSubmitBtn.disabled = true;
    try {
      if (authMode === "signup") {
        await signUp(email, password);
      } else {
        await logIn(email, password);
      }
      enterMessenger();
    } catch (e) {
      authError.textContent = humanizeAuthError(e);
    } finally {
      authSubmitBtn.disabled = false;
    }
  });

  function humanizeAuthError(e) {
    const code = e && e.code;
    if (code === "auth/email-already-in-use") return "Bu e-posta zaten kayıtlı.";
    if (code === "auth/invalid-email") return "Geçersiz e-posta.";
    if (code === "auth/weak-password") return "Parola çok zayıf (en az 6 karakter).";
    if (code === "auth/wrong-password" || code === "auth/invalid-credential") return "E-posta veya parola yanlış.";
    if (code === "auth/user-not-found") return "Bu e-postayla kayıtlı hesap yok.";
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

  let conversations = new Map(); // convId -> {id, otherUid, otherEmail, lastText, updatedAt}
  let conversationsUnsub = null;
  let activeConvId = null;
  let activeOtherUid = null;
  let messagesUnsub = null;

  function convIdFor(uidA, uidB) {
    return [uidA, uidB].sort().join("_");
  }

  function enterMessenger() {
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

  function listenToConversations() {
    if (conversationsUnsub) conversationsUnsub();
    conversationsUnsub = fbDb.collection("conversations")
      .where("participants", "array-contains", myUid)
      .onSnapshot(snap => {
        conversations.clear();
        snap.docs.forEach(doc => {
          const d = doc.data();
          const otherUid = d.participants.find(u => u !== myUid);
          const otherEmail = (d.participantEmails && d.participantEmails[otherUid]) || "?";
          conversations.set(doc.id, {
            id: doc.id,
            otherUid,
            otherEmail,
            updatedAt: d.updatedAt ? d.updatedAt.toMillis() : 0,
          });
        });
        if (!threadDetailPanel.classList.contains("hidden")) return;
        renderThreadList();
      }, err => console.error("conversations listen error", err));
  }

  function renderThreadList() {
    threadListEl.innerHTML = "";
    const list = Array.from(conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = "Henüz sohbet yok. '+' ile bir kişinin e-postasını ekle.";
      li.style.cursor = "default";
      threadListEl.appendChild(li);
      return;
    }
    list.forEach(conv => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="thread-name"></span><span class="thread-preview">Aç ve sohbet et</span>`;
      li.querySelector(".thread-name").textContent = conv.otherEmail;
      li.addEventListener("click", () => openConversation(conv.id, conv.otherUid, conv.otherEmail));
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
    const email = document.getElementById("new-thread-name").value.trim().toLowerCase();
    if (!email) return;
    if (email === myEmail) {
      alert("Kendi e-postanı ekleyemezsin.");
      return;
    }
    try {
      const q = await fbDb.collection("users").where("email", "==", email).limit(1).get();
      if (q.empty) {
        alert("Bu e-postayla kayıtlı bir kullanıcı bulunamadı.");
        return;
      }
      const otherDoc = q.docs[0];
      const otherUid = otherDoc.id;
      const otherData = otherDoc.data();
      const convId = convIdFor(myUid, otherUid);
      await fbDb.collection("conversations").doc(convId).set({
        participants: [myUid, otherUid],
        participantEmails: { [myUid]: myEmail, [otherUid]: otherData.email },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      document.getElementById("new-thread-modal").classList.add("hidden");
      openConversation(convId, otherUid, otherData.email);
    } catch (e) {
      alert("Sohbet eklenemedi: " + e.message);
    }
  });

  document.getElementById("lock-btn").addEventListener("click", () => {
    if (conversationsUnsub) { conversationsUnsub(); conversationsUnsub = null; }
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
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
  });
  document.getElementById("settings-back-btn").addEventListener("click", showThreadList);

  document.getElementById("change-pin-btn").addEventListener("click", async () => {
    const newPin = document.getElementById("new-pin-input").value.trim();
    const msgEl = document.getElementById("settings-msg");
    if (newPin.length < 4) {
      msgEl.textContent = "Yeni PIN en az 4 karakter olmalı.";
      return;
    }
    const newKey = await deriveLocalKey(newPin);
    await saveLocalBlob(newKey, {});
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
            name: myEmail || "kullanici",
            displayName: myEmail || "Kullanıcı",
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
    if (conversationsUnsub) { conversationsUnsub(); conversationsUnsub = null; }
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    await fbAuth.signOut();
    myUid = null; myEmail = null; myPrivateKey = null; myPublicKey = null;
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

  async function openConversation(convId, otherUid, otherEmail) {
    activeConvId = convId;
    activeOtherUid = otherUid;
    threadListPanel.classList.add("hidden");
    threadDetailPanel.classList.remove("hidden");
    settingsPanel.classList.add("hidden");
    document.getElementById("thread-title").textContent = otherEmail;
    await getPublicKeyForUid(otherUid);
    listenToMessages(convId);
  }

  function listenToMessages(convId) {
    if (messagesUnsub) messagesUnsub();
    messageListEl.innerHTML = "";
    messagesUnsub = fbDb.collection("conversations").doc(convId).collection("messages")
      .orderBy("ts")
      .onSnapshot(async snap => {
        const rendered = [];
        for (const doc of snap.docs) {
          const d = doc.data();
          const plain = await decryptMessage(d).catch(() => "[çözülemedi]");
          rendered.push({
            from: d.from === myUid ? "me" : "them",
            text: d.type === "image" ? null : plain,
            image: d.type === "image" ? plain : null,
            ts: d.ts ? d.ts.toMillis() : Date.now(),
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
      const timeSpan = document.createElement("span");
      timeSpan.className = "msg-time";
      timeSpan.textContent = time;
      div.appendChild(timeSpan);
      messageListEl.appendChild(div);
    });
    messageListEl.scrollTop = messageListEl.scrollHeight;
  }

  async function wrapAesKeyForPublicKey(rawAesKey, publicKey) {
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey);
    return b64encode(wrapped);
  }

  async function sendEncrypted(payloadText, type) {
    if (!activeConvId || !activeOtherUid) return;
    const otherPublicKey = await getPublicKeyForUid(activeOtherUid);
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

    await fbDb.collection("conversations").doc(activeConvId).collection("messages").add({
      from: myUid,
      type,
      iv: b64encode(iv.buffer),
      ciphertext: b64encode(ciphertext),
      wrappedKeys: { [myUid]: myWrapped, [activeOtherUid]: theirWrapped },
      ts: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await fbDb.collection("conversations").doc(activeConvId).set({
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
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

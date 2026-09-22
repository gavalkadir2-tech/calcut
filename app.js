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

  /* ---------------- Crypto helpers ---------------- */

  const STORAGE_SALT = "calcut_vault_salt";
  const STORAGE_BLOB = "calcut_vault_blob";

  function b64encode(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function b64decode(str) {
    const bin = atob(str);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }

  function getOrCreateSalt() {
    let salt = localStorage.getItem(STORAGE_SALT);
    if (!salt) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      salt = b64encode(bytes.buffer);
      localStorage.setItem(STORAGE_SALT, salt);
    }
    return b64decode(salt);
  }

  async function deriveKey(pin) {
    const salt = getOrCreateSalt();
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function vaultExists() {
    return !!localStorage.getItem(STORAGE_BLOB);
  }

  async function saveVault(key, dataObj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(dataObj));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    localStorage.setItem(STORAGE_BLOB, JSON.stringify({
      iv: b64encode(iv.buffer),
      data: b64encode(ciphertext),
    }));
  }

  async function loadVault(key) {
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

  /* ---------------- Vault state ---------------- */

  let vaultKey = null;
  let vaultData = null; // { threads: [{id, name, messages: [{from:'me'|'them', text, ts}]}] }
  let activeThreadId = null;

  const lockPanel = document.getElementById("vault-lock");
  const appPanel = document.getElementById("vault-app");
  const pinInput = document.getElementById("vault-pin-input");
  const unlockBtn = document.getElementById("vault-unlock-btn");
  const backBtn = document.getElementById("vault-back-btn");
  const errorEl = document.getElementById("vault-error");

  const threadListPanel = document.getElementById("thread-list-panel");
  const threadDetailPanel = document.getElementById("thread-detail-panel");
  const settingsPanel = document.getElementById("settings-panel");
  const threadListEl = document.getElementById("thread-list");

  function openVaultLockScreen() {
    calcView.classList.add("hidden");
    vaultView.classList.remove("hidden");
    lockPanel.classList.remove("hidden");
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
    appPanel.classList.add("hidden");
    clearAll();
    renderCalc();
  }

  async function unlockWithPin(pin) {
    const key = await deriveKey(pin);
    if (!vaultExists()) {
      vaultKey = key;
      vaultData = { threads: [] };
      await saveVault(vaultKey, vaultData);
      return true;
    }
    try {
      const data = await loadVault(key);
      vaultKey = key;
      vaultData = data;
      return true;
    } catch (e) {
      return false;
    }
  }

  async function tryAutoUnlock(pin) {
    if (!vaultExists()) return false; // require explicit setup via triple-tap gesture first
    const key = await deriveKey(pin);
    try {
      const data = await loadVault(key);
      vaultKey = key;
      vaultData = data;
      enterVaultApp();
      calcView.classList.add("hidden");
      vaultView.classList.remove("hidden");
      lockPanel.classList.add("hidden");
      appPanel.classList.remove("hidden");
      return true;
    } catch (e) {
      return false;
    }
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
      enterVaultApp();
      lockPanel.classList.add("hidden");
      appPanel.classList.remove("hidden");
    } else {
      errorEl.textContent = "Yanlış PIN.";
    }
  });
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockBtn.click();
  });
  backBtn.addEventListener("click", closeVaultToCalculator);

  function enterVaultApp() {
    showThreadList();
  }

  function showThreadList() {
    threadListPanel.classList.remove("hidden");
    threadDetailPanel.classList.add("hidden");
    settingsPanel.classList.add("hidden");
    renderThreadList();
  }

  function renderThreadList() {
    threadListEl.innerHTML = "";
    if (!vaultData.threads.length) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = "Henüz sohbet yok. '+' ile yeni sohbet başlat.";
      li.style.cursor = "default";
      threadListEl.appendChild(li);
      return;
    }
    vaultData.threads.forEach(thread => {
      const li = document.createElement("li");
      const last = thread.messages[thread.messages.length - 1];
      li.innerHTML = `<span class="thread-name"></span><span class="thread-preview"></span>`;
      li.querySelector(".thread-name").textContent = thread.name;
      li.querySelector(".thread-preview").textContent = last ? last.text : "Henüz mesaj yok";
      li.addEventListener("click", () => openThread(thread.id));
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
    const name = document.getElementById("new-thread-name").value.trim();
    if (!name) return;
    const thread = { id: crypto.randomUUID(), name, messages: [] };
    vaultData.threads.unshift(thread);
    await saveVault(vaultKey, vaultData);
    document.getElementById("new-thread-modal").classList.add("hidden");
    renderThreadList();
    openThread(thread.id);
  });

  document.getElementById("lock-btn").addEventListener("click", () => {
    vaultKey = null;
    vaultData = null;
    closeVaultToCalculator();
  });

  document.getElementById("settings-btn").addEventListener("click", () => {
    threadListPanel.classList.add("hidden");
    threadDetailPanel.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
    document.getElementById("new-pin-input").value = "";
    document.getElementById("settings-msg").textContent = "";
  });
  document.getElementById("settings-back-btn").addEventListener("click", showThreadList);

  document.getElementById("change-pin-btn").addEventListener("click", async () => {
    const newPin = document.getElementById("new-pin-input").value.trim();
    const msgEl = document.getElementById("settings-msg");
    if (newPin.length < 4) {
      msgEl.textContent = "Yeni PIN en az 4 karakter olmalı.";
      return;
    }
    const newKey = await deriveKey(newPin);
    vaultKey = newKey;
    await saveVault(vaultKey, vaultData);
    msgEl.textContent = "PIN güncellendi.";
    document.getElementById("new-pin-input").value = "";
  });

  document.getElementById("wipe-vault-btn").addEventListener("click", () => {
    if (!confirm("Tüm gizli mesajlar kalıcı olarak silinecek. Emin misiniz?")) return;
    localStorage.removeItem(STORAGE_BLOB);
    localStorage.removeItem(STORAGE_SALT);
    vaultKey = null;
    vaultData = null;
    closeVaultToCalculator();
  });

  /* ---------------- Thread detail ---------------- */

  const messageListEl = document.getElementById("message-list");
  const messageInput = document.getElementById("message-input");

  function openThread(id) {
    activeThreadId = id;
    threadListPanel.classList.add("hidden");
    threadDetailPanel.classList.remove("hidden");
    settingsPanel.classList.add("hidden");
    const thread = vaultData.threads.find(t => t.id === id);
    document.getElementById("thread-title").textContent = thread.name;
    renderMessages(thread);
  }

  function renderMessages(thread) {
    messageListEl.innerHTML = "";
    thread.messages.forEach(m => {
      const div = document.createElement("div");
      div.className = "msg-bubble " + (m.from === "me" ? "me" : "them");
      const time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      div.innerHTML = `<span></span><span class="msg-time"></span>`;
      div.querySelector("span").textContent = m.text;
      div.querySelector(".msg-time").textContent = time;
      messageListEl.appendChild(div);
    });
    messageListEl.scrollTop = messageListEl.scrollHeight;
  }

  document.getElementById("message-send-btn").addEventListener("click", sendMessage);
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });

  async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !activeThreadId) return;
    const thread = vaultData.threads.find(t => t.id === activeThreadId);
    thread.messages.push({ from: "me", text, ts: Date.now() });
    messageInput.value = "";
    renderMessages(thread);
    await saveVault(vaultKey, vaultData);
    renderThreadList();
  }

  document.getElementById("thread-back-btn").addEventListener("click", () => {
    activeThreadId = null;
    showThreadList();
  });

  document.getElementById("thread-delete-btn").addEventListener("click", async () => {
    if (!activeThreadId) return;
    if (!confirm("Bu sohbeti silmek istediğinize emin misiniz?")) return;
    vaultData.threads = vaultData.threads.filter(t => t.id !== activeThreadId);
    activeThreadId = null;
    await saveVault(vaultKey, vaultData);
    showThreadList();
  });

})();

// sprinter.js - Sprinter Application (FINAL: Kamera fisik saat klik UPLOAD, tanpa mengunci tombol)
class SprinterApp {
  constructor() {
    this.selectedFiles = [];      // POD photos (2+)
    this.physicalFile = null;     // Foto fisik paket (1) - diambil saat klik UPLOAD
    this.currentUser = null;
    this.sessionToken = null;     // localStorage 'jt_device_id'
    this.awbList = [];
    this.sessionChecker = null;

    // injected UI refs (optional)
    this._physicalInput = null;
    this._physicalNameEl = null;
    this._physicalPreviewEl = null;

    // flag auto upload setelah kamera selesai
    this._pendingAutoUpload = false;
  }

  async init() {
    this.bindEvents();
    this.ensurePhysicalUI(); // inject input kamera hidden + fallback UI

    // ✅ NEW: tabel pending + phone (inject UI aman, tidak ganggu yang ada)
    this.ensurePhoneTabUI();

    await this.checkExistingSession();
    this.setupSessionCheck();
  }

  // ================= EVENT BINDING =================
  bindEvents() {
    // Login
    document.getElementById("loginBtn")?.addEventListener("click", () => this.login());
    document.getElementById("sprinterId")?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.login();
    });

    // Logout
    document.getElementById("logoutBtn")?.addEventListener("click", () => this.logout());

    // AWB dropdown select (optional)
    document.getElementById("awbSelect")?.addEventListener("change", (e) => {
      const awb = e.target.value;
      const awbInput = document.getElementById("awbInput");
      const awbStatus = document.getElementById("awbStatus");

      if (awb) {
        awbInput.value = awb;
        awbStatus.innerHTML = `<span style="color:#2ecc71">AWB dipilih dari list admin</span>`;
      } else {
        awbInput.value = "";
        awbStatus.innerHTML = "";
      }

      // jangan paksa enable/disable di sini, biar konsisten
      this.updateUploadButtonState();
    });

    // AWB input uppercase + reset dropdown jika manual
    document.getElementById("awbInput")?.addEventListener("input", (e) => {
      e.target.value = e.target.value.toUpperCase();

      const awbSelect = document.getElementById("awbSelect");
      if (awbSelect && awbSelect.value) awbSelect.value = "";
    });

    // Check AWB
    document.getElementById("checkAWBBtn")?.addEventListener("click", () => this.checkAWB());

    // Reset
    document.getElementById("resetBtn")?.addEventListener("click", () => this.resetForm());

    // File input (POD photos)
    document.getElementById("fileInput")?.addEventListener("change", (e) => {
      this.handleFileSelect(Array.from(e.target.files || []));
    });

    // Upload
    document.getElementById("uploadBtn")?.addEventListener("click", () => this.uploadFile());

    // Drag/drop area
    const uploadArea = document.getElementById("uploadArea");
    if (uploadArea) {
      uploadArea.addEventListener("click", () => {
        if (!this.currentUser) {
          Utils.showNotification("Harap login terlebih dahulu", "warning");
          return;
        }
        document.getElementById("fileInput")?.click();
      });

      uploadArea.addEventListener("dragover", (e) => {
        e.preventDefault();
        uploadArea.classList.add("dragover");
      });

      uploadArea.addEventListener("dragleave", () => {
        uploadArea.classList.remove("dragover");
      });

      uploadArea.addEventListener("drop", (e) => {
        e.preventDefault();
        uploadArea.classList.remove("dragover");
        this.handleFileSelect(Array.from(e.dataTransfer?.files || []));
      });
    }
  }

  // ================= FOTO FISIK: input kamera hidden + fallback UI =================
  ensurePhysicalUI() {
  // Flag untuk auto-upload setelah kamera selesai
  this._pendingAutoUpload = false;

  // Kalau HTML sudah punya input sendiri, pakai itu
  let input =
    document.getElementById("physicalInput") ||
    document.getElementById("physicalFileInput") ||
    null;

  // Kalau belum ada, buat input kamera yang HIDDEN (tanpa tombol / UI)
  if (!input) {
    input = document.createElement("input");
    input.id = "physicalInput";
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment"); // kamera belakang (best effort)
    input.style.display = "none";
    document.body.appendChild(input);
  } else {
    // Pastikan setting kamera benar
    input.accept = "image/*";
    input.setAttribute("capture", "environment");
  }

  this._physicalInput = input;

  // Listener: setelah foto fisik dipilih, auto upload jika dipicu dari tombol Upload
  input.addEventListener("change", (e) => {
    const f = e.target.files?.[0] || null;
    this.handlePhysicalSelect(f);

    if (this._pendingAutoUpload && this.physicalFile) {
      this._pendingAutoUpload = false;
      setTimeout(() => this.uploadFile(), 50);
    }
  });
}

  
  handlePhysicalSelect(file) {
    if (!file) {
      this.physicalFile = null;
      if (this._physicalNameEl) this._physicalNameEl.textContent = "Belum dipilih";
      this.updateUploadButtonState();
      return;
    }

    const v = Utils.validateFile(file);
    if (!v.valid) {
      Utils.showNotification(`Foto fisik: ${v.message}`, "error");
      this.physicalFile = null;
      if (this._physicalNameEl) this._physicalNameEl.textContent = "Belum dipilih";
      this.updateUploadButtonState();
      return;
    }

    this.physicalFile = file;
    if (this._physicalNameEl) this._physicalNameEl.textContent = file.name;

    // Tombol Upload tidak dikunci oleh physical, tapi tetap update state
    this.updateUploadButtonState();
  }

  updateUploadButtonState() {
    const uploadBtn = document.getElementById("uploadBtn");
    if (!uploadBtn) return;

    // harus login
    if (!this.currentUser) {
      uploadBtn.disabled = true;
      return;
    }

    // ✅ Rule final:
    // Tombol Upload aktif jika foto POD minimal 2.
    // Foto fisik akan diambil saat klik Upload (kamera otomatis).
    const okPod = this.selectedFiles.length >= 2;
    uploadBtn.disabled = !okPod;
  }

  // ================= SESSION =================
  async checkExistingSession() {
    const savedUser = Utils.loadFromLocalStorage("jt_sprinter_user");
    const savedToken = Utils.loadFromLocalStorage("jt_device_id");

    if (!savedUser || !savedToken) {
      this.showLogin();
      return;
    }

    try {
      const response = await Utils.fetchWithAuth(`${CONFIG.SERVER_URL}/api/session/check`, { method: "GET" });
      const result = await response.json();

      if (result.success && result.valid) {
        this.currentUser = savedUser;
        this.sessionToken = savedToken;

        this.showDashboard();
        await this.loadAWBs();
        await this.updateDashboardStats();
        Utils.showNotification(`Selamat datang kembali, ${this.currentUser.name}`, "success");

        this.updateUploadButtonState();
      } else {
        this.forceLogout("Session invalid");
      }
    } catch (err) {
      console.error("checkExistingSession error:", err);
      this.forceLogout("Session invalid");
    }
  }
  
  async savePhoneToServer(awb, phone) {
  const a = String(awb || "").trim().toUpperCase();
  const p = String(phone || "").trim();

  if (!a) throw new Error("AWB kosong");
  const v = this.validatePhone(p);
  if (!v.valid) throw new Error(v.message);

  const res = await Utils.fetchWithAuth(`${CONFIG.SERVER_URL}/api/awb/phone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ awb: a, phone: p }),
  });

  const result = await res.json().catch(() => ({}));
  if (!result.success) {
    throw new Error(result.error || "Gagal simpan nomor HP");
  }
  return result;
}


  setupSessionCheck() {
    if (this.sessionChecker) clearInterval(this.sessionChecker);

    this.sessionChecker = setInterval(async () => {
      if (!this.currentUser) return;

      try {
        const response = await Utils.fetchWithAuth(`${CONFIG.SERVER_URL}/api/session/check`, { method: "GET" });
        const result = await response.json();

        if (!result.success || !result.valid) {
          Utils.showNotification("Akun ini login di perangkat lain", "warning");
          this.forceLogout("Kicked");
        }
      } catch (err) {
        console.warn("Session check error:", err?.message || err);
      }
    }, CONFIG.SESSION_CHECK_INTERVAL);
  }

  forceLogout(reason = "") {
    Utils.saveToLocalStorage("jt_sprinter_user", null);
    Utils.saveToLocalStorage("jt_device_id", null);

    if (this.sessionChecker) clearInterval(this.sessionChecker);

    this.currentUser = null;
    this.sessionToken = null;
    this.selectedFiles = [];
    this.physicalFile = null;
    this.awbList = [];

    this.resetForm();
    this.showLogin();
  }

  // ================= AUTH =================
  async login() {
    const input = document.getElementById("sprinterId");
    const raw = (input?.value || "").trim();
    const sprinterId = raw.toUpperCase();

    if (!sprinterId) {
      Utils.showNotification("Masukkan ID Sprinter", "error");
      return;
    }

    // ✅ LONGGAR: tidak wajib format LS##########
    // Validasi ringan agar aman
    if (sprinterId.length < 3 || sprinterId.length > 40) {
      Utils.showNotification("ID Sprinter minimal 3 karakter (maks 40)", "error");
      return;
    }
    if (!/^[A-Z0-9_-]+$/.test(sprinterId)) {
      Utils.showNotification("ID Sprinter hanya boleh huruf/angka, '_' atau '-'", "error");
      return;
    }

    const btn = document.getElementById("loginBtn");
    const originalText = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = "LOGIN...";
    }

    try {
      const response = await fetch(`${CONFIG.SERVER_URL}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sprinter_id: sprinterId }),
      });

      const result = await response.json();

      if (!result.success) {
        Utils.showNotification(result.error || "Login gagal", "error");
        return;
      }

      this.currentUser = result.user;
      this.sessionToken = result.user.device_id;

      Utils.saveToLocalStorage("jt_sprinter_user", result.user);
      Utils.saveToLocalStorage("jt_device_id", this.sessionToken);

      if (input) input.value = "";

      this.showDashboard();
      await this.loadAWBs();
      await this.updateDashboardStats();

      this.updateUploadButtonState();

      Utils.showNotification(`Selamat datang, ${result.user.name}`, "success");
    } catch (err) {
      console.error("Login error:", err);
      Utils.showNotification("Gagal terhubung ke server", "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }
  }

  async logout() {
    try {
      await Utils.fetchWithAuth(`${CONFIG.SERVER_URL}/api/logout`, { method: "POST" });
    } catch (err) {}
    this.forceLogout("Logout");
    Utils.showNotification("Berhasil logout", "info");
  }

  // ================= UI =================
  showLogin() {
    document.getElementById("loginPage").style.display = "block";
    document.getElementById("dashboardPage").style.display = "none";
    document.getElementById("sprinterId")?.focus();
  }

  showDashboard() {
    document.getElementById("loginPage").style.display = "none";
    document.getElementById("dashboardPage").style.display = "block";

    document.getElementById("sprinterName").textContent = this.currentUser?.name || "";
    document.getElementById("userAvatar").textContent =
      this.currentUser?.name?.charAt(0)?.toUpperCase() || "S";
  }

  // ================= DATA =================
  async loadAWBs() {
    try {
      const response = await Utils.fetchWithAuth(`${CONFIG.SERVER_URL}/api/awb/list`, { method: "GET" });
      const result = await response.json();

      if (result.success) {
        this.awbList = result.awb_list || [];
        this.updateAWBSelect();
        document.getElementById("pendingAwbCount").textContent = result.pending_count || 0;
      } else {
        this.awbList = [];
        this.updateAWBSelect();
      }

      // ✅ NEW: refresh tabel pending + phone
      this.renderPendingPhoneTable();
    } catch (err) {
      console.error("Load AWB error:", err);
    }
  }

  updateAWBSelect() {
    const select = document.getElementById("awbSelect");
    if (!select) return;

    select.innerHTML = `<option value="">Pilih AWB dari list (optional)</option>`;
    const pending = (this.awbList || []).filter((a) => a.status === "pending");

    pending.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.awb;
      opt.textContent = `${a.awb} (Pending)`;
      select.appendChild(opt);
    });
  }

  // ================= PHONE MAP (localStorage) =================
  getPhoneMap() {
    try {
      const raw = localStorage.getItem("jt_awb_phone_map");
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  }

  setPhoneMap(map) {
    try {
      localStorage.setItem("jt_awb_phone_map", JSON.stringify(map || {}));
    } catch {}
  }

  getPhoneForAwb(awb) {
    const key = String(awb || "").toUpperCase();
    const map = this.getPhoneMap();
    return String(map[key] || "");
  }

  setPhoneForAwb(awb, phone) {
    const key = String(awb || "").toUpperCase();
    const map = this.getPhoneMap();
    map[key] = String(phone || "");
    this.setPhoneMap(map);
  }

  // ================= UI: ensure Phone Tab/Section =================
  ensurePhoneTabUI() {
  const dashboard = document.getElementById("dashboardPage");
  if (!dashboard) return;

  // Kalau HTML sudah menyediakan UI tab Phone (sprinter.html), JANGAN return.
  // Kita tetap harus bind event listener untuk search agar tabel re-render.
  const existingTbody = document.getElementById("pendingPhoneTableBody");
  const existingSearch = document.getElementById("pendingPhoneSearch");

  // Jika elemen sudah ada dari HTML, cukup bind listener (sekali) + render awal.
  if (existingTbody && existingSearch) {
    // Hindari double-binding kalau init() terpanggil lagi
    if (!existingSearch.dataset.bound) {
      existingSearch.addEventListener("input", () => {
        this.renderPendingPhoneTable();
      });
      existingSearch.dataset.bound = "1";
    }

    // render awal (aman walau awbList masih kosong; nanti loadAWBs() akan render ulang)
    this.renderPendingPhoneTable();
    return;
  }

  // Kalau HTML belum ada, baru inject UI (fallback)
  const wrap = document.createElement("div");
  wrap.id = "phoneTabSection";
  wrap.style.marginTop = "16px";
  wrap.innerHTML = `
    <div class="card" style="padding:14px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
        <div>
          <div style="font-weight:700;">List AWB Belum POD + Nomor HP</div>
          <div style="font-size:12px; color:#666;">Isi nomor HP penerima per AWB. Akan tersimpan ke server.</div>
        </div>
        <input id="pendingPhoneSearch" placeholder="Cari AWB..." style="max-width:220px; width:100%; padding:8px 10px; border:1px solid #ddd; border-radius:10px;">
      </div>

      <div style="overflow:auto;">
        <table class="table" style="width:100%; border-collapse:collapse;">
          <thead>
            <tr>
              <th style="text-align:left; padding:8px;">No</th>
              <th style="text-align:left; padding:8px;">AWB</th>
              <th style="text-align:left; padding:8px;">Nomor HP</th>
              <th style="text-align:left; padding:8px;">Action</th>
            </tr>
          </thead>
          <tbody id="pendingPhoneTableBody">
            <tr><td colspan="4" style="padding:14px; color:#999; text-align:center;">Memuat...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  dashboard.appendChild(wrap);

  const searchEl = document.getElementById("pendingPhoneSearch");
  if (searchEl && !searchEl.dataset.bound) {
    searchEl.addEventListener("input", () => {
      this.renderPendingPhoneTable();
    });
    searchEl.dataset.bound = "1";
  }

  // render awal
  this.renderPendingPhoneTable();
}

  // ================= PHONE VALIDATION =================
  validatePhone(phone) {
    const p = String(phone || "").trim();
    if (!p) return { valid: false, message: "Nomor HP tidak boleh kosong" };

    // longgar: boleh +, spasi, -, () akan kita bersihkan untuk cek digit
    const digits = p.replace(/[^\d]/g, "");
    if (digits.length < 8 || digits.length > 16) {
      return { valid: false, message: "Nomor HP harus 8-16 digit" };
    }
    return { valid: true, message: "OK" };
  }

  // ================= RENDER TABLE: pending AWB + phone =================
 renderPendingPhoneTable() {
  const tbody = document.getElementById("pendingPhoneTableBody");
  if (!tbody) return;

  const qRaw = String(document.getElementById("pendingPhoneSearch")?.value || "")
    .trim()
    .toUpperCase();

  const qDigits = qRaw.replace(/[^\d]/g, "");

  const pending = (this.awbList || []).filter(
    (a) => String(a.status || "").toLowerCase() === "pending"
  );

  // Ambil phone dari DB jika ada (receiver_phone), fallback ke localStorage map
  let rows = pending.map((a) => {
    const awb = String(a.awb || "").toUpperCase();

    const phoneFromApi =
      a.receiver_phone ||
      a.receiverPhone ||
      a.phone ||
      a.no_hp ||
      a.nomor_hp ||
      "";

    const phone = String(phoneFromApi || this.getPhoneForAwb(awb) || "");
    return { awb, phone };
  });

  // SEARCH: AWB atau Nomor HP (raw / digit)
  if (qRaw) {
    rows = rows.filter((r) => {
      const awbHit = String(r.awb || "").toUpperCase().includes(qRaw);

      const phoneRaw = String(r.phone || "");
      const phoneUpper = phoneRaw.toUpperCase();
      const phoneDigits = phoneRaw.replace(/[^\d]/g, "");

      const phoneHitRaw = phoneUpper.includes(qRaw);
      const phoneHitDigits = qDigits ? phoneDigits.includes(qDigits) : false;

      return awbHit || phoneHitRaw || phoneHitDigits;
    });
  }

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:14px; color:#999; text-align:center;">Tidak ada data</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .slice(0, 500)
    .map((r, idx) => {
      const awb = this.escapeHtml(r.awb || "-");
      const phone = this.escapeHtml(r.phone || "");
      return `
        <tr>
          <td style="padding:8px;" class="mono">${idx + 1}</td>
          <td style="padding:8px;" class="mono"><b>${awb}</b></td>
          <td style="padding:8px;">
            <input
              data-phone-awb="${awb}"
              value="${phone}"
              placeholder="08xxxx / +62..."
              style="width:100%; max-width:220px; padding:7px 10px; border:1px solid #ddd; border-radius:10px;"
            />
          </td>
          <td style="padding:8px;">
            <button type="button" class="btn-mini" data-save-phone="1" data-awb="${awb}">Simpan</button>
          </td>
        </tr>
      `;
    })
    .join("");

  // bind click tombol simpan
  const btns = Array.from(tbody.querySelectorAll('button[data-save-phone="1"]'));
  btns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const awb = String(btn.getAttribute("data-awb") || "").toUpperCase();
      const inputEl = tbody.querySelector(`input[data-phone-awb="${awb}"]`);
      const phone = String(inputEl?.value || "").trim();

      const v = this.validatePhone(phone);
      if (!v.valid) {
        Utils.showNotification(v.message, "error");
        return;
      }

      const oldText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = "Menyimpan...";

      try {
        await this.savePhoneToServer(awb, phone);
        this.setPhoneForAwb(awb, phone); // cache lokal biar langsung bisa dicari
        Utils.showNotification(`Nomor HP tersimpan untuk ${awb}`, "success");
      } catch (err) {
        Utils.showNotification(err?.message || "Gagal simpan nomor HP", "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldText;
      }
    });
  });
}

  // helper kecil (biar aman di HTML)
  escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ================= AWB =================
  async checkAWB() {
    const input = document.getElementById("awbInput");
    const awb = input?.value?.trim()?.toUpperCase();

    if (!awb) {
      Utils.showNotification("Masukkan nomor AWB", "warning");
      return;
    }

    const validation = Utils.validateAWB(awb);
    if (!validation.valid) {
      Utils.showNotification(validation.message, "error");
      return;
    }

    // fallback: cek dari awbList
    const statusEl = document.getElementById("awbStatus");
    const found = (this.awbList || []).find((a) => String(a.awb || "").toUpperCase() === awb);

    if (found) {
      statusEl.innerHTML = `<strong>${awb}</strong> ditemukan (Status: <b>${found.status}</b>)`;
      this.updateUploadButtonState();
      return;
    }

    statusEl.innerHTML = `<span style="color:#f39c12">AWB manual (tidak ada di list admin)</span>`;
    this.updateUploadButtonState();
  }

  // ================= FILE HANDLING =================
  handleFileSelect(files) {
    if (!this.currentUser) {
      Utils.showNotification("Harap login terlebih dahulu", "warning");
      return;
    }

    if (!Array.isArray(files) || files.length === 0) return;

    const remaining = CONFIG.MAX_FILES_PER_UPLOAD - this.selectedFiles.length;
    if (remaining <= 0) {
      Utils.showNotification(`Maksimal ${CONFIG.MAX_FILES_PER_UPLOAD} foto`, "warning");
      return;
    }

    const allowed = files.slice(0, remaining);

    allowed.forEach((file) => {
      const v = Utils.validateFile(file);
      if (v.valid) this.selectedFiles.push(file);
      else Utils.showNotification(v.message, "error");
    });

    this.updateFileList();
    this.showPreview();

    const selectedBlock = document.getElementById("selectedFiles");
    if (selectedBlock) selectedBlock.style.display = this.selectedFiles.length ? "block" : "none";

    this.updateUploadButtonState();
  }

  updateFileList() {
    const list = document.getElementById("fileList");
    const count = document.getElementById("fileCount");
    if (!list || !count) return;

    count.textContent = `${this.selectedFiles.length} file dipilih`;

    list.innerHTML = this.selectedFiles
      .map(
        (f, i) => `
        <div class="file-item">
          <span>${f.name}</span>
          <button type="button" onclick="window.sprinterApp.removeFile(${i})">✕</button>
        </div>
      `
      )
      .join("");
  }

  removeFile(i) {
    this.selectedFiles.splice(i, 1);
    this.updateFileList();
    this.showPreview();

    const selectedBlock = document.getElementById("selectedFiles");
    if (selectedBlock) selectedBlock.style.display = this.selectedFiles.length ? "block" : "none";

    this.updateUploadButtonState();
  }

  showPreview() {
    const area = document.getElementById("previewArea");
    const container = document.getElementById("previewContainer");
    const uploadBtn = document.getElementById("uploadBtn");

    if (!area || !container) return;

    if (!this.currentUser) {
      area.style.display = "none";
      container.innerHTML = "";
      if (uploadBtn) uploadBtn.disabled = true;
      return;
    }

    if (!this.selectedFiles.length) {
      area.style.display = "none";
      container.innerHTML = "";
      this.updateUploadButtonState();
      return;
    }

    area.style.display = "block";
    container.innerHTML = "";

    const infoEl = document.getElementById("previewInfo");
    if (infoEl) {
      infoEl.textContent =
        this.selectedFiles.length < 2
          ? `Pilih minimal 2 foto untuk upload POD.`
          : `Siap upload: ${this.selectedFiles.length} foto.`;
    }

    this.selectedFiles.forEach((f, idx) => {
      const r = new FileReader();
      r.onload = (e) => {
        const div = document.createElement("div");
        div.className = "thumb-container";
        div.innerHTML = `<img src="${e.target.result}"><div>${idx + 1}</div>`;
        container.appendChild(div);
      };
      r.readAsDataURL(f);
    });

    this.updateUploadButtonState();
  }

  // ================= UPLOAD: klik UPLOAD -> buka kamera fisik -> auto upload =================
  async uploadFile() {
    const awb = document.getElementById("awbInput")?.value?.trim()?.toUpperCase();

    if (!awb) {
      Utils.showNotification("AWB wajib diisi", "error");
      return;
    }

    const awbValidation = Utils.validateAWB(awb);
    if (!awbValidation.valid) {
      Utils.showNotification(awbValidation.message, "error");
      return;
    }

    if (this.selectedFiles.length < 2) {
      Utils.showNotification("Minimal 2 foto wajib dipilih untuk POD.", "error");
      return;
    }

    // ✅ Jika foto fisik belum ada: klik Upload akan membuka kamera
    if (!this.physicalFile) {
      Utils.showNotification("Ambil foto fisik paket dulu...", "info");

      const physicalInput =
        document.getElementById("physicalInput") ||
        document.getElementById("physicalFileInput") ||
        this._physicalInput;

      if (!physicalInput) {
        Utils.showNotification("Input foto fisik tidak ditemukan", "error");
        return;
      }

      this._pendingAutoUpload = true;
      physicalInput.accept = "image/*";
      physicalInput.setAttribute("capture", "environment");

      physicalInput.click();
      return;
    }

    const btn = document.getElementById("uploadBtn");
    const originalText = btn?.innerHTML;

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> UPLOADING...`;
    }

    try {
      const fd = new FormData();
      fd.append("awb", awb);

      // Field name HARUS "photos"
      this.selectedFiles.forEach((file) => fd.append("photos", file, file.name));

      // Field name HARUS "physical"
      fd.append("physical", this.physicalFile, this.physicalFile.name);

      const user = Utils.loadFromLocalStorage("jt_sprinter_user");
      const token = Utils.loadFromLocalStorage("jt_device_id");

      if (!user?.id || !token) {
        Utils.showNotification("Session tidak valid. Silakan login ulang.", "warning");
        this.forceLogout("Session invalid");
        return;
      }

      const res = await fetch(`${CONFIG.SERVER_URL}/api/upload`, {
        method: "POST",
        headers: {
          "X-User-ID": String(user.id),
          "X-Session-ID": String(token),
        },
        body: fd,
      });

      const result = await res.json().catch(() => ({}));

      if (result.success) {
        Utils.showNotification("Upload berhasil", "success");
        this.resetForm();
        await this.loadAWBs();
        await this.updateDashboardStats();
      } else {
        Utils.showNotification(result.error || "Upload gagal", "error");
      }
    } catch (err) {
      console.error("Upload error:", err);
      Utils.showNotification("Gagal upload", "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
      this.updateUploadButtonState();
    }
  }

  async updateDashboardStats() {
    try {
      const res = await Utils.fetchWithAuth(`${CONFIG.SERVER_URL}/api/uploads`, { method: "GET" });
      const result = await res.json();

      if (result.success) {
        const uploads = result.uploads || [];
        document.getElementById("totalUploads").textContent = result.total || uploads.length;

        const today = new Date().toISOString().slice(0, 10);
        const todayCount = uploads.filter((u) => String(u.timestamp || "").startsWith(today)).length;
        const todayEl = document.getElementById("todayUploads");
        if (todayEl) todayEl.textContent = todayCount;
      }
    } catch (err) {}
  }

  resetForm() {
    this.selectedFiles = [];
    this.physicalFile = null;
    this._pendingAutoUpload = false;

    const awbInput = document.getElementById("awbInput");
    const awbStatus = document.getElementById("awbStatus");
    const fileInput = document.getElementById("fileInput");
    const previewArea = document.getElementById("previewArea");
    const previewContainer = document.getElementById("previewContainer");
    const selectedFilesBlock = document.getElementById("selectedFiles");
    const uploadBtn = document.getElementById("uploadBtn");

    if (awbInput) awbInput.value = "";
    if (awbStatus) awbStatus.innerHTML = "";
    if (fileInput) fileInput.value = "";

    const awbSelect = document.getElementById("awbSelect");
    if (awbSelect) awbSelect.value = "";

    if (previewContainer) previewContainer.innerHTML = "";
    if (previewArea) previewArea.style.display = "none";
    if (selectedFilesBlock) selectedFilesBlock.style.display = "none";

    const fileList = document.getElementById("fileList");
    const fileCount = document.getElementById("fileCount");
    if (fileList) fileList.innerHTML = "";
    if (fileCount) fileCount.textContent = "0 file dipilih";

    // reset physical UI
    const physicalInput =
      document.getElementById("physicalInput") ||
      document.getElementById("physicalFileInput") ||
      this._physicalInput;

    if (physicalInput) physicalInput.value = "";
    if (this._physicalNameEl) this._physicalNameEl.textContent = "Belum dipilih";
    const previewWrap = document.getElementById("physicalPreviewWrap");
    if (previewWrap) previewWrap.style.display = "none";
    if (this._physicalPreviewEl) this._physicalPreviewEl.removeAttribute("src");

    // button state
    if (uploadBtn) uploadBtn.disabled = true;
    this.updateUploadButtonState();
  }
}

// Boot
document.addEventListener("DOMContentLoaded", () => {
  window.sprinterApp = new SprinterApp();
  window.sprinterApp.init();
});

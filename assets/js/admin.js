// assets/js/admin.js (FINAL - CLEAN, NO SYNTAX ERROR)
// Aligned with latest admin.html requirements:
// - Dashboard table: (Ranking) | Nama Sprinter | Total AWB | Ada POD | Belum Ada POD
// - Sprinter table: Actions = Edit + Hapus
// - AWB table: No | AWB | Kode Sprinter | Nama Sprinter | Status | Added By | Tanggal Sampai | No HP | Action(Hapus)
//   + search + date range filter + bulk delete via Excel upload + download template
// - POD tab: No | Timestamp | Sprinter ID | Sprinter | AWB | Foto POD | Foto Fisik | Validasi | Actions (Terima/Tolak) + download ZIP/Excel
//
// Notes:
// - Beberapa tombol butuh endpoint server. Kalau endpoint belum ada, UI akan alert tapi tidak crash.

(function () {
  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

  function show(el, yes) {
    if (!el) return;
    el.style.display = yes ? "" : "none";
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmtDateOnly(v) {
    if (!v) return "-";
    return String(v).split("T")[0];
  }

  function fmtDateTime(v) {
    if (!v) return "-";
    return String(v).replace("T", " ").replace(".000Z", "");
  }

  function badge(text, tone) {
    const t = escapeHtml(text);
    const cls = tone ? `badge ${tone}` : "badge";
    return `<span class="${cls}">${t}</span>`;
  }

  function setText(id, val) {
    const el = $(id);
    if (!el) return;
    el.innerText = val === null || val === undefined ? "0" : String(val);
  }

  // ---------- auth ----------
  function getAdminPin() {
    return localStorage.getItem("ADMIN_PIN") || "";
  }

  async function adminFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    headers["X-Admin-Pin"] = getAdminPin();
    return fetch(url, Object.assign({}, options, { headers }));
  }

  // ---------- state ----------
  let __sprinterCache = [];
  let __awbCache = [];
  let __uploadsCache = [];

  // AWB pagination
  let __awbPage = 1;
  let __awbPageSize = 10;

  // Date filter state (YYYY-MM-DD strings)
  let __awbFrom = "";
  let __awbTo = "";

  // ---------- login ----------
  async function adminLogin() {
    const pin = ($("adminPin")?.value || "").trim();
    if (!pin) return alert("Masukkan Admin PIN");

    try {
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) return alert(j.error || "Login gagal");

      localStorage.setItem("ADMIN_PIN", pin);
      show($("loginPage"), false);
      show($("dashboardPage"), true);

      await refreshAll();
    } catch (e) {
      console.error(e);
      alert("Gagal konek ke server");
    }
  }

  function adminLogout() {
    localStorage.removeItem("ADMIN_PIN");
    show($("dashboardPage"), false);
    show($("loginPage"), true);
  }

  function autoLoginIfPinExists() {
    const pin = getAdminPin();
    if (!pin) return;
    show($("loginPage"), false);
    show($("dashboardPage"), true);
    refreshAll().catch(() => {});
  }

  // ---------- tabs ----------
  function setActiveTab(tabName) {
  // aktifkan tombol nav
  qsa(".nav-item.tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  // daftar tab (DITAMBAHKAN tools)
  const tabs = {
    dashboard: $("dashboardTab"),
    sprinter: $("sprinterTab"),
    awb: $("awbTab"),
    uploads: $("uploadsTab"),
    tools: $("toolsTab"), // ✅ NEW
  };

  Object.entries(tabs).forEach(([k, el]) => {
    if (!el) return;
    el.style.display = k === tabName ? "block" : "none";
  });
}

  // ---------- report summary ----------
  async function loadReportSummary() {
    if (!getAdminPin()) return;

    const r = await adminFetch("/api/admin/report/summary");
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return;

    setText("totalSprinter", j.total_sprinter);
    setText("activeSprinter", j.active_sprinter);

    setText("totalAWB", j.total_awb);
    setText("pendingAWB", j.pending_awb);
    setText("deliveredAWB", j.delivered_awb);

    setText("totalUploads", j.total_uploads);
    setText("todayUploads", j.today_uploads);
  }

  // =========================
  // Date helpers (YYYY-MM-DD)
  // =========================
  function toDateKey(d) {
    return String(d || "").trim();
  }

  function inDateRange(dateStr, fromStr, toStr) {
    const d = toDateKey(dateStr);
    if (!d || d === "-") return false;

    const from = toDateKey(fromStr);
    const to = toDateKey(toStr);

    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }

  // ============================================================
  // DASHBOARD TABLE: aggregated from __awbCache
  // (tanpa filter tanggal sesuai revisi kamu)
  // ============================================================
  function loadRecentActivityFromCache() {
    const tbody = $("recentActivityTable");
    if (!tbody) return;

    const list = Array.isArray(__awbCache) ? __awbCache : [];
    if (!list.length) {
      tbody.innerHTML = `
        <tr><td colspan="5" style="text-align:center; padding:20px; color:#999;">
          Tidak ada data
        </td></tr>`;
      return;
    }

    // TOTAL PER SPRINTER (tanpa filter tanggal)
    const map = new Map();

    for (const a of list) {
      const sprId = String(a.sprinter_id || a.sprinter_code || "-");
      const sprName = String(a.sprinter_name || "-");
      const key = `${sprId}__${sprName}`;

      const cur = map.get(key) || {
        sprinter_name: sprName,
        total_awb: 0,
        ada_pod: 0,
        belum_pod: 0,
      };

      cur.total_awb += 1;
      if (Number(a.has_pod) === 1) cur.ada_pod += 1;
      else cur.belum_pod += 1;

      map.set(key, cur);
    }

    // Sort: BELUM POD tertinggi -> terendah
    const rows = Array.from(map.values()).sort((x, y) => {
      const bx = Number(x.belum_pod) || 0;
      const by = Number(y.belum_pod) || 0;
      if (by !== bx) return by - bx;

      const tx = Number(x.total_awb) || 0;
      const ty = Number(y.total_awb) || 0;
      if (ty !== tx) return ty - tx;

      return String(x.sprinter_name || "").localeCompare(String(y.sprinter_name || ""));
    });

    tbody.innerHTML = rows
      .slice(0, 500)
      .map((r, idx) => {
        const rank = idx + 1;
        return `
          <tr>
            <td class="mono">${rank}</td>
            <td>${escapeHtml(r.sprinter_name || "-")}</td>
            <td class="mono">${escapeHtml(r.total_awb)}</td>
            <td class="mono">${escapeHtml(r.ada_pod)}</td>
            <td class="mono">${escapeHtml(r.belum_pod)}</td>
          </tr>`;
      })
      .join("");
  }

  function bindDashboardFilters() {
    // Dashboard filter disembunyikan (ranking total per sprinter)
    const applyBtn = $("dashApplyFilterBtn");
    const resetBtn = $("dashResetFilterBtn");
    const filterRow = applyBtn?.closest(".filters-row") || resetBtn?.closest(".filters-row");
    if (filterRow) filterRow.style.display = "none";

    applyBtn?.addEventListener("click", (e) => {
      e.preventDefault?.();
      loadRecentActivityFromCache();
    });

    resetBtn?.addEventListener("click", (e) => {
      e.preventDefault?.();
      const f = $("dashFromDate");
      const t = $("dashToDate");
      if (f) f.value = "";
      if (t) t.value = "";
      loadRecentActivityFromCache();
    });
  }

  // ---------- sprinters ----------
  async function loadSprinters() {
    const r = await adminFetch("/api/admin/sprinters");
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return;

    __sprinterCache = j.users || [];
    renderSprinterTable();
  }

  function renderSprinterTable() {
    const tbody = $("sprinterTable");
    if (!tbody) return;

    const q = String($("searchSprinter")?.value || "").trim().toLowerCase();
    const filter = String($("filterSprinterStatus")?.value || "all").toLowerCase();

    let rows = __sprinterCache.slice();

    if (filter !== "all") rows = rows.filter((u) => String(u.status || "").toLowerCase() === filter);

    if (q) {
      rows = rows.filter((u) => {
        const id = String(u.id || "").toLowerCase();
        const name = String(u.name || "").toLowerCase();
        return id.includes(q) || name.includes(q);
      });
    }

    if ($("sprinterCount")) $("sprinterCount").innerText = String(rows.length);

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:#999;">Kosong</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map((u) => {
        const id = escapeHtml(u.id || "-");
        const name = escapeHtml(u.name || "-");
        const status = escapeHtml(u.status || "-");
        const last = escapeHtml(fmtDateTime(u.last_login || "-"));

        const act = `
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn-mini secondary" data-act="spr-edit" data-id="${id}">
              <i class="fas fa-pen"></i> Edit
            </button>
            <button class="btn-mini danger" data-act="spr-del" data-id="${id}">
              <i class="fas fa-trash"></i> Hapus
            </button>
          </div>`;

        return `
          <tr>
            <td class="mono">${id}</td>
            <td>${name}</td>
            <td>${status}</td>
            <td class="mono">${last}</td>
            <td>${act}</td>
          </tr>`;
      })
      .join("");

    tbody.querySelectorAll('[data-act="spr-edit"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        const u = __sprinterCache.find((x) => String(x.id) === String(id));
        if (!u) return;

        const newName = prompt("Edit nama sprinter:", String(u.name || ""));
        if (newName === null) return;
        editSprinter(id, newName.trim()).catch(() => {});
      });
    });

    tbody.querySelectorAll('[data-act="spr-del"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        if (!confirm(`Hapus sprinter ${id}?`)) return;
        deleteSprinter(id).catch(() => {});
      });
    });
  }

function bindSprinterFilters() {
  const searchInput = $("searchSprinter");
  const statusFilter = $("filterSprinterStatus");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderSprinterTable();
    });
  }

  if (statusFilter) {
    statusFilter.addEventListener("change", () => {
      renderSprinterTable();
    });
  }
}


  function bindAddSprinter() {
  const btnOpen = $("addSprinterBtn");
  const modal = $("addSprinterModal");
  const btnSave = $("saveSprinterBtn");

  const inputId = $("newSprinterId");
  const inputName = $("newSprinterName");

  if (btnOpen) {
    btnOpen.addEventListener("click", () => {
      if (!modal) return;
      if (inputId) inputId.value = "";
      if (inputName) inputName.value = "";
      modal.style.display = "block";
      setTimeout(() => inputId?.focus?.(), 50);
    });
  }

  if (btnSave) {
    btnSave.addEventListener("click", () => {
      const id = inputId?.value || "";
      const name = inputName?.value || "";
      createSprinter(id, name)
        .then(() => {
          if (modal) modal.style.display = "none";
        })
        .catch(() => {});
    });
  }
}

  
  async function editSprinter(id, newName) {
    if (!newName) return alert("Nama tidak boleh kosong");

    const r = await adminFetch("/api/admin/sprinters/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: newName }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return alert(j.error || "Gagal edit sprinter");

    await loadSprinters();
    alert("Sprinter berhasil diupdate");
  }

  async function createSprinter(id, name) {
  const code = String(id || "").trim().toUpperCase();
  const nm = String(name || "").trim();

  if (!code) return alert("ID sprinter wajib diisi");
  if (!nm) return alert("Nama sprinter wajib diisi");

  const r = await adminFetch("/api/admin/sprinters/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: code, name: nm }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) return alert(j.error || "Gagal tambah sprinter");

  // refresh list sprinter
  await loadSprinters();
  alert("Sprinter berhasil ditambahkan");
}

  
  // ---------- AWB ----------
  function getAwbStatusLabel(a) {
    const st = String(a.status || "").toLowerCase();
    const hasPod = Number(a.has_pod) === 1;

    if (st === "cancelled") return badge("CANCELLED", "muted");
    if (hasPod) return badge("ADA POD", "ok");
    return badge("BELUM POD", "warn");
  }

  function passAwbStatusFilter(filterValue, a) {
    if (filterValue === "all") return true;

    const st = String(a.status || "").toLowerCase();
    const hasPod = Number(a.has_pod) === 1;

    if (filterValue === "cancelled") return st === "cancelled";
    if (filterValue === "delivered") return st !== "cancelled" && hasPod;
    if (filterValue === "pending") return st !== "cancelled" && !hasPod;
    return true;
  }

  async function loadAwbList() {
    const r = await adminFetch("/api/admin/awbs");
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return;

    __awbCache = j.awb_list || [];
    __awbPage = 1;
    renderAwbTable();
    loadRecentActivityFromCache();
  }

  function ensureAwbPagerUI() {
    if ($("awbPager")) return;

    const tbody = $("awbListTable");
    if (!tbody) return;

    const table = tbody.closest("table");
    if (!table) return;

    const wrap = document.createElement("div");
    wrap.id = "awbPager";
    wrap.className = "table-pager";
    wrap.innerHTML = `
      <div class="pager-left">
        <span class="pager-label">Rows:</span>
        <select id="awbPageSize" class="pager-select">
          <option value="10">10</option>
          <option value="20">20</option>
        </select>
        <span id="awbPagerInfo" class="pager-info"></span>
      </div>
      <div class="pager-right">
        <button id="awbPrev" class="pager-btn">Prev</button>
        <span id="awbPageNow" class="pager-page"></span>
        <button id="awbNext" class="pager-btn">Next</button>
      </div>
    `;
    table.insertAdjacentElement("afterend", wrap);

    $("awbPageSize").value = String(__awbPageSize);

    $("awbPageSize").addEventListener("change", () => {
      __awbPageSize = Number($("awbPageSize").value) || 10;
      __awbPage = 1;
      renderAwbTable();
    });

    $("awbPrev").addEventListener("click", () => {
      if (__awbPage > 1) __awbPage--;
      renderAwbTable();
    });

    $("awbNext").addEventListener("click", () => {
      __awbPage++;
      renderAwbTable();
    });
  }

  function renderAwbTable() {
    const tbody = $("awbListTable");
    if (!tbody) return;

    ensureAwbPagerUI();

    const q = String($("searchAWB")?.value || "").trim().toLowerCase();
    const filter = "pending"; // AWB LIST hanya tampil BELUM POD

    let rows = __awbCache.slice();
    rows = rows.filter((a) => passAwbStatusFilter(filter, a));

    // Date range filter by arrival_date
    rows = rows.filter((a) => {
      if (!__awbFrom && !__awbTo) return true;
      const arrival = fmtDateOnly(a.arrival_date);
      return inDateRange(arrival, __awbFrom, __awbTo);
    });

    if (q) {
      rows = rows.filter((a) => {
        const awb = String(a.awb || "").toLowerCase();
        const sid = String(a.sprinter_id || "").toLowerCase();
        const snm = String(a.sprinter_name || "").toLowerCase();
        const hp = String(
          a.hp ||
            a.phone ||
            a.no_hp ||
            a.nomor_hp ||
            a.receiver_hp ||
            a.receiver_phone ||
            ""
        ).toLowerCase();
        return awb.includes(q) || sid.includes(q) || snm.includes(q) || hp.includes(q);
      });
    }

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / __awbPageSize));
    if (__awbPage > totalPages) __awbPage = totalPages;

    const start = (__awbPage - 1) * __awbPageSize;
    const end = start + __awbPageSize;
    const pageRows = rows.slice(start, end);

    if ($("awbPagerInfo")) {
      $("awbPagerInfo").innerText = total
        ? `Showing ${start + 1}-${Math.min(end, total)} of ${total}`
        : "0";
    }
    if ($("awbPageNow")) $("awbPageNow").innerText = `Page ${__awbPage} / ${totalPages}`;
    if ($("awbPrev")) $("awbPrev").disabled = __awbPage <= 1;
    if ($("awbNext")) $("awbNext").disabled = __awbPage >= totalPages;

    if ($("awbCount")) $("awbCount").innerText = String(total);

    if (!pageRows.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:#999;">Kosong</td></tr>`;
      return;
    }

    tbody.innerHTML = pageRows
      .map((a, idx) => {
        const no = start + idx + 1;
        const awb = escapeHtml(a.awb || "-");
        const sprId = escapeHtml(a.sprinter_id || "-");
        const sprName = escapeHtml(a.sprinter_name || "-");
        const stCell = getAwbStatusLabel(a);
        const addedBy = escapeHtml(a.added_by || "ADMIN");
        const tanggalSampai = escapeHtml(fmtDateOnly(a.arrival_date));

        const hpVal =
          a.hp || a.phone || a.no_hp || a.nomor_hp || a.receiver_hp || a.receiver_phone || "";
        const hp = hpVal ? escapeHtml(hpVal) : `<span style="color:#999;">-</span>`;

        const delBtn = `
          <button class="btn-mini danger" data-act="awb-del" data-awb="${awb}">
            <i class="fas fa-trash"></i> Hapus
          </button>`;

        return `
          <tr>
            <td class="mono">${no}</td>
            <td class="mono">${awb}</td>
            <td class="mono">${sprId}</td>
            <td>${sprName}</td>
            <td>${stCell}</td>
            <td>${addedBy}</td>
            <td class="mono">${tanggalSampai}</td>
            <td class="mono">${hp}</td>
            <td>${delBtn}</td>
          </tr>`;
      })
      .join("");

    tbody.querySelectorAll('[data-act="awb-del"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const awb = btn.getAttribute("data-awb");
        if (!awb) return;
        if (!confirm(`Hapus data AWB ${awb}?`)) return;
        deleteAwbSingle(awb).catch(() => {});
      });
    });
  }

  function bindAwbFilters() {
    // filter status disembunyikan (AWB list hanya pending)
    if ($("filterAWBStatus")) $("filterAWBStatus").style.display = "none";

    $("searchAWB")?.addEventListener("input", () => {
      __awbPage = 1;
      renderAwbTable();
    });

    $("awbApplyDateBtn")?.addEventListener("click", () => {
      __awbFrom = ($("awbFromDate")?.value || "").trim();
      __awbTo = ($("awbToDate")?.value || "").trim();
      __awbPage = 1;
      renderAwbTable();
    });

    $("awbResetDateBtn")?.addEventListener("click", () => {
      __awbFrom = "";
      __awbTo = "";
      if ($("awbFromDate")) $("awbFromDate").value = "";
      if ($("awbToDate")) $("awbToDate").value = "";
      __awbPage = 1;
      renderAwbTable();
    });

    $("downloadDeleteTemplateBtn")?.addEventListener("click", downloadDeleteTemplate);
    $("bulkDeleteBtn")?.addEventListener("click", () => {
      const f = $("deleteAwbFile")?.files?.[0];
      bulkDeleteAwbByExcel(f).catch(() => {});
    });
  }

  async function deleteAwbSingle(awb) {
    const r = await adminFetch("/api/admin/awbs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ awb }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return alert(j.error || "Gagal hapus AWB");

    await refreshAll();
    alert(`AWB ${awb} berhasil dihapus`);
  }

  async function bulkDeleteAwbByExcel(file) {
    if (!file) return alert("Pilih file Excel template hapus terlebih dahulu");
    if (!getAdminPin()) return alert("Admin belum login");

    if (!confirm("Yakin ingin hapus MASSAL berdasarkan file Excel ini?")) return;

    const fd = new FormData();
    fd.append("file", file);

    const r = await fetch("/api/admin/awbs/bulk-delete-xlsx", {
      method: "POST",
      headers: { "X-Admin-Pin": getAdminPin() },
      body: fd,
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return alert(j.error || "Gagal hapus massal");

    await refreshAll();
    alert(`Hapus massal selesai\nDeleted: ${j.deleted || 0}\nNot found: ${j.not_found || 0}`);
  }

  async function downloadDeleteTemplate() {
    try {
      const r = await adminFetch("/api/admin/awbs/delete-template", { method: "GET" });
      if (r.ok) {
        const blob = await r.blob();
        const blobUrl = URL.createObjectURL(blob);
        triggerDownload(blobUrl, `TEMPLATE_HAPUS_AWB_${new Date().toISOString().slice(0, 10)}.xlsx`);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
        return;
      }
    } catch (_) {}

    const csv = "awb\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    triggerDownload(blobUrl, `TEMPLATE_HAPUS_AWB_${new Date().toISOString().slice(0, 10)}.csv`);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    alert("Template .xlsx belum tersedia di server. Saya unduh versi .csv (bisa dibuka di Excel).");
  }

  // ---------- POD modal ----------
  function openUploadModal(u) {
    const modal = $("viewUploadModal");

    // ID selaras admin.html (fallback kompatibilitas)
    const elAWB = $("modalUploadAWB") || $("modalAWB");
    const elSpr = $("modalUploadSprinter") || $("modalSprinter");
    const elTime = $("modalUploadTime") || $("modalUploadTimestamp") || $("modalTime");
    const imgMerged = $("modalUploadImage") || $("modalMergedImg");
    const imgPhysical = $("modalPhysicalImage") || $("modalPhysicalImg");

    if (elAWB) elAWB.innerText = String(u.awb || u.waybill || "-");
    if (elSpr) {
      elSpr.innerText = `${String(u.sprinter_id || u.sprinter_code || "-")} - ${String(
        u.sprinter_name || "-"
      )}`;
    }
    if (elTime) elTime.innerText = fmtDateTime(u.timestamp || u.uploaded_at || "-");

    if (imgMerged) {
      if (u.merged_file_path) {
        imgMerged.src = u.merged_file_path.startsWith("/")
          ? u.merged_file_path
          : `/${u.merged_file_path}`;
        imgMerged.style.display = "";
      } else {
        imgMerged.removeAttribute("src");
        imgMerged.style.display = "none";
      }
    }

    if (imgPhysical) {
      if (u.physical_file_path) {
        imgPhysical.src = u.physical_file_path.startsWith("/")
          ? u.physical_file_path
          : `/${u.physical_file_path}`;
        imgPhysical.style.display = "";
      } else {
        imgPhysical.removeAttribute("src");
        imgPhysical.style.display = "none";
      }
    }

    if (modal) modal.style.display = "block";
  }

  function bindModalClose() {
    const closeBtns = [...qsa('[data-close="modal"]'), ...qsa(".modal-close")];
    closeBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault?.();
        const modal = btn.closest(".modal") || $("viewUploadModal");
        if (modal) modal.style.display = "none";
      });
    });

    qsa(".modal").forEach((m) => {
      m.addEventListener("click", (e) => {
        if (e.target === m) m.style.display = "none";
      });
    });
  }

async function validatePod(uploadId, action) {
  // server.js membaca query string: /api/admin/pods/validate?id=123&action=accept|reject
  const id = Number(uploadId || 0);
  const act = String(action || "").toLowerCase(); // "accept" | "reject"

  if (!id) return alert("ID upload tidak valid");
  if (act !== "accept" && act !== "reject") return alert("Action tidak valid");

  const url = `/api/admin/pods/validate?id=${encodeURIComponent(id)}&action=${encodeURIComponent(act)}`;

  const r = await adminFetch(url, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) return alert(j.error || "Gagal validasi POD");

  await refreshAll();
}

  // ---------- POD tab (Uploads / Validasi) ----------
  async function loadUploads() {
    if (!getAdminPin()) return;

    const r = await adminFetch("/api/admin/uploads");
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return;

    __uploadsCache = j.uploads || [];
    renderUploadsTable();
  }

function renderUploadsTable() {
  const tbody = $("uploadsTable");
  if (!tbody) return;

  const q = String($("searchUploads")?.value || "").trim().toLowerCase();
  const filter = String($("filterUploadStatus")?.value || "all").toLowerCase();

  let rows = Array.isArray(__uploadsCache) ? __uploadsCache.slice() : [];

  // filter status
  if (filter !== "all") {
    rows = rows.filter((u) => String(u.status || "").toLowerCase() === filter);
  }

  // search
  if (q) {
    rows = rows.filter((u) => {
      return (
        String(u.waybill || "").toLowerCase().includes(q) ||
        String(u.sprinter_code || "").toLowerCase().includes(q) ||
        String(u.sprinter_name || "").toLowerCase().includes(q)
      );
    });
  }

  // sort terbaru
  rows.sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );

  if (!rows.length) {
    // colspan 8 sesuai header POD HTML
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align:center; padding:30px; color:#999;">
          Tidak ada data
        </td>
      </tr>`;
    return;
  }

  const viewBtnHtml = (id) => `
    <button class="btn-mini secondary" data-act="view" data-upload-id="${id}">
      <i class="fas fa-eye"></i> VIEW
    </button>`;

  tbody.innerHTML = rows
    .map((u) => {
      const id = escapeHtml(u.id);
      const ts = escapeHtml(fmtDateTime(u.created_at || "-"));
      const sprCode = escapeHtml(u.sprinter_code || "-");
      const sprName = escapeHtml(u.sprinter_name || "-");
      const awb = escapeHtml(u.waybill || "-");

      const st = String(u.status || "").toLowerCase();
      const stBadge =
        st === "accepted"
          ? badge("DITERIMA", "ok")
          : st === "rejected"
          ? badge("DITOLAK", "danger")
          : badge("PENDING", "warn");

      // Foto POD = tombol VIEW (modal)
      const podCell = u.merged_file_path
        ? viewBtnHtml(id)
        : `<span style="color:#999;">-</span>`;

      // Foto Fisik = indikator ADA saja (tanpa tombol), karena bisa dilihat dari VIEW Foto POD
      const physCell = u.physical_file_path
        ? badge("ADA", "ok")
        : `<span style="color:#999;">-</span>`;

      const disable = st === "accepted" || st === "rejected";
      const actions = `
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn-mini success" data-act="acc" data-upload-id="${id}" ${disable ? "disabled" : ""}>
            <i class="fas fa-check"></i> Terima
          </button>
          <button class="btn-mini danger" data-act="rej" data-upload-id="${id}" ${disable ? "disabled" : ""}>
            <i class="fas fa-xmark"></i> Tolak
          </button>
        </div>`;

      return `
        <tr>
          <td class="mono">${ts}</td>
          <td class="mono">${sprCode}</td>
          <td>${sprName}</td>
          <td class="mono">${awb}</td>
          <td>${podCell}</td>
          <td>${physCell}</td>
          <td>${stBadge}</td>
          <td>${actions}</td>
        </tr>`;
    })
    .join("");

  // bind view -> buka modal
  tbody.querySelectorAll('[data-act="view"][data-upload-id]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-upload-id");
      const u = __uploadsCache.find((x) => String(x.id) === String(id));
      if (u) openUploadModal(u);
    });
  });

  // bind accept/reject
  tbody.querySelectorAll('[data-act="acc"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-upload-id");
      if (id && confirm("Terima POD ini?")) validatePod(id, "accept").catch(() => {});
    });
  });

  tbody.querySelectorAll('[data-act="rej"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-upload-id");
      if (id && confirm("Tolak POD ini?")) validatePod(id, "reject").catch(() => {});
    });
  });
}

 
 function bindUploadsFilters() {
  $("searchUploads")?.addEventListener("input", () => renderUploadsTable());
  $("filterUploadStatus")?.addEventListener("change", () => renderUploadsTable());

  // ✅ HTML pakai ID ini:
  // - downloadPodsZipBtn
  // - downloadPodsExcelBtn
  // JS lama bind ke downloadUploadsZipBtn/downloadUploadsExcelBtn (tidak ada di HTML)
  const zipBtn = $("downloadPodsZipBtn") || $("downloadUploadsZipBtn");
  const excelBtn = $("downloadPodsExcelBtn") || $("downloadUploadsExcelBtn");

  zipBtn?.addEventListener("click", () => downloadUploadsZip().catch(() => {}));
  excelBtn?.addEventListener("click", () => downloadUploadsExcel().catch(() => {}));
}

  
  async function downloadUploadsZip() {
    try {
      // Prioritas endpoint baru kamu
      let r = await adminFetch("/api/admin/pods/download-zip");
      if (!r.ok) r = await adminFetch("/api/admin/uploads/download-zip");
      if (!r.ok) throw new Error("ZIP endpoint not ok");

      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `POD_IMAGES_${new Date().toISOString().slice(0, 10)}.zip`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      alert("Fitur download ZIP belum tersedia / gagal di server.");
    }
  }

  async function downloadUploadsExcel() {
    try {
      let r = await adminFetch("/api/admin/pods/download-excel");
      if (!r.ok) r = await adminFetch("/api/admin/uploads/download-excel");
      if (!r.ok) throw new Error("Excel endpoint not ok");

      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `POD_LIST_${new Date().toISOString().slice(0, 10)}.xlsx`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      alert("Fitur download Excel POD belum tersedia / gagal di server.");
    }
  }

  // ---------- upload xlsx (AWB import) ----------
  async function uploadAwbExcel(file) {
  if (!file) return alert("Pilih file Excel terlebih dahulu");
  if (!getAdminPin()) return alert("Admin belum login");

  const fd = new FormData();
  fd.append("file", file);

  const r = await fetch("/api/admin/awbs/upload-xlsx", {
    method: "POST",
    headers: { "X-Admin-Pin": getAdminPin() },
    body: fd,
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) {
    return alert(j.error || "Gagal upload Excel AWB");
  }

  alert(
    `Upload selesai ✅\n\n` +
    `Total baris Excel : ${j.total_rows || 0}\n` +
    `AWB baru masuk    : ${j.inserted || 0}\n` +
    `AWB sudah ada     : ${j.skipped || 0}`
  );

  await refreshAll();
}

  function bindUploadAwbExcel() {
    $("uploadAwbBtn")?.addEventListener("click", () => {
      const file = $("awbExcelFile")?.files?.[0] || $("awbFile")?.files?.[0];
      uploadAwbExcel(file).catch(() => {});
    });
  }

  // ---------- download helpers ----------
  function triggerDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- refresh ----------
  async function refreshAll() {
    if (!getAdminPin()) return;
    await Promise.allSettled([loadReportSummary(), loadSprinters(), loadAwbList(), loadUploads()]);
  }

  // ---------- init ----------
 function init() {
  // login & auto-login
  $("loginBtn")?.addEventListener("click", () => adminLogin().catch(() => {}));
  $("adminPin")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") adminLogin().catch(() => {});
  });
  $("logoutBtn")?.addEventListener("click", adminLogout);

  // tombol refresh header
  $("refreshBtn")?.addEventListener("click", () => {
    refreshAll().catch(() => {});
  });

  autoLoginIfPinExists();

  // tabs
  qsa(".nav-item.tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      setActiveTab(tab);

      if (tab === "dashboard") loadRecentActivityFromCache();
      if (tab === "sprinter") loadSprinters().catch(() => {});
      if (tab === "awb") loadAwbList().catch(() => {});
      if (tab === "uploads") loadUploads().catch(() => {});
    });
  });

  // bind filters & actions
  bindSprinterFilters();
  bindAwbFilters();
  bindDashboardFilters();
  bindUploadsFilters();
  bindUploadAwbExcel();
  bindModalClose();

  // ✅ NEW: tambah sprinter modal + save
  bindAddSprinter();

  // default tab
  setActiveTab("dashboard");
}

  
  init();
})();

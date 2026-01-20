// tools/proofgen/proofgen.routes.js
// Pure http routing handlers for:
// - GET  /admin-tools
// - POST /api/admin/tools/proofgen/start
// - GET  /api/admin/tools/proofgen/status?jobId=...
// - GET  /api/admin/tools/proofgen/download?jobId=...
// - POST /api/admin/tools/proofgen/cleanup   (optional)

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const Busboy = require("busboy");

const { createProofgenService } = require("./proofgen.service");

// -------------------- helpers --------------------
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function parseQuery(input) {
  // Support dipanggil pakai req (IncomingMessage) atau string URL
  const urlStr =
    (input && typeof input === "object" && typeof input.url === "string")
      ? input.url
      : String(input || "/");

  const u = new URL(urlStr, "http://localhost");
  const out = {};
  for (const [k, v] of u.searchParams.entries()) out[k] = v;
  return out;
}


async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function ensureWarmPng(workDir) {
  // PNG 1x1 transparan (valid), dipakai untuk menghindari ENOENT warmup
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X1nWQAAAAASUVORK5CYII=",
    "base64"
  );

  const files = ["__warm_sms.png", "__warm_kontak.png"];
  await ensureDir(workDir);

  for (const name of files) {
    const fp = path.join(workDir, name);
    try {
      if (!fs.existsSync(fp)) {
        await fsp.writeFile(fp, tinyPng);
      }
    } catch {
      // Kalau gagal write, biarkan service yang lapor error selanjutnya (lebih informatif)
    }
  }
}


async function readJsonBody(req, limitBytes = 512 * 1024) {
  // sederhana & aman untuk body kecil (cleanup)
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("Body too large"));
        try {
          req.destroy();
        } catch {}
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function requireAdmin(req, ctx) {
  // Prioritas: integrasi server.js via ctx.isAdmin(req)
  if (ctx && typeof ctx.isAdmin === "function") return !!ctx.isAdmin(req);

  // Fallback kompatibel: header X-Admin-Pin
  const pin = (req.headers["x-admin-pin"] || "").toString();
  const expected = (process.env.ADMIN_PIN || "").toString();
  return !!expected && pin === expected;
}

function isAdminRequest(req, ctx) {
  return requireAdmin(req, ctx);
}


function match(req, method, pathname) {
  if (req.method !== method) return false;
  const u = new URL(req.url, "http://localhost");
  return u.pathname === pathname;
}

function getPathname(req) {
  try {
    const u = new URL(req.url || "/", "http://localhost");
    return u.pathname || "/";
  } catch (e) {
    return "/";
  }
}


// -------------------- routes factory --------------------
function createRoutes(options = {}) {
  const service =
    options.service || createProofgenService(options.serviceOptions || {});

  // Disarankan server.js mengirim __dirname, tapi kita support default
  const publicAdminToolsPath =
    options.publicAdminToolsPath || path.join(process.cwd(), "admin_tools.html");

  // Optional: dipanggil berkala dari server.js (kalau mau)
  async function tickCleanup() {
    await service.cleanupExpired(2 * 60 * 60 * 1000); // 2 jam
  }

  async function handleAdminToolsPage(req, res) {
    try {
      const html = await fsp.readFile(publicAdminToolsPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      sendJson(res, 500, { success: false, message: "Gagal load admin_tools.html" });
    }
  }

  async function handleStart(req, res, ctx) {
  if (!isAdminRequest(req, ctx)) {
    return sendJson(res, 401, { success: false, message: "Unauthorized (admin only)" });
  }

  // Guard biar tidak double response
  let responded = false;
  const sendOnce = (code, obj) => {
    if (responded) return;
    responded = true;
    try {
      if (!res.headersSent) sendJson(res, code, obj);
      else res.end();
    } catch {
      try { res.end(); } catch {}
    }
  };

  // staging folder upload sementara (dipakai langsung oleh service)
  const stagingId = `UPLOAD_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const stagingBase = path.join(service.baseTmpDir, stagingId);
  const uploadDir = path.join(stagingBase, "input");
  await ensureDir(uploadDir);

  let excelPath = "";
  let timemarkPath = "";
  const fileWrites = [];

  const bb = Busboy({
    headers: req.headers,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
  });

  bb.on("file", (field, file, info) => {
    const filename = (info && info.filename) ? info.filename : "file.bin";
    const ext = path.extname(filename).toLowerCase();

    let target = "";
    if (field === "excel") {
      target = path.join(uploadDir, `data${ext || ".xlsx"}`);
      excelPath = target;
    } else if (field === "timemark") {
      target = path.join(uploadDir, `timemark${ext || ".jpg"}`);
      timemarkPath = target;
    } else {
      file.resume();
      return;
    }

    const ws = fs.createWriteStream(target);
    file.pipe(ws);

    const p = new Promise((resolve, reject) => {
      ws.on("finish", resolve);
      ws.on("error", reject);
      file.on("error", reject);

      file.on("limit", () => {
        reject(new Error(`File too large: ${filename}`));
        try { ws.destroy(); } catch {}
        try { file.resume(); } catch {}
      });
    });

    fileWrites.push(p);
  });

  bb.on("error", (err) => {
    if (responded) return;
    sendOnce(400, { success: false, message: err.message || "Upload error" });
  });

  bb.on("finish", async () => {
    if (responded) return;

    try {
      const settled = await Promise.allSettled(fileWrites);
      for (const s of settled) {
        if (s.status === "rejected") throw s.reason;
      }

      if (!excelPath || !fs.existsSync(excelPath)) {
        return sendOnce(400, { success: false, message: "File excel wajib diupload (field=excel)" });
      }
      if (!timemarkPath || !fs.existsSync(timemarkPath)) {
        return sendOnce(400, { success: false, message: "File timemark wajib diupload (field=timemark)" });
      }

      // Create job (service akan mulai proses async) -> BIARKAN input tetap di stagingBase
      const job = await service.createJob({
        inputExcelPath: excelPath,
        timemarkPath: timemarkPath,
      });

      // Simpan referensi staging untuk cleanup nanti (opsional, tidak mengubah flow)
      try { job.stagingBase = stagingBase; } catch {}

      // ✅ Pastikan warmup files ada di folder kerja job (sesuai error warmup sebelumnya)
      await ensureWarmPng(path.join(job.baseDir, "work"));

      return sendOnce(200, { success: true, jobId: job.jobId });
    } catch (e) {
      const msg = (e && e.message) ? e.message : "Gagal start job";
      const isTooLarge = /too large/i.test(msg);
      return sendOnce(isTooLarge ? 413 : 500, { success: false, message: msg });
    }
  });

  req.pipe(bb);
}

  
  // ✅ INI yang hilang di file kamu sebelumnya -> penyebab crash
  async function handleStatus(req, res, ctx) {
    if (!isAdminRequest(req, ctx)) {
      return sendJson(res, 401, { success: false, message: "Unauthorized (admin only)" });
    }

    const q = parseQuery(req);
    const jobId = (q.jobId || "").trim();
    if (!jobId) {
      return sendJson(res, 400, { success: false, message: "jobId wajib" });
    }

    const job = service.getJob(jobId);
    if (!job) {
      return sendJson(res, 404, { success: false, message: "Job tidak ditemukan / sudah dibersihkan" });
    }

    return sendJson(res, 200, {
      success: true,
      job: {
        jobId: job.jobId,
        state: job.state,
        total: job.total || 0,
        done: job.done || 0,
        failed: job.failed || 0,
        createdAt: job.createdAt || null,
        readyAt: job.readyAt || null,
        zipSize: job.zipSize || null,
        errorMessage: job.errorMessage || null,
        errors: (job.errors || []).slice(0, 50),
      },
    });
  }

  async function handleDownload(req, res, ctx) {
    if (!isAdminRequest(req, ctx)) {
      return sendJson(res, 401, { success: false, message: "Unauthorized (admin only)" });
    }

    const q = parseQuery(req);
    const jobId = (q.jobId || "").trim();
    if (!jobId) {
      return sendJson(res, 400, { success: false, message: "jobId wajib" });
    }

    const job = service.getJob(jobId);
    if (!job) {
      return sendJson(res, 404, { success: false, message: "Job tidak ditemukan / sudah dibersihkan" });
    }

    if (job.state !== "ready" || !job.zipPath || !fs.existsSync(job.zipPath)) {
      return sendJson(res, 409, { success: false, message: "File belum siap. Tunggu proses selesai." });
    }

    const zipName = path.basename(job.zipPath);
    const stat = await fsp.stat(job.zipPath);

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${zipName}"`,
    });

    const rs = fs.createReadStream(job.zipPath);
    rs.pipe(res);

    let finished = false;

    res.on("finish", async () => {
      finished = true;
      await service.cleanup(jobId); // setelah download sukses -> cleanup
    });

    res.on("close", async () => {
      if (!finished) {
        // client abort -> no-op, TTL cleaner will handle
      }
    });

    rs.on("error", () => {
      try { res.end(); } catch {}
    });
  }

  async function handleCleanup(req, res, ctx) {
    if (!isAdminRequest(req, ctx)) {
      return sendJson(res, 401, { success: false, message: "Unauthorized (admin only)" });
    }

    let jobId = "";
    try {
      const q = parseQuery(req);
      jobId = (q.jobId || "").trim();
      if (!jobId) {
        const body = await readJsonBody(req).catch(() => ({}));
        jobId = (body.jobId || "").toString().trim();
      }
    } catch {}

    if (!jobId) {
      return sendJson(res, 400, { success: false, message: "jobId wajib" });
    }

    const job = service.getJob(jobId);
    if (!job) {
      return sendJson(res, 404, { success: false, message: "Job tidak ditemukan / sudah dibersihkan" });
    }

    await service.cleanup(jobId);
    return sendJson(res, 200, { success: true });
  }

  // ---- MAIN ENTRY: dipanggil server.js ----
  async function handle(req, res, ctx = {}) {
    // Page
    if (req.method === "GET" && getPathname(req) === "/admin-tools") {
      await handleAdminToolsPage(req, res);
      return true;
    }

    // API
    if (match(req, "POST", "/api/admin/tools/proofgen/start")) {
      await handleStart(req, res, ctx);
      return true;
    }

    if (match(req, "GET", "/api/admin/tools/proofgen/status")) {
      await handleStatus(req, res, ctx);
      return true;
    }

    if (match(req, "GET", "/api/admin/tools/proofgen/download")) {
      await handleDownload(req, res, ctx);
      return true;
    }

    if (match(req, "POST", "/api/admin/tools/proofgen/cleanup")) {
      await handleCleanup(req, res, ctx);
      return true;
    }

    return false;
  }

  return { handle, tickCleanup, service };
}

module.exports = { createRoutes };

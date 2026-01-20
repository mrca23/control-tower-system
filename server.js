/**
 * server.js FINAL (MySQL schema-aligned + admin extra features enabled)
 * - Pure Node http (no express)
 * - Admin login via PIN (header X-Admin-Pin)
 * - Sprinter login via MySQL + JSON sessions
 * - Admin upload AWB via Excel (xlsx/xls)
 * - Sprinter upload POD multi-image merged left->right (sharp)
 * - Admin: list sprinters/awbs/uploads + report summary
 * - Admin extra:
 *    - edit/delete sprinter
 *    - delete single AWB
 *    - bulk delete AWB by xlsx
 *    - download delete-template xlsx
 *    - validate POD accept/reject
 *    - download ZIP all POD images
 *    - download Excel list POD
 *
 * Notes:
 * - Some DB columns may not exist depending on your table definition.
 *   This server detects columns (pods.physical_file_path, pods.status, awbs.has_pod) and degrades gracefully.
 */

require("dotenv").config();
const http = require("http");
const url = require("url");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;

let mysql;
try { mysql = require("mysql2/promise"); } catch { mysql = null; }

let Busboy;
try { Busboy = require("busboy"); } catch { Busboy = null; }

let XLSX;
try { XLSX = require("xlsx"); } catch { XLSX = null; }

let Archiver;
try { Archiver = require("archiver"); } catch { Archiver = null; }

// ================== [ADDED] Admin Tools: Proof Generator routes (optional module) ==================
let ProofgenRoutesFactory = null;

const PROOFGEN_TRY_PATHS = [
  "./tools/proofgen/proofgen.routes",
  "./tools/proofgen/proofgen.routes.js",
  "./proofgen.routes",
  "./proofgen.routes.js",
];

let lastProofgenErr = null;

for (const p of PROOFGEN_TRY_PATHS) {
  try {
    const mod = require(p);
    if (mod && typeof mod.createRoutes === "function") {
      ProofgenRoutesFactory = mod.createRoutes;
      console.log("✅ Proofgen routes loaded from:", p);
      lastProofgenErr = null;
      break;
    } else {
      lastProofgenErr = new Error(`Module loaded but createRoutes() not found in ${p}`);
    }
  } catch (e) {
    lastProofgenErr = e;
  }
}

const proofgenRoutes = ProofgenRoutesFactory
  ? ProofgenRoutesFactory({ publicAdminToolsPath: path.join(__dirname, "admin_tools.html") })
  : null;

if (!proofgenRoutes) {
  console.log("❌ Proofgen routes NOT active -> /api/admin/tools/proofgen/* akan 404");
  if (lastProofgenErr) {
    console.log("   Reason:", lastProofgenErr.message ? lastProofgenErr.message : String(lastProofgenErr));
  }
}
// ==================================================================================================


// ==================================================================================================

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || "1234").trim();

const DB_FOLDER = path.join(__dirname, "database");
const DB_FILES = {
  USERS: path.join(DB_FOLDER, "users.json"),
  SESSIONS: path.join(DB_FOLDER, "sessions.json"),
};

const SPRINTER_ID_REGEX = /^LS\d{10}$/i; // login sprinter tetap LS########## (bisa diubah nanti)
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 24);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 2 * 1024 * 1024);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024);

// ------------------ helpers ------------------

function nowISO() { return new Date().toISOString(); }

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }

async function ensureJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    await fsp.writeFile(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, filePath);
}

function setCORS(req, res) {
  // Lebih fleksibel: reflect origin kalau ada.
  // (Frontend kamu pakai header token/pin, bukan cookie; jadi aman.)
  const origin = String(req.headers.origin || "").trim();
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-User-ID, X-Session-ID, X-Device-ID, X-Admin-Pin"
  );
}

function sendJSON(req, res, status, payload) {
  setCORS(req, res);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
  res.end(JSON.stringify(payload));
}

function ok(req, res, data = {}) { sendJSON(req, res, 200, { success: true, ...data }); }
function fail(req, res, status, message) { sendJSON(req, res, status, { success: false, error: message }); }

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJSONBody(req) {
  const body = await readBody(req);
  return JSON.parse(body || "{}");
}

function safeJoinFromUrl(baseDir, urlPath) {
  // normalize + stop traversal
  const normalized = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(baseDir, normalized);
}

function serveFile(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>404</h1>");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".ico": "image/x-icon",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls": "application/vnd.ms-excel",
      ".zip": "application/zip",
    }[ext] || "application/octet-stream";

    setCORS(req, res);
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// ------------------ sessions (json) ------------------

function newToken() { return crypto.randomBytes(24).toString("hex"); }
function getUserId(req) { return String(req.headers["x-user-id"] || "").trim().toUpperCase(); }
function getSessionId(req) {
  // kompatibel: frontend lama kirim X-Device-ID
  return String(req.headers["x-session-id"] || req.headers["x-device-id"] || "").trim();
}

async function upsertSession(user_id, session_id, role) {
  const sessions = await readJsonFile(DB_FILES.SESSIONS, []);
  const filtered = sessions.filter((s) => s.user_id !== user_id);
  filtered.push({ user_id, session_id, role, login_time: nowISO(), last_activity: nowISO() });
  await writeJsonAtomic(DB_FILES.SESSIONS, filtered);
}

async function removeSession(user_id) {
  const sessions = await readJsonFile(DB_FILES.SESSIONS, []);
  const filtered = sessions.filter((s) => s.user_id !== user_id);
  await writeJsonAtomic(DB_FILES.SESSIONS, filtered);
}

async function validateSession(user_id, session_id) {
  if (!user_id || !session_id) return false;
  const sessions = await readJsonFile(DB_FILES.SESSIONS, []);
  const s = sessions.find((x) => x.user_id === user_id && x.session_id === session_id);
  if (!s) return false;

  const last = new Date(s.last_activity);
  const diffHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
  if (diffHours > SESSION_TTL_HOURS) {
    await removeSession(user_id);
    return false;
  }
  s.last_activity = nowISO();
  await writeJsonAtomic(DB_FILES.SESSIONS, sessions);
  return true;
}

// ------------------ MySQL ------------------

let pool = null;
let mysqlReady = false;

// Column capabilities (detected at startup)
const CAP = {
  pods_has_created_at: false,
  pods_has_physical: false,
  pods_has_status: false,
  awbs_has_has_pod: false,
};

function mysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "jt_pod",
  };
}

async function detectColumns() {
  if (!mysqlReady || !pool) return;

  async function hasCol(table, col) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS c
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?`,
      [table, col]
    );
    return Number(rows?.[0]?.c || 0) > 0;
  }

  CAP.pods_has_created_at = await hasCol("pods", "created_at");
  CAP.pods_has_physical = await hasCol("pods", "physical_file_path");
  CAP.pods_has_status = await hasCol("pods", "status");
  CAP.awbs_has_has_pod = await hasCol("awbs", "has_pod");
}

async function initMySQL() {
  if (!mysql) {
    mysqlReady = false;
    console.log("⚠️ mysql2 not installed. Run: npm i mysql2");
    return;
  }
  try {
    const cfg = mysqlConfig();
    pool = mysql.createPool({
      ...cfg,
      waitForConnections: true,
      connectionLimit: 5,
      timezone: "Z",
    });
    await pool.query("SELECT 1");
    mysqlReady = true;
    console.log("✅ MySQL ready:", `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

    await detectColumns();
    console.log("ℹ️ CAP:", CAP);
  } catch (e) {
    mysqlReady = false;
    pool = null;
    console.log("❌ MySQL connect failed:", e.message);
  }
}

// ------------------ Excel helpers ------------------

function normHeader(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateTimeLoose(v) {
  if (!v) return null;
  if (v instanceof Date) return v;

  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (m) {
    const yyyy = Number(m[1]), mm = Number(m[2]) - 1, dd = Number(m[3]);
    const HH = Number(m[4] || 0), MI = Number(m[5] || 0), SS = Number(m[6] || 0);
    return new Date(Date.UTC(yyyy, mm, dd, HH, MI, SS));
  }

  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t);
  return null;
}

function toMysqlDate(d) {
  if (!(d instanceof Date)) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toMysqlDateTime(d) {
  if (!(d instanceof Date)) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MI = String(d.getUTCMinutes()).padStart(2, "0");
  const SS = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MI}:${SS}`;
}

// ------------------ DB functions ------------------

async function dbFindSprinterByCode(code) {
  if (!mysqlReady || !pool) return null;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const [rows] = await pool.execute(
    "SELECT id, code, name, active FROM sprinters WHERE UPPER(code)=? LIMIT 1",
    [c]
  );
  return rows[0] || null;
}

async function dbUpsertSprinter(code, name) {
  if (!mysqlReady || !pool) return null;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;

  const n = String(name || "").trim() || c;

  await pool.execute(
    "INSERT IGNORE INTO sprinters (code, name, active) VALUES (?,?,1)",
    [c, n]
  );

  await pool.execute(
    "UPDATE sprinters SET name=COALESCE(NULLIF(name,''), ?) WHERE UPPER(code)=?",
    [n, c]
  );

  const spr = await dbFindSprinterByCode(c);
  return spr ? spr.id : null;
}

async function dbGetSprinterForLogin(sprinter_code) {
  if (!mysqlReady || !pool) return null;
  const c = String(sprinter_code || "").trim().toUpperCase();
  const [rows] = await pool.execute(
    "SELECT id, code, name, active FROM sprinters WHERE UPPER(code)=? LIMIT 1",
    [c]
  );
  if (!rows.length) return null;
  if (Number(rows[0].active) !== 1) return null;
  return { id: rows[0].code, name: rows[0].name };
}

async function dbListSprinters() {
  if (!mysqlReady || !pool) return [];
  const [rows] = await pool.query(
    "SELECT id, code AS id_code, name, active, created_at, updated_at FROM sprinters ORDER BY id DESC"
  );
  return rows.map((r) => ({
    id: r.id_code,
    name: r.name,
    status: Number(r.active) === 1 ? "active" : "inactive",
    last_login: "-",
    created_at: r.created_at,
  }));
}

// ------------------ auth guards ------------------

function requireAdminPin(req, res) {
  const adminPin = String(req.headers["x-admin-pin"] || "").trim();
  if (adminPin !== ADMIN_PIN) {
    fail(req, res, 401, "Unauthorized - Invalid Admin PIN");
    return false;
  }
  return true;
}

// ================== [ADDED] helper boolean for tools ctx ==================
function isAdminRequest(req) {
  const adminPin = String(req.headers["x-admin-pin"] || "").trim();
  return adminPin === ADMIN_PIN;
}
// ==========================================================================

async function requireSprinterSession(req, res) {
  const userId = getUserId(req);
  const token = getSessionId(req);
  if (!userId || !token) {
    fail(req, res, 400, "X-User-ID & X-Session-ID required");
    return null;
  }
  const valid = await validateSession(userId, token);
  if (!valid) {
    fail(req, res, 401, "Session invalid/expired");
    return null;
  }
  return userId;
}

// ------------------ API handlers ------------------

async function handleAdminLogin(req, res) {
  try {
    if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");
    const data = await readJSONBody(req);
    const pin = String(data.pin || data.admin_pin || "").trim();
    if (!pin) return fail(req, res, 400, "Admin PIN required");
    if (pin !== ADMIN_PIN) return fail(req, res, 401, "Invalid Admin PIN");

    const token = newToken();
    await upsertSession("ADMIN", token, "admin");
    return ok(req, res, { message: "Login admin berhasil", session_id: token });
  } catch (e) {
    return fail(req, res, 400, e.message);
  }
}

async function handleSprinterLogin(req, res) {
  try {
    if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");
    const data = await readJSONBody(req);

    const sprinter_id = String(data.sprinter_id || "").trim().toUpperCase();

    if (!sprinter_id) return fail(req, res, 400, "Sprinter ID required");

    // ✅ LONGGAR: tidak wajib format LS##########
    // Validasi ringan agar aman & konsisten dengan frontend
    if (sprinter_id.length < 3 || sprinter_id.length > 40) {
      return fail(req, res, 400, "ID sprinter minimal 3 karakter (maks 40)");
    }
    if (!/^[A-Z0-9_-]+$/.test(sprinter_id)) {
      return fail(req, res, 400, "ID sprinter hanya boleh huruf/angka, '_' atau '-'");
    }

    if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");

    const spr = await dbGetSprinterForLogin(sprinter_id);
    if (!spr) return fail(req, res, 401, "Sprinter ID tidak ditemukan atau tidak aktif");

    const token = newToken();
    await upsertSession(sprinter_id, token, "sprinter");

    return ok(req, res, {
      message: "Login berhasil",
      user: { id: spr.id, name: spr.name, session_id: token, device_id: token },
    });
  } catch (e) {
    return fail(req, res, 400, e.message);
  }
}


async function handleLogout(req, res) {
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");
  const userId = getUserId(req);
  if (!userId) return fail(req, res, 400, "X-User-ID required");
  await removeSession(userId);
  return ok(req, res, { message: "Logout OK" });
}

async function handleSessionCheck(req, res) {
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");
  const userId = getUserId(req);
  const token = getSessionId(req);
  if (!userId || !token) return fail(req, res, 400, "X-User-ID & X-Session-ID required");
  const valid = await validateSession(userId, token);
  if (!valid) return fail(req, res, 401, "Session invalid/expired");
  return ok(req, res, { valid: true });
}

// ---------- Sprinter AWB list ----------
async function handleSprinterAwbList(req, res) {
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");

  const userId = await requireSprinterSession(req, res);
  if (!userId) return;

  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");

  try {
    const [rows] = await pool.execute(`
      SELECT
        a.waybill AS awb,
        a.arrival_date AS tanggal_sampai,
        a.receiver_phone,                    -- ✅ PENTING
        CASE WHEN p.id IS NULL THEN 'pending' ELSE 'delivered' END AS status
      FROM awbs a
      INNER JOIN sprinters s ON s.id = a.sprinter_id
      LEFT JOIN pods p ON p.awb_id = a.id
      WHERE UPPER(s.code) = ?
      ORDER BY a.arrival_date DESC, a.waybill DESC
    `, [userId]);

    const awb_list = rows || [];
    const pending_count = awb_list.filter(a => a.status === "pending").length;

    return ok(req, res, { awb_list, pending_count });
  } catch (e) {
    console.error("sprinter awb list error:", e);
    return fail(req, res, 500, "Gagal mengambil AWB sprinter");
  }
}

// ---------- Sprinter uploads list ----------
async function handleSprinterUploads(req, res) {
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");

  const userId = await requireSprinterSession(req, res);
  if (!userId) return;

  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");

  try {
    let sql = `
      SELECT
        p.id,
        a.waybill AS awb,
        p.merged_file_path
        ${CAP.pods_has_created_at ? ", p.created_at AS timestamp" : ""}
        ${CAP.pods_has_physical ? ", p.physical_file_path" : ""}
      FROM pods p
      INNER JOIN awbs a ON a.id = p.awb_id
      INNER JOIN sprinters s ON s.id = a.sprinter_id
      WHERE UPPER(s.code) = ?
      ORDER BY p.id DESC
      LIMIT 2000
    `;

    const [rows] = await pool.execute(sql, [userId]);

    return ok(req, res, {
      uploads: rows || [],
      total: (rows || []).length,
      today_uploads: 0,
    });
  } catch (e) {
    console.error("handleSprinterUploads error:", e);
    return fail(req, res, 500, "Gagal mengambil uploads");
  }
}

// ---------- Sprinter save receiver phone (AWB pending + phone) ----------
async function handleSprinterAwbSavePhone(req, res) {
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");

  const userId = await requireSprinterSession(req, res);
  if (!userId) return;

  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");

  try {
    const data = await readJSONBody(req);
    const awb = String(data.awb || "").trim().toUpperCase();
    const phoneRaw = String(data.phone || "").trim();

    if (!awb) return fail(req, res, 400, "awb wajib");
    if (!phoneRaw) return fail(req, res, 400, "Nomor HP tidak boleh kosong");

    // validasi digit 8-16 (mirip sprinter.js)
    const digits = phoneRaw.replace(/[^\d]/g, "");
    if (digits.length < 8 || digits.length > 16) {
      return fail(req, res, 400, "Nomor HP harus 8-16 digit");
    }

    // pastikan AWB milik sprinter ini
    const [[row]] = await pool.execute(
      `
      SELECT a.id AS awb_id
      FROM awbs a
      INNER JOIN sprinters s ON s.id = a.sprinter_id
      WHERE a.waybill = ? AND UPPER(s.code) = ?
      LIMIT 1
      `,
      [awb, userId]
    );

    if (!row) return fail(req, res, 404, "AWB tidak ditemukan / bukan milik sprinter ini");

    // simpan ke DB
    await pool.execute(
      `UPDATE awbs SET receiver_phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [phoneRaw, row.awb_id]
    );

    return ok(req, res, { message: "Nomor HP tersimpan", awb, receiver_phone: phoneRaw });
  } catch (e) {
    console.error("handleSprinterAwbSavePhone error:", e);
    return fail(req, res, 500, "Gagal simpan nomor HP");
  }
}


// ---------- Sprinter upload POD (multipart) ----------
async function handleSprinterUpload(req, res) {
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");
  if (!Busboy) return fail(req, res, 500, "busboy not installed (npm i busboy)");
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");

  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("multipart/form-data")) {
    return fail(req, res, 415, "Upload harus multipart/form-data (FormData). Jangan kirim JSON.");
  }

  const userId = await requireSprinterSession(req, res);
  if (!userId) return;

  let sharp;
  try { sharp = require("sharp"); }
  catch { return fail(req, res, 500, "sharp not installed (npm i sharp)"); }

  const busboy = Busboy({
    headers: req.headers,
    limits: { files: 12, fileSize: MAX_UPLOAD_BYTES },
  });

  let awb = "";
  const images = []; // photos
  let physicalFile = null; // field name "physical"

  busboy.on("field", (name, value) => {
    if (name === "awb") awb = String(value || "").trim().toUpperCase();
  });

  busboy.on("file", (name, file, info) => {
    const chunks = [];
    file.on("data", (d) => chunks.push(d));
    file.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return;

      if (name === "photos") {
        images.push({
          buffer: buf,
          filename: info?.filename || "photo.jpg",
          mimetype: info?.mimeType || info?.mimetype || "",
        });
      } else if (name === "physical") {
        physicalFile = {
          buffer: buf,
          filename: info?.filename || "physical.jpg",
          mimetype: info?.mimeType || info?.mimetype || "",
        };
      }
    });
    file.on("error", () => file.resume());
  });

  busboy.on("finish", async () => {
    try {
      if (!awb) return fail(req, res, 400, "AWB wajib diisi (field: awb)");
      if (images.length < 2) return fail(req, res, 400, "Minimal 2 foto POD (field file: photos)");

      const [[awbRow]] = await pool.execute(`
        SELECT a.id AS awb_id
        FROM awbs a
        INNER JOIN sprinters s ON s.id = a.sprinter_id
        WHERE a.waybill = ? AND UPPER(s.code) = ?
        LIMIT 1
      `, [awb, userId]);

      if (!awbRow) return fail(req, res, 404, "AWB tidak ditemukan / bukan milik sprinter ini");

      const [[podExist]] = await pool.execute(`SELECT id FROM pods WHERE awb_id = ? LIMIT 1`, [awbRow.awb_id]);
      if (podExist) return fail(req, res, 409, "POD untuk AWB ini sudah pernah diupload");

      await ensureDir(path.join(__dirname, "uploads", "pod_merged"));
      await ensureDir(path.join(__dirname, "uploads", "pod_physical"));

      const TARGET_H = 700;

      const resizedBuffers = await Promise.all(
        images.map((img) =>
          sharp(img.buffer)
            .rotate()
            .resize({ height: TARGET_H })
            .jpeg({ quality: 90 })
            .toBuffer()
        )
      );

      const metas = await Promise.all(resizedBuffers.map((b) => sharp(b).metadata()));
      const totalW = metas.reduce((sum, m) => sum + Number(m.width || 0), 0);
      if (!totalW) return fail(req, res, 400, "Foto tidak valid (gagal dibaca)");

      let x = 0;
      const composite = resizedBuffers.map((buf, i) => {
        const c = { input: buf, left: x, top: 0 };
        x += Number(metas[i].width || 0);
        return c;
      });

      const mergedName = `${awb}_${userId}_${Date.now()}_MERGED.jpg`;
      const mergedRel = path.join("uploads", "pod_merged", mergedName).replace(/\\/g, "/");
      const mergedAbs = path.join(__dirname, mergedRel);

      await sharp({
        create: {
          width: totalW,
          height: TARGET_H,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      }).composite(composite).jpeg({ quality: 92 }).toFile(mergedAbs);

      // Optional physical save
      let physicalRel = null;
      if (physicalFile && CAP.pods_has_physical) {
        const phyName = `${awb}_${userId}_${Date.now()}_PHYSICAL.jpg`;
        physicalRel = path.join("uploads", "pod_physical", phyName).replace(/\\/g, "/");
        const phyAbs = path.join(__dirname, physicalRel);
        await sharp(physicalFile.buffer).rotate().resize({ width: 1200 }).jpeg({ quality: 90 }).toFile(phyAbs);
      }

      // Insert into pods (dynamic columns)
      if (CAP.pods_has_physical && physicalRel) {
        await pool.execute(
          `INSERT INTO pods (awb_id, merged_file_path, physical_file_path) VALUES (?,?,?)`,
          [awbRow.awb_id, mergedRel, physicalRel]
        );
      } else {
        await pool.execute(
          `INSERT INTO pods (awb_id, merged_file_path) VALUES (?, ?)`,
          [awbRow.awb_id, mergedRel]
        );
      }

      // Update awbs status + has_pod if column exists
      if (CAP.awbs_has_has_pod) {
        await pool.execute(
          `UPDATE awbs SET has_pod = 1, status = 'pod_uploaded' WHERE id = ?`,
          [awbRow.awb_id]
        );
      } else {
        await pool.execute(
          `UPDATE awbs SET status = 'pod_uploaded' WHERE id = ?`,
          [awbRow.awb_id]
        );
      }

      return ok(req, res, { message: "Upload POD berhasil", awb, merged_file: mergedRel, physical_file: physicalRel });
    } catch (e) {
      console.error("handleSprinterUpload error:", e);
      return fail(req, res, 500, "Gagal upload POD");
    }
  });

  req.pipe(busboy);
}

// ---------- Admin: sprinters list ----------
async function handleAdminSprinters(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");

  const users = await dbListSprinters();
  return ok(req, res, { users, total: users.length, mode: "mysql" });
}

// ---------- Admin: edit sprinter ----------
async function handleAdminSprinterUpdate(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");

  try {
    const data = await readJSONBody(req);
    const code = String(data.id || data.code || "").trim().toUpperCase();
    const name = String(data.name || "").trim();

    if (!code || !name) return fail(req, res, 400, "id & name wajib");

    await pool.execute(`UPDATE sprinters SET name=? WHERE UPPER(code)=?`, [name, code]);
    return ok(req, res, { message: "Sprinter updated" });
  } catch (e) {
    console.error("sprinter update error:", e);
    return fail(req, res, 500, "Gagal update sprinter");
  }
}

// ---------- Admin: delete sprinter ----------
async function handleAdminSprinterDelete(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");

  try {
    const data = await readJSONBody(req);
    const code = String(data.id || data.code || "").trim().toUpperCase();
    if (!code) return fail(req, res, 400, "id wajib");

    await pool.execute(`DELETE FROM sprinters WHERE UPPER(code)=?`, [code]);
    return ok(req, res, { message: "Sprinter deleted" });
  } catch (e) {
    console.error("sprinter delete error:", e);
    return fail(req, res, 500, "Gagal hapus sprinter");
  }
}

async function handleAdminSprinterCreate(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");

  try {
    const data = await readJSONBody(req);
    const code = String(data.id || data.code || "").trim().toUpperCase();
    const name = String(data.name || "").trim();

    if (!code) return fail(req, res, 400, "ID sprinter wajib diisi");
    if (!name) return fail(req, res, 400, "Nama sprinter wajib diisi");

    // Validasi ringan (aman untuk DB & konsisten)
    if (code.length < 3 || code.length > 40) {
      return fail(req, res, 400, "ID sprinter minimal 3 karakter (maks 40)");
    }
    if (!/^[A-Z0-9_-]+$/.test(code)) {
      return fail(req, res, 400, "ID sprinter hanya boleh huruf/angka, '_' atau '-'");
    }

    const exist = await dbFindSprinterByCode(code);
    if (exist) return fail(req, res, 409, "ID sprinter sudah ada");

    await dbUpsertSprinter(code, name);
    return ok(req, res, { message: "Sprinter created", id: code, name });
  } catch (e) {
    console.error("sprinter create error:", e);
    return fail(req, res, 500, "Gagal tambah sprinter");
  }
}


// ---------- Admin report summary ----------
async function handleAdminReportSummary(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");

  const [[row]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM sprinters) AS total_sprinter,
      (SELECT COUNT(*) FROM sprinters WHERE active=1) AS active_sprinter,
      (SELECT COUNT(*) FROM awbs) AS total_awb,
      (SELECT COUNT(*) FROM awbs WHERE status IN ('pending','assigned','pod_uploaded')) AS pending_awb,
      (SELECT COUNT(*) FROM awbs WHERE status='done') AS delivered_awb,
      (SELECT COUNT(*) FROM pods) AS total_uploads,
      (SELECT COUNT(*) FROM pods WHERE ${CAP.pods_has_created_at ? "DATE(created_at)=CURDATE()" : "1=0"}) AS today_uploads
  `);

  return ok(req, res, row);
}

// ---------- Admin list AWBs ----------
// ---------- Admin list AWBs ----------
async function handleAdminListAwbs(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");

  const [rows] = await pool.query(`
    SELECT
      a.id AS awb_id,
      a.waybill AS awb,
      COALESCE(s.code,'') AS sprinter_id,
      COALESCE(s.name,'') AS sprinter_name,
      a.arrival_date,
      a.last_delivery_at,
      a.status,
      a.receiver_phone,
      a.created_at,
      CASE WHEN p.awb_id IS NULL THEN 0 ELSE 1 END AS has_pod
    FROM awbs a
    LEFT JOIN sprinters s ON s.id = a.sprinter_id
    LEFT JOIN pods p ON p.awb_id = a.id
    ORDER BY a.updated_at DESC
    LIMIT 2000
  `);

  return ok(req, res, { awb_list: rows, total: rows.length });
}

// ---------- Admin delete single AWB ----------
async function handleAdminDeleteAwb(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");

  try {
    const data = await readJSONBody(req);
    const awb = String(data.awb || "").trim().toUpperCase();
    if (!awb) return fail(req, res, 400, "awb wajib");

    const [[row]] = await pool.execute(`SELECT id FROM awbs WHERE waybill=? LIMIT 1`, [awb]);
    if (!row) return fail(req, res, 404, "AWB tidak ditemukan");

    await pool.execute(`DELETE FROM pods WHERE awb_id=?`, [row.id]);
    await pool.execute(`DELETE FROM awbs WHERE id=?`, [row.id]);

    return ok(req, res, { message: "AWB deleted" });
  } catch (e) {
    console.error("delete awb error:", e);
    return fail(req, res, 500, "Gagal hapus AWB");
  }
}

// ---------- Admin bulk delete AWB by xlsx ----------
async function handleAdminBulkDeleteAwbXlsx(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (!Busboy) return fail(req, res, 500, "busboy not installed (npm i busboy)");
  if (!XLSX) return fail(req, res, 500, "xlsx not installed (npm i xlsx)");
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");

  const busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });

  let fileBuf = null;
  let fileSeen = false;

  busboy.on("file", (fieldName, file) => {
    if (fieldName !== "file") { file.resume(); return; }
    fileSeen = true;
    const chunks = [];
    file.on("data", (d) => chunks.push(d));
    file.on("end", () => { fileBuf = Buffer.concat(chunks); });
    file.on("error", () => file.resume());
  });

  busboy.on("finish", async () => {
    try {
      if (!fileSeen || !fileBuf) return fail(req, res, 400, "File Excel diperlukan (field name: file)");

      const wb = XLSX.read(fileBuf, { type: "buffer", cellDates: true });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) return fail(req, res, 400, "Sheet tidak ditemukan");

      const ws = wb.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" });

      const awbs = json
        .map((r) => String(r.awb || r.AWB || r.waybill || r.WAYBILL || r["No. Waybill"] || r["NO. WAYBILL"] || "").trim().toUpperCase())
        .filter(Boolean);

      if (!awbs.length) return fail(req, res, 400, "Kolom awb tidak ditemukan / kosong");

      let deleted = 0;
      let not_found = 0;

      for (const awb of awbs) {
        const [[row]] = await pool.execute(`SELECT id FROM awbs WHERE waybill=? LIMIT 1`, [awb]);
        if (!row) { not_found++; continue; }

        await pool.execute(`DELETE FROM pods WHERE awb_id=?`, [row.id]);
        await pool.execute(`DELETE FROM awbs WHERE id=?`, [row.id]);
        deleted++;
      }

      return ok(req, res, { deleted, not_found });
    } catch (e) {
      console.error("bulk delete xlsx error:", e);
      return fail(req, res, 500, "Gagal hapus massal");
    }
  });

  req.pipe(busboy);
}

// ---------- Admin download delete template xlsx ----------
async function handleAdminDeleteTemplate(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!XLSX) return fail(req, res, 500, "xlsx not installed (npm i xlsx)");
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");

  const ws = XLSX.utils.json_to_sheet([{ awb: "" }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "TEMPLATE");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  setCORS(req, res);
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="TEMPLATE_HAPUS_AWB.xlsx"`,
    "Cache-Control": "no-cache",
  });
  res.end(buf);
}

// ---------- Admin upload AWB XLSX ----------
async function handleAdminUploadAwbXlsx(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (!Busboy) return fail(req, res, 500, "busboy not installed (npm i busboy)");
  if (!XLSX) return fail(req, res, 500, "xlsx not installed (npm i xlsx)");
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");

  const busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });

  let fileBuf = null;
  let fileSeen = false;

  busboy.on("file", (fieldName, file) => {
    if (fieldName !== "file") { file.resume(); return; }
    fileSeen = true;
    const chunks = [];
    file.on("data", (d) => chunks.push(d));
    file.on("end", () => { fileBuf = Buffer.concat(chunks); });
    file.on("error", () => file.resume());
  });

  busboy.on("finish", async () => {
    try {
      if (!fileSeen || !fileBuf) return fail(req, res, 400, "File Excel diperlukan (field name: file)");

      const wb = XLSX.read(fileBuf, { type: "buffer", cellDates: true });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) return fail(req, res, 400, "Sheet tidak ditemukan");

      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
      if (!rows.length) return fail(req, res, 400, "File kosong");

      const header = rows[0].map(normHeader);

      const idxWaybill = header.indexOf(normHeader("No. Waybill"));
      const idxArrive  = header.indexOf(normHeader("Waktu Scan Sampai"));
      const idxSprName  = header.indexOf(normHeader("Sprinter Delivery"));
      const idxSprCode  = header.indexOf(normHeader("Kode Sprinter Delivery"));
      const idxDeliv    = header.indexOf(normHeader("Waktu Scan Delivery"));

      if (idxWaybill < 0) return fail(req, res, 400, "Kolom 'No. Waybill' tidak ditemukan");

      await pool.query("START TRANSACTION");

      let inserted = 0;
      let skipped = 0;

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const waybill = String(r[idxWaybill] || "").trim().toUpperCase();
        if (!waybill) continue;

        const sprCode = idxSprCode >= 0 ? String(r[idxSprCode] || "").trim().toUpperCase() : "";
        const sprName = idxSprName >= 0 ? String(r[idxSprName] || "").trim() : "";

        const arriveDT = idxArrive >= 0 ? parseDateTimeLoose(r[idxArrive]) : null;
        const delivDT  = idxDeliv >= 0 ? parseDateTimeLoose(r[idxDeliv]) : null;

        const arrival_date = arriveDT ? toMysqlDate(arriveDT) : null;
        const last_delivery_at = delivDT ? toMysqlDateTime(delivDT) : null;

        let status = "pending";
        if (last_delivery_at) status = "done";
        else if (sprCode) status = "assigned";

        let sprinter_id = null;
        if (sprCode) sprinter_id = await dbUpsertSprinter(sprCode, sprName);

        const [result] = await pool.execute(
          `INSERT IGNORE INTO awbs (waybill, sprinter_id, arrival_date, last_delivery_at, status)
           VALUES (?,?,?,?,?)`,
          [waybill, sprinter_id, arrival_date, last_delivery_at, status]
        );

        if (result.affectedRows === 1) inserted++;
        else skipped++;
      }

      await pool.query("COMMIT");

      return ok(req, res, {
        message: "Upload Excel berhasil",
        sheet: sheetName,
        inserted,
        skipped,
        total_rows: rows.length - 1,
      });
    } catch (e) {
      try { await pool.query("ROLLBACK"); } catch {}
      console.error("upload-xlsx error:", e);
      return fail(req, res, 500, "Gagal proses Excel");
    }
  });

  req.pipe(busboy);
}

// ---------- Admin uploads list (POD tab) ----------
function mapUiStatusFromAwbStatus(awbStatus) {
  const s = String(awbStatus || "").toLowerCase();
  // Mapping untuk UI validasi POD: pending/accepted/rejected
  if (s === "cancelled") return "rejected";
  if (s === "done") return "accepted";
  if (s === "pod_uploaded") return "pending"; // menunggu validasi admin
  return "pending";
}

async function handleAdminUploads(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");

  try {
    // Build SELECT dynamically sesuai kolom yang ada (CAP)
    const selectPhysical = CAP.pods_has_physical
      ? "p.physical_file_path"
      : "'' AS physical_file_path";

    const selectPodStatus = CAP.pods_has_status
      ? "p.status AS pod_status"
      : "'' AS pod_status";

    const selectCreatedAt = CAP.pods_has_created_at
      ? "p.created_at"
      : "NULL AS created_at";

    const orderBy = CAP.pods_has_created_at ? "p.created_at" : "p.id";

    const sql = `
      SELECT
        p.id,
        p.awb_id,
        p.merged_file_path,
        ${selectPhysical},
        ${selectPodStatus},
        ${selectCreatedAt},
        a.waybill,
        a.arrival_date,
        a.receiver_phone,
        a.status AS awb_status,
        COALESCE(s.code,'') AS sprinter_code,
        COALESCE(s.name,'') AS sprinter_name
      FROM pods p
      JOIN awbs a ON a.id = p.awb_id
      LEFT JOIN sprinters s ON s.id = a.sprinter_id
      ORDER BY ${orderBy} DESC
      LIMIT 5000
    `;

    const [rows] = await pool.query(sql);

    const uploads = (rows || []).map((r) => {
      const rawPodStatus = String(r.pod_status || "").toLowerCase();
      const safePodStatus =
        rawPodStatus === "pending" || rawPodStatus === "accepted" || rawPodStatus === "rejected"
          ? rawPodStatus
          : null;

      return {
        id: r.id,
        awb_id: r.awb_id,
        waybill: r.waybill,
        sprinter_code: r.sprinter_code || "",
        sprinter_name: r.sprinter_name || "",
        arrival_date: r.arrival_date,
        receiver_phone: r.receiver_phone || "",
        created_at: r.created_at,
        merged_file_path: r.merged_file_path,
        physical_file_path: r.physical_file_path || "",
        status: safePodStatus || mapUiStatusFromAwbStatus(r.awb_status),
      };
    });

    return ok(req, res, { uploads });
  } catch (e) {
    console.error("handleAdminUploads error:", e);
    return fail(req, res, 500, e?.message || "Gagal load uploads");
  }
}


// ---------- Admin validate POD (accept/reject) ----------
async function handleAdminPodsValidate(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "POST") return fail(req, res, 405, "Method not allowed");

  // /api/admin/pods/validate?id=123&action=accept|reject
  const u = new URL(req.url, `http://${req.headers.host}`);
  const id = Number(u.searchParams.get("id") || 0);
  const action = String(u.searchParams.get("action") || "").toLowerCase();

  if (!id) return fail(req, res, 400, "ID tidak valid");
  if (action !== "accept" && action !== "reject") return fail(req, res, 400, "Action invalid");

  try {
    const newAwbStatus = action === "accept" ? "done" : "cancelled";
    const newPodStatus = action === "accept" ? "accepted" : "rejected";

    // cari pods -> awb_id
    const [podRows] = await pool.execute(`SELECT id, awb_id FROM pods WHERE id = ? LIMIT 1`, [id]);
    if (!podRows.length) return fail(req, res, 404, "POD tidak ditemukan");

    const awbId = podRows[0].awb_id;

    // update awbs
    await pool.execute(
      `UPDATE awbs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newAwbStatus, awbId]
    );

    // update pods.status (kalau kolom ada)
    if (CAP.pods_has_status) {
      await pool.execute(`UPDATE pods SET status = ? WHERE id = ?`, [newPodStatus, id]);
    }

    return ok(req, res, { id, awb_id: awbId, status: newPodStatus, awb_status: newAwbStatus });
  } catch (e) {
    console.error("handleAdminPodsValidate error:", e);
    return fail(req, res, 500, e?.message || "Gagal validasi POD");
  }
}


// ---------- Admin download ZIP POD images ----------
async function handleAdminPodsDownloadZip(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");
  if (!Archiver) return fail(req, res, 500, "archiver not installed (npm i archiver)");

  try {
    const [rows] = await pool.query(`
      SELECT a.waybill AS awb, p.merged_file_path
      FROM pods p
      INNER JOIN awbs a ON a.id = p.awb_id
      ORDER BY p.id DESC
      LIMIT 5000
    `);

    setCORS(req, res);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="POD_IMAGES_${new Date().toISOString().slice(0,10)}.zip"`,
      "Cache-Control": "no-cache",
    });

    const archive = Archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("zip error:", err);
      try { res.end(); } catch {}
    });

    archive.pipe(res);

    for (const r of rows || []) {
      const rel = String(r.merged_file_path || "").trim();
      if (!rel) continue;
      const abs = path.join(__dirname, rel);
      if (!fs.existsSync(abs)) continue;

      const name = `${String(r.awb || "UNKNOWN").trim().toUpperCase()}.jpg`;
      archive.file(abs, { name });
    }

    await archive.finalize();
  } catch (e) {
    console.error("download zip error:", e);
    return fail(req, res, 500, "Gagal membuat ZIP");
  }
}

// ---------- Admin download Excel POD list ----------
async function handleAdminPodsDownloadExcel(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (!mysqlReady || !pool) return fail(req, res, 400, "MySQL belum aktif");
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");
  if (!XLSX) return fail(req, res, 500, "xlsx not installed (npm i xlsx)");

  try {
    // ✅ HANYA yang SUDAH ADA POD: sumber utama = pods (INNER JOIN)
    const [rows] = await pool.query(`
      SELECT
        a.waybill AS awb,
        a.arrival_date,
        COALESCE(s.code,'') AS sprinter_id,
        COALESCE(s.name,'') AS sprinter_name,
        1 AS ada_pod,
        a.status AS awb_status,
        p.id AS pod_id
        ${CAP.pods_has_created_at ? ", p.created_at AS pod_created_at" : ""}
        ${CAP.pods_has_status ? ", p.status AS pod_status" : ""}
      FROM pods p
      INNER JOIN awbs a ON a.id = p.awb_id
      LEFT JOIN sprinters s ON s.id = a.sprinter_id
      ORDER BY ${CAP.pods_has_created_at ? "p.created_at" : "p.id"} DESC
      LIMIT 5000
    `);

    const data = (rows || []).map((r) => {
      // Tentukan validasi: pakai pods.status kalau ada, fallback mapping dari awb_status
      const validasi =
        CAP.pods_has_status && r.pod_status
          ? String(r.pod_status).toUpperCase()
          : mapUiStatusFromAwbStatus(r.awb_status).toUpperCase();

      return {
        awb: r.awb,
        sprinter_id: r.sprinter_id,
        sprinter_name: r.sprinter_name,
        tanggal_sampai: r.arrival_date,
        ada_pod: "YA",
        validasi,
        pod_id: r.pod_id,
        ...(CAP.pods_has_created_at ? { pod_timestamp: r.pod_created_at } : {}),
      };
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "POD_ONLY");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    setCORS(req, res);
    res.writeHead(200, {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="POD_LIST_ONLY_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx"`,
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  } catch (e) {
    console.error("download excel error:", e);
    return fail(req, res, 500, "Gagal membuat Excel");
  }
}

async function handleAdminActivity(req, res) {
  if (!requireAdminPin(req, res)) return;
  if (req.method !== "GET") return fail(req, res, 405, "Method not allowed");
  return ok(req, res, { activity: [], total: 0 });
}

async function handleStatus(req, res) {
  return ok(req, res, {
    server: "JT POD FINAL (MYSQL ALIGNED + EXTRA FEATURES)",
    mysql: mysqlReady ? "ready" : "not-ready",
    mysql_config: mysqlConfig(),
    time: nowISO(),
    caps: CAP,
    endpoints: {
      admin: "/admin",
      sprinter: "/sprinter",
      admin_login: "POST /api/admin/login",
      admin_report: "GET /api/admin/report/summary (X-Admin-Pin)",
      admin_awbs: "GET /api/admin/awbs (X-Admin-Pin)",
      admin_upload_xlsx: "POST /api/admin/awb/upload-xlsx (X-Admin-Pin, form-data file)",
      admin_upload_xlsx_alias: "POST /api/admin/awbs/upload-xlsx (X-Admin-Pin, form-data file)",
      sprinter_login: "POST /api/login",
      sprinter_upload_pod: "POST /api/upload (multipart)",
      sprinter_awb_list: "GET /api/awb/list",
      sprinter_uploads: "GET /api/uploads",
      sprinter_save_phone: "POST /api/awb/phone (X-User-ID, X-Session-ID, JSON {awb, phone})",
      admin_uploads: "GET /api/admin/uploads (X-Admin-Pin)",
      admin_pods_validate: "POST /api/admin/pods/validate (X-Admin-Pin)",
      admin_pods_zip: "GET /api/admin/pods/download-zip (X-Admin-Pin)",
      admin_pods_excel: "GET /api/admin/pods/download-excel (X-Admin-Pin)",
      admin_awb_delete: "POST /api/admin/awbs/delete (X-Admin-Pin)",
      admin_awb_bulk_delete: "POST /api/admin/awbs/bulk-delete-xlsx (X-Admin-Pin)",
      admin_awb_delete_template: "GET /api/admin/awbs/delete-template (X-Admin-Pin)",
      admin_sprinter_update: "POST /api/admin/sprinters/update (X-Admin-Pin)",
      admin_sprinter_delete: "POST /api/admin/sprinters/delete (X-Admin-Pin)",

      // ================== [ADDED] Tools endpoints ==================
      admin_tools_page: "GET /admin-tools",
      admin_tools_proofgen_start: "POST /api/admin/tools/proofgen/start (X-Admin-Pin, multipart: excel+timemark)",
      admin_tools_proofgen_status: "GET /api/admin/tools/proofgen/status?jobId=... (X-Admin-Pin)",
      admin_tools_proofgen_download: "GET /api/admin/tools/proofgen/download?jobId=... (X-Admin-Pin)",
      // =============================================================
    },
  });
}

// ------------------ Router ------------------

async function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  if (req.method === "OPTIONS") {
    setCORS(req, res);
    res.writeHead(200);
    res.end();
    return;
  }

  // avoid noisy 404
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  // static routes
  if (pathname === "/" || pathname === "/sprinter") return serveFile(req, res, path.join(__dirname, "sprinter.html"));
  if (pathname === "/admin") return serveFile(req, res, path.join(__dirname, "admin.html"));

  // ================== [ADDED] admin tools page (Opsi A) ==================
  if (pathname === "/admin-tools") return serveFile(req, res, path.join(__dirname, "admin_tools.html"));
  // ======================================================================

  if (pathname.startsWith("/assets/")) {
    return serveFile(req, res, safeJoinFromUrl(__dirname, pathname));
  }

  if (pathname.startsWith("/uploads/")) {
    return serveFile(req, res, safeJoinFromUrl(__dirname, pathname));
  }

  // ================== [ADDED] proofgen routes (admin-only tools) ==================
  // NOTE: tidak mengganggu route lama karena module hanya handle path baru.
  if (proofgenRoutes) {
    const handled = await proofgenRoutes.handle(req, res, { isAdmin: isAdminRequest });
    if (handled) return;
  }
  // ===============================================================================
  
  // API routes
  try {
    if (pathname === "/api/admin/login") return await handleAdminLogin(req, res);
    if (pathname === "/api/login") return await handleSprinterLogin(req, res);
    if (pathname === "/api/logout") return await handleLogout(req, res);
    if (pathname === "/api/session/check") return await handleSessionCheck(req, res);

    if (pathname === "/api/upload") return await handleSprinterUpload(req, res);
    if (pathname === "/api/awb/list") return await handleSprinterAwbList(req, res);
	if (pathname === "/api/awb/phone") return await handleSprinterAwbSavePhone(req, res);
    if (pathname === "/api/uploads") return await handleSprinterUploads(req, res);

    if (pathname === "/api/admin/sprinters") return await handleAdminSprinters(req, res);

    // ✅ NEW: create sprinter
    if (pathname === "/api/admin/sprinters/create") return await handleAdminSprinterCreate(req, res);

    if (pathname === "/api/admin/sprinters/update") return await handleAdminSprinterUpdate(req, res);
    if (pathname === "/api/admin/sprinters/delete") return await handleAdminSprinterDelete(req, res);

    if (pathname === "/api/admin/activity") return await handleAdminActivity(req, res);
    if (pathname === "/api/admin/report/summary") return await handleAdminReportSummary(req, res);

    if (pathname === "/api/admin/awbs") return await handleAdminListAwbs(req, res);
    if (pathname === "/api/admin/awbs/delete") return await handleAdminDeleteAwb(req, res);
    if (pathname === "/api/admin/awbs/bulk-delete-xlsx") return await handleAdminBulkDeleteAwbXlsx(req, res);
    if (pathname === "/api/admin/awbs/delete-template") return await handleAdminDeleteTemplate(req, res);

    // upload xlsx (original + alias)
    if (pathname === "/api/admin/awb/upload-xlsx") return await handleAdminUploadAwbXlsx(req, res);
    if (pathname === "/api/admin/awbs/upload-xlsx") return await handleAdminUploadAwbXlsx(req, res);

    if (pathname === "/api/admin/uploads") return await handleAdminUploads(req, res);
    if (pathname === "/api/admin/pods/validate") return await handleAdminPodsValidate(req, res);
    if (pathname === "/api/admin/pods/download-zip") return await handleAdminPodsDownloadZip(req, res);
    if (pathname === "/api/admin/pods/download-excel") return await handleAdminPodsDownloadExcel(req, res);

    if (pathname === "/api/status") return await handleStatus(req, res);

    return fail(req, res, 404, "Not found");
  } catch (e) {
    console.error("handler error:", e);
    return fail(req, res, 500, "Internal server error");
  }
}


// ------------------ Startup ------------------

async function initFiles() {
  await ensureDir(DB_FOLDER);
  await ensureJsonFile(DB_FILES.SESSIONS, []);
  await ensureJsonFile(DB_FILES.USERS, [
    { id: "LS0000009547", name: "SPRINTER SAMPLE", status: "active", created_at: nowISO() },
  ]);
}

(async () => {
  await initFiles();
  await initMySQL();

  // ================== [ADDED] periodic cleanup for tools jobs ==================
  if (proofgenRoutes && typeof proofgenRoutes.tickCleanup === "function") {
    setInterval(() => {
      proofgenRoutes.tickCleanup().catch(() => {});
    }, 10 * 60 * 1000); // 10 menit
  }
  // ===========================================================================

  const server = http.createServer(handler);
  server.listen(PORT, "0.0.0.0", () => {
    console.log("=======================================");
    console.log("JT POD FINAL (MYSQL ALIGNED + EXTRA)");
    console.log("Port:", PORT);
    console.log("Admin:", `http://localhost:${PORT}/admin`);
    console.log("Sprinter:", `http://localhost:${PORT}/sprinter`);
    console.log("Status:", `http://localhost:${PORT}/api/status`);
    console.log("MySQL:", mysqlReady ? "READY" : "NOT READY");
    console.log("=======================================");

    // ================== [ADDED] show tools page if module exists ==================
    if (proofgenRoutes) {
      console.log("Admin Tools:", `http://localhost:${PORT}/admin-tools`);
    }
    // =============================================================================
  });
})();

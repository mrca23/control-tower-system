// tools/proofgen/proofgen.service.js
// Generator "bukti" (SMS + Contact + Timemark) -> JPG per RESI, lalu zip.
// Output sekali pakai: setelah download sukses -> dibersihkan.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const XLSX = require('xlsx');
const sharp = require('sharp');
const archiver = require('archiver');
const puppeteer = require('puppeteer');

function safeFileName(name) {
  // allow basic chars only, replace others
  return String(name || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function normalizePhoneTo08(v) {
  let s = String(v || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  s = s.replace(/[^\d+]/g, '');
  if (!s) return '';
  // Convert leading 0 -> 62
  if (s[0] === '0') s = '62' + s.slice(1);
  // Remove + if present
  if (s.startsWith('+')) s = s.slice(1);
  // Basic Indonesia mobile prefixes check (same spirit as desktop)
  if (!/^62(8[1-9]\d{7,11})$/.test(s)) return '';
  return '0' + s.slice(2);
}

const MONTH_MAP_ID = {
  jan: '01', januari: '01',
  feb: '02', februari: '02',
  mar: '03', maret: '03',
  apr: '04', april: '04',
  mei: '05',
  jun: '06', juni: '06',
  jul: '07', juli: '07',
  agu: '08', agustus: '08',
  sep: '09', september: '09',
  okt: '10', oktober: '10',
  nov: '11', november: '11',
  des: '12', desember: '12'
};

function normalizeDateToDDMMYYYY(val) {
  if (val === null || val === undefined) return '';
  // Excel date number
  if (typeof val === 'number' && isFinite(val)) {
    const dt = XLSX.SSF.parse_date_code(val);
    if (dt && dt.y && dt.m && dt.d) {
      return `${pad2(dt.d)}/${pad2(dt.m)}/${dt.y}`;
    }
  }
  let s = String(val).trim();
  if (!s) return '';

  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = m[1], mm = pad2(m[2]), dd = pad2(m[3]);
    return `${dd}/${mm}/${y}`;
  }

  // DD/MM/YYYY or DD/MM/YY
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) {
    let dd = pad2(m[1]);
    let mm = pad2(m[2]);
    let y = m[3];
    if (y.length === 2) y = (Number(y) >= 70 ? '19' : '20') + y;
    return `${dd}/${mm}/${y}`;
  }

  // "12 Desember 2025" / "12 Des 2025"
  m = s.toLowerCase().match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (m) {
    const dd = pad2(m[1]);
    const monKey = m[2];
    const mm = MONTH_MAP_ID[monKey] || MONTH_MAP_ID[monKey.slice(0, 3)];
    const y = m[3];
    if (mm) return `${dd}/${mm}/${y}`;
  }

  return '';
}

function pickColumnKey(headers, candidates) {
  const h = headers.map(x => String(x || '').toLowerCase().trim());
  for (const c of candidates) {
    const idx = h.indexOf(c);
    if (idx >= 0) return headers[idx];
  }
  // contains fallback
  for (let i = 0; i < h.length; i++) {
    for (const c of candidates) {
      if (h[i].includes(c)) return headers[i];
    }
  }
  return null;
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function removeDirSafe(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch {}
}

async function readText(filePath) {
  return await fsp.readFile(filePath, 'utf8');
}

function applyTemplate(html, data) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = data[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function makeSignalBars(level) {
  // simple 0..4 bars html
  const bars = [];
  for (let i = 1; i <= 4; i++) {
    const on = i <= level;
    bars.push(`<div style="width:4px;height:${4 + i * 3}px;border-radius:2px;margin-left:2px;opacity:${on ? 1 : 0.25};background:#fff;"></div>`);
  }
  return `<div style="display:flex;align-items:flex-end;">${bars.join('')}</div>`;
}

function makeNotificationsHtml() {
  // keep minimal; templates already style it
  return '';
}

function randomNetwork() {
  const arr = ['4G', 'LTE', 'H+'];
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBattery() {
  const b = 65 + Math.floor(Math.random() * 30);
  return String(b);
}

function batteryColor(batt) {
  const n = Number(batt);
  if (!isFinite(n)) return '#ffffff';
  if (n <= 20) return '#ff4d4f';
  if (n <= 40) return '#faad14';
  return '#ffffff';
}

function buildSmsData({ phone08, ddmmyyyy, kota }) {
  const now = new Date();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  // generate 3 lines like the desktop version vibe (simple and safe)
  // kamu bisa ubah copywriting nanti, template placeholder tetap sama
  const date1 = ddmmyyyy || `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;
  const date2 = date1;
  const date3 = date1;

  const msg1 = `Paket retur Anda sudah diterima di ${kota || 'gudang'}.`;
  const msg2 = `Mohon tunggu proses berikutnya.`;
  const msg3 = `Terima kasih.`;

  const batt = randomBattery();
  const sig = 3 + Math.floor(Math.random() * 2);

  return {
    TIME: time,
    NETWORK: randomNetwork(),
    SIGNAL_HTML: makeSignalBars(sig),
    BATT: batt,
    BATT_COLOR: batteryColor(batt),
    NOTIFICATIONS: makeNotificationsHtml(),
    PHONE: phone08,
    DATE1: date1,
    DATE2: date2,
    DATE3: date3,
    MSG1: msg1,
    MSG2: msg2,
    MSG3: msg3
  };
}

function buildContactData({ phone08 }) {
  const now = new Date();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const batt = randomBattery();
  const sig = 3 + Math.floor(Math.random() * 2);
  return {
    TIME: time,
    NETWORK: randomNetwork(),
    SIGNAL_HTML: makeSignalBars(sig),
    BATT: batt,
    BATT_COLOR: batteryColor(batt),
    NOTIFICATIONS: makeNotificationsHtml(),
    PHONE: phone08
  };
}

async function renderHtmlToPng(browser, html, outPngPath, timeoutMs = 30000) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 720, height: 1280, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: timeoutMs });
    await page.waitForSelector('.phone', { timeout: timeoutMs });
    const el = await page.$('.phone');
    const buf = await el.screenshot({ type: 'png' });
    await fsp.writeFile(outPngPath, buf);
  } finally {
    await page.close().catch(() => {});
  }
}

async function renderWithRetry(browser, html, outPngPath) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      await renderHtmlToPng(browser, html, outPngPath, 30000);
      return;
    } catch (e) {
      lastErr = e;
      // short backoff
      await new Promise(r => setTimeout(r, 600 + i * 400));
    }
  }
  throw lastErr;
}

async function mergePanelsToJpg({ smsPng, contactPng, timemarkPath, outJpgPath }) {
  // Standardize heights to 920 like desktop; keep consistent output
  const targetH = 920;

  const [smsMeta, contactMeta, timeMeta] = await Promise.all([
    sharp(smsPng).metadata(),
    sharp(contactPng).metadata(),
    sharp(timemarkPath).metadata()
  ]);

  const smsBuf = await sharp(smsPng).resize({ height: targetH }).png().toBuffer();
  const contactBuf = await sharp(contactPng).resize({ height: targetH }).png().toBuffer();
  const timeBuf = await sharp(timemarkPath).resize({ height: targetH }).png().toBuffer();

  const smsW = Math.round((smsMeta.width || 720) * (targetH / (smsMeta.height || targetH)));
  const contactW = Math.round((contactMeta.width || 720) * (targetH / (contactMeta.height || targetH)));
  const timeW = Math.round((timeMeta.width || 720) * (targetH / (timeMeta.height || targetH)));

  const totalW = smsW + contactW + timeW;

  const base = sharp({
    create: {
      width: totalW,
      height: targetH,
      channels: 3,
      background: '#ffffff'
    }
  });

  let out = base.composite([
    { input: smsBuf, top: 0, left: 0 },
    { input: contactBuf, top: 0, left: smsW },
    { input: timeBuf, top: 0, left: smsW + contactW }
  ]);

  // compress to <= ~1.9MB (same spirit as desktop) by decreasing quality
  let q = 92;
  while (q >= 60) {
    const buf = await out.jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (buf.length <= 1900 * 1024) {
      await fsp.writeFile(outJpgPath, buf);
      return;
    }
    q -= 6;
  }
  // fallback final
  const buf = await out.jpeg({ quality: 60, mozjpeg: true }).toBuffer();
  await fsp.writeFile(outJpgPath, buf);
}

async function createZipFromDir(outZipPath, dirPath) {
  await ensureDir(path.dirname(outZipPath));

  return await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('warning', err => {
      if (err.code === 'ENOENT') return;
      reject(err);
    });
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(dirPath, false);
    archive.finalize();
  });
}

function createJobStore() {
  // in-memory job store (safe enough for single-server local use)
  const jobs = new Map();

  function get(jobId) {
    return jobs.get(jobId) || null;
  }

  function set(jobId, job) {
    jobs.set(jobId, job);
  }

  function del(jobId) {
    jobs.delete(jobId);
  }

  function list() {
    return Array.from(jobs.values());
  }

  return { get, set, del, list };
}

async function runJob(job, templates) {
  // job: { jobId, baseDir, inputExcelPath, timemarkPath, createdAt, ... }
  const { baseDir, inputExcelPath, timemarkPath } = job;
  const workDir = path.join(baseDir, 'work');
  const outDir = path.join(baseDir, 'output');
  const bundleDir = path.join(baseDir, 'bundle');
  const zipPath = path.join(bundleDir, `proofgen_${job.jobId}.zip`);

  await ensureDir(workDir);
  await ensureDir(outDir);
  await ensureDir(bundleDir);

  const workbook = XLSX.readFile(inputExcelPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) {
    throw new Error('Excel kosong (tidak ada data).');
  }

  const headers = Object.keys(rows[0] || {});
  const colResi = pickColumnKey(headers, ['resi', 'waybill', 'awb', 'no_resi', 'noresi', 'no waybill', 'no_awb']);
  const colHp = pickColumnKey(headers, ['hp', 'no_hp', 'nohp', 'telp', 'telepon', 'phone', 'nomor_hp', 'nomorhp']);
  const colTgl = pickColumnKey(headers, ['tgl', 'tanggal', 'tanggal_sampai', 'tgl_sampai', 'date', 'tanggal sampai']);
  const colKota = pickColumnKey(headers, ['kota', 'city', 'alamat_kota']);

  const errors = [];
  if (!colResi) errors.push('Kolom RESI/AWB tidak ditemukan.');
  if (!colHp) errors.push('Kolom HP tidak ditemukan.');
  if (!colTgl) errors.push('Kolom TANGGAL tidak ditemukan.');
  if (errors.length) {
    const err = new Error(errors.join(' '));
    err.code = 'BAD_EXCEL';
    throw err;
  }

  // Build data list
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rawResi = String(r[colResi] || '').trim();
    const rawHp = r[colHp];
    const rawTgl = r[colTgl];
    const kota = colKota ? String(r[colKota] || '').trim() : '';

    if (!rawResi) {
      errors.push(`Baris ${i + 2}: RESI kosong`);
      continue;
    }
    const phone08 = normalizePhoneTo08(rawHp);
    if (!phone08) {
      errors.push(`Baris ${i + 2}: HP tidak valid (${String(rawHp || '')})`);
      continue;
    }
    const ddmmyyyy = normalizeDateToDDMMYYYY(rawTgl);
    if (!ddmmyyyy) {
      errors.push(`Baris ${i + 2}: Tanggal tidak valid (${String(rawTgl || '')})`);
      continue;
    }

    items.push({
      idx: i + 1,
      resi: rawResi,
      phone08,
      ddmmyyyy,
      kota
    });
  }

  if (!items.length) {
    const err = new Error('Tidak ada baris valid untuk diproses.');
    err.code = 'NO_VALID_ROWS';
    err.details = errors.slice(0, 200);
    throw err;
  }

  // If there are errors, we still proceed for valid rows, but we keep error list for status
  job.errors = errors.slice(0, 500);
  job.total = items.length;
  job.done = 0;
  job.failed = 0;
  job.state = 'running';
  job.zipPath = zipPath;

  // Launch browser once per job
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    // Warm-up render (stabilize fonts/layout)
    const warmSms = applyTemplate(templates.sms, buildSmsData({ phone08: '081234567890', ddmmyyyy: '01/01/2026', kota: 'Jakarta' }));
    const warmCon = applyTemplate(templates.contact, buildContactData({ phone08: '081234567890' }));
    await renderWithRetry(browser, warmSms, path.join(workDir, '__warm_sms.png'));
    await renderWithRetry(browser, warmCon, path.join(workDir, '__warm_contact.png'));
    // Remove warm files
    await fsp.rm(path.join(workDir, '__warm_sms.png')).catch(() => {});
    await fsp.rm(path.join(workDir, '__warm_contact.png')).catch(() => {});

    // Sequential (paling aman untuk laptop kantor). Bisa dinaikkan concurrency nanti.
    for (const it of items) {
      if (job.cancelled) break;

      const resiSafe = safeFileName(it.resi);
      const smsPng = path.join(workDir, `sms_${resiSafe}.png`);
      const contactPng = path.join(workDir, `contact_${resiSafe}.png`);
      const outJpg = path.join(outDir, `${resiSafe}.jpg`);

      try {
        const smsHtml = applyTemplate(templates.sms, buildSmsData({ phone08: it.phone08, ddmmyyyy: it.ddmmyyyy, kota: it.kota }));
        const conHtml = applyTemplate(templates.contact, buildContactData({ phone08: it.phone08 }));

        await renderWithRetry(browser, smsHtml, smsPng);
        await renderWithRetry(browser, conHtml, contactPng);

        await mergePanelsToJpg({
          smsPng,
          contactPng,
          timemarkPath,
          outJpgPath: outJpg
        });

        job.done++;
      } catch (e) {
        job.failed++;
        job.errors = job.errors || [];
        job.errors.push(`RESI ${it.resi}: ${e && e.message ? e.message : String(e)}`);
      } finally {
        // Cleanup intermediate for each item
        await fsp.rm(smsPng).catch(() => {});
        await fsp.rm(contactPng).catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Always zip what we have (even if some fail)
  await createZipFromDir(zipPath, path.join(baseDir, 'output'));

  job.state = 'ready';
  job.readyAt = Date.now();
  job.zipSize = (await fsp.stat(zipPath)).size;
}

async function loadTemplates(templateDir) {
  const smsPath = path.join(templateDir, 'sms_template.html');
  const contactPath = path.join(templateDir, 'contact_template.html');
  const [sms, contact] = await Promise.all([readText(smsPath), readText(contactPath)]);
  return { sms, contact };
}

async function cleanupJobDirs(baseDir) {
  await removeDirSafe(baseDir);
}

function createProofgenService(options = {}) {
  const baseTmpDir = options.baseTmpDir || path.join(process.cwd(), 'tmp', 'tools');
  const templateDir = options.templateDir || path.join(process.cwd(), 'tools', 'proofgen', 'templates');

  const store = createJobStore();
  let templatesPromise = null;

  async function getTemplates() {
    if (!templatesPromise) templatesPromise = loadTemplates(templateDir);
    return templatesPromise;
  }

  async function createJob({ inputExcelPath, timemarkPath }) {
    const jobId = `T${nowStamp()}_${randomId(6)}`;
    const baseDir = path.join(baseTmpDir, jobId);

    await ensureDir(baseDir);

    const job = {
      jobId,
      baseDir,
      inputExcelPath,
      timemarkPath,
      state: 'queued',
      total: 0,
      done: 0,
      failed: 0,
      errors: [],
      createdAt: Date.now()
    };

    store.set(jobId, job);

    // Fire-and-forget within server process (asynchronous job).
    // (Bukan background async “di luar”, tetap di process yang sama.)
    (async () => {
      try {
        const templates = await getTemplates();
        job.state = 'starting';
        await runJob(job, templates);
      } catch (e) {
        job.state = 'error';
        job.errorMessage = e && e.message ? e.message : String(e);
        if (e && e.details) job.errors = e.details;
      }
    })();

    return job;
  }

  function getJob(jobId) {
    return store.get(jobId);
  }

  async function cleanup(jobId) {
    const job = store.get(jobId);
    if (!job) return;
    job.state = 'cleaning';
    await cleanupJobDirs(job.baseDir);
    store.del(jobId);
  }

  async function cleanupExpired(ttlMs = 2 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const job of store.list()) {
      const age = now - (job.createdAt || now);
      const tooOld = age > ttlMs;
      const doneAndOld = (job.state === 'ready' || job.state === 'error') && age > ttlMs;
      if (tooOld || doneAndOld) {
        await cleanup(job.jobId);
      }
    }
  }

  return {
    baseTmpDir,
    templateDir,
    createJob,
    getJob,
    cleanup,
    cleanupExpired
  };
}

module.exports = {
  createProofgenService
};

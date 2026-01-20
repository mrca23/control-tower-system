// assets/js/admin_tools.js
(() => {
  const elExcel = document.getElementById('fileExcel');
  const elTime = document.getElementById('fileTimemark');
  const btnGen = document.getElementById('btnGenerate');
  const btnDl = document.getElementById('btnDownload');
  const btnBack = document.getElementById('btnBack');
  const statusText = document.getElementById('statusText');
  const barFill = document.getElementById('barFill');
  const logBox = document.getElementById('logBox');

  let jobId = null;
  let pollTimer = null;

  function getAdminPin() {
    // mengikuti pola yang umum dipakai di admin.js kamu (biasanya localStorage)
    return localStorage.getItem('adminPin') || localStorage.getItem('ADMIN_PIN') || '';
  }

  function setStatus(text) {
    statusText.textContent = `Status: ${text}`;
  }

  function setProgress(done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    barFill.style.width = `${pct}%`;
  }

  function setLog(lines) {
    if (!lines || !lines.length) {
      logBox.textContent = '-';
      return;
    }
    logBox.textContent = lines.join('\n');
  }

  async function apiFetch(url, opts = {}) {
    const pin = getAdminPin();
    const headers = Object.assign({}, opts.headers || {}, { 'X-Admin-Pin': pin });
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const msg = json.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  }

  async function startJob() {
    const excel = elExcel.files[0];
    const timemark = elTime.files[0];

    if (!excel) throw new Error('Excel wajib diupload.');
    if (!timemark) throw new Error('Timemark wajib diupload.');

    const pin = getAdminPin();
    if (!pin) throw new Error('Admin PIN tidak ditemukan di browser. Login admin dulu di /admin.');

    const fd = new FormData();
    fd.append('excel', excel);
    fd.append('timemark', timemark);

    setStatus('uploading...');
    setLog([]);

    const res = await apiFetch('/api/admin/tools/proofgen/start', {
      method: 'POST',
      body: fd
    });

    jobId = res.jobId;
    btnDl.disabled = true;
    setStatus(`job created: ${jobId}`);
    setProgress(0, 100);
    startPolling();
  }

  async function poll() {
    if (!jobId) return;
    const res = await apiFetch(`/api/admin/tools/proofgen/status?jobId=${encodeURIComponent(jobId)}`, {
      method: 'GET'
    });

    const job = res.job;
    const state = job.state || 'unknown';
    const total = job.total || 0;
    const done = (job.done || 0) + (job.failed || 0);

    setStatus(`${state} | total=${total} done=${job.done || 0} failed=${job.failed || 0}`);
    setProgress(done, total || 1);
    setLog(job.errors || []);

    if (state === 'ready') {
      btnDl.disabled = false;
      stopPolling();
    }
    if (state === 'error') {
      btnDl.disabled = true;
      stopPolling();
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => poll().catch(e => setStatus(`error polling: ${e.message}`)), 1200);
    poll().catch(e => setStatus(`error polling: ${e.message}`));
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function downloadZip() {
  if (!jobId) return;

  try {
    const pin = getAdminPin();
    if (!pin) throw new Error('Admin PIN tidak ditemukan. Login ulang di /admin.');

    const url = `/api/admin/tools/proofgen/download?jobId=${encodeURIComponent(jobId)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Admin-Pin': pin
      }
    });

    if (!res.ok) {
      let msg = `Download gagal (${res.status})`;
      try {
        const j = await res.json();
        if (j && j.message) msg = j.message;
      } catch {}
      throw new Error(msg);
    }

    const blob = await res.blob();

    // ambil nama file dari header (kalau ada)
    let filename = `proofgen_${jobId}.zip`;
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename="([^"]+)"/i);
    if (m && m[1]) filename = m[1];

    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);

    setStatus('download complete');
    btnDl.disabled = true;
  } catch (e) {
    setStatus(`download error: ${e.message}`);
    setLog([e.message]);
    btnDl.disabled = false;
  }
}


  btnGen.addEventListener('click', () => {
    btnGen.disabled = true;
    startJob()
      .catch(e => {
        setStatus(`error: ${e.message}`);
        setLog([e.message]);
      })
      .finally(() => {
        btnGen.disabled = false;
      });
  });

  btnDl.addEventListener('click', downloadZip);

  btnBack.addEventListener('click', () => {
    window.location.href = '/admin';
  });

  // initial
  setStatus('idle');
  setProgress(0, 100);
})();

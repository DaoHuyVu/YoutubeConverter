const API_BASE = window.location.origin.startsWith('file:')
    ? 'http://localhost:3000'
    : '';

const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const statusText = $('status-text');
const progressFill = $('progress-fill');
const progressPercent = $('progress-percent');
const progressExtra = $('progress-extra');
const resultEl = $('result');
const errorEl = $('error');
const downloadLink = $('download-link');
const convertUrlBtn = $('convert-url');
const convertFileBtn = $('convert-file');
const urlInput = $('url-input');
const fileInput = $('file-input');
const dropZone = $('drop-zone');
const selectedFileEl = $('selected-file');

let selectedFile = null;

const STAGE_LABELS = {
    starting: 'Đang khởi tạo...',
    uploading: 'Đang upload file...',
    downloading: 'Đang tải video...',
    converting: 'Đang convert sang MP3...',
};

document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        $(`panel-${tab.dataset.tab}`).classList.add('active');
        resetOutput();
    });
});

function resetOutput() {
    statusEl.hidden = true;
    resultEl.hidden = true;
    errorEl.hidden = true;
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    progressExtra.textContent = '';
}

function showStatus(text) {
    resetOutput();
    statusText.textContent = text;
    statusEl.hidden = false;
}

function showError(text) {
    resetOutput();
    errorEl.textContent = text;
    errorEl.hidden = false;
}

function showResult(url, filename) {
    resetOutput();
    downloadLink.href = `${API_BASE}${url}`;
    downloadLink.setAttribute('download', filename);
    downloadLink.textContent = `Tải ${filename}`;
    resultEl.hidden = false;
    window.desktopBridge?.showInFolder(url);
}

function setBusy(busy) {
    convertUrlBtn.disabled = busy;
    convertFileBtn.disabled = busy || !selectedFile;
}

function formatBytes(n) {
    if (!n) return '';
    if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
}

function updateProgress(event) {
    const stage = event.stage || '';
    statusText.textContent = STAGE_LABELS[stage] || `Đang xử lý (${stage})...`;
    const percent = typeof event.percent === 'number' ? Math.max(0, Math.min(100, event.percent)) : 0;
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent.toFixed(1)}%`;

    const extra = event.extra || {};
    const bits = [];
    if (extra.speed) bits.push(extra.speed.trim ? extra.speed.trim() : String(extra.speed));
    if (extra.eta) bits.push(`ETA ${extra.eta}`);
    if (extra.receivedBytes && extra.totalBytes) {
        bits.push(`${formatBytes(extra.receivedBytes)} / ${formatBytes(extra.totalBytes)}`);
    }
    if (extra.bitrate) bits.push(String(extra.bitrate));
    progressExtra.textContent = bits.join(' · ');
}

async function streamNdjson(response, onEvent) {
    if (!response.ok && response.headers.get('content-type')?.includes('json')) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                onEvent(JSON.parse(trimmed));
            } catch (err) {
                console.warn('Bad NDJSON line', trimmed, err);
            }
        }
    }
    if (buf.trim()) {
        try { onEvent(JSON.parse(buf)); } catch (err) { console.warn(err); }
    }
}

async function runConversion(fetchPromise) {
    showStatus('Đang khởi tạo...');
    try {
        const res = await fetchPromise;
        let final = null;
        let lastError = null;
        await streamNdjson(res, (event) => {
            if (event.type === 'progress') updateProgress(event);
            else if (event.type === 'done') final = event;
            else if (event.type === 'error') lastError = event.message;
        });
        if (lastError) throw new Error(lastError);
        if (!final) throw new Error('Không nhận được kết quả từ server');
        showResult(final.downloadUrl, final.filename);
    } catch (err) {
        showError(err.message || String(err));
    } finally {
        setBusy(false);
    }
}

convertUrlBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) {
        showError('Vui lòng nhập URL');
        return;
    }
    setBusy(true);
    runConversion(fetch(`${API_BASE}/api/convert/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
    }));
});

function pickFile(file) {
    if (!file) return;
    selectedFile = file;
    selectedFileEl.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
    convertFileBtn.disabled = false;
}

fileInput.addEventListener('change', (e) => pickFile(e.target.files[0]));

['dragenter', 'dragover'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
});
['dragleave', 'drop'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
    });
});
dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    pickFile(file);
});

convertFileBtn.addEventListener('click', () => {
    if (!selectedFile) return;
    setBusy(true);
    runConversion(fetch(`${API_BASE}/api/convert/file`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': encodeURIComponent(selectedFile.name),
        },
        body: selectedFile,
    }));
});

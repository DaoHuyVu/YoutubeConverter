/**
 * Debug panel: gom toàn bộ ngữ cảnh của một lần convert thất bại (request, HTTP
 * status, event NDJSON, stderr của yt-dlp/ffmpeg, log backend, tình trạng công
 * cụ) vào một chỗ để debug trực tiếp trong app, không cần mở terminal.
 */
(function () {
    'use strict';

    // window.location.origin là chuỗi "null" (không phải "file:...") khi trang
    // được mở bằng file://, nên phải check protocol chứ không check origin.
    const isFileProtocol = window.location.protocol === 'file:';
    const apiBase = isFileProtocol ? 'http://localhost:3000' : '';

    const section = document.getElementById('debug');
    const bodyEl = document.getElementById('debug-body');
    const copyBtn = document.getElementById('debug-copy');
    const refreshBtn = document.getElementById('debug-refresh');
    const bannerEl = document.getElementById('startup-warning');

    let context = {};
    let events = [];
    let lastReport = null;

    function reset() {
        context = {};
        events = [];
        lastReport = null;
        if (section) section.hidden = true;
        if (bodyEl) bodyEl.innerHTML = '';
    }

    function setContext(partial) {
        Object.assign(context, partial);
    }

    function addEvent(event) {
        events.push({ at: new Date().toISOString(), event });
    }

    function classify(err) {
        const message = String((err && err.message) || err || '');
        if (/failed to fetch|networkerror|network error|load failed|connection refused|err_connection/i.test(message)) {
            return 'network';
        }
        if (/aborted|abort/i.test(message)) return 'aborted';
        return 'app';
    }

    async function probeBackend() {
        const probe = { apiBase: apiBase || window.location.origin, reachable: false };
        try {
            const res = await fetch(`${apiBase}/api/health`, { cache: 'no-store' });
            probe.healthStatus = res.status;
            probe.reachable = res.ok;
        } catch (err) {
            probe.healthError = String((err && err.message) || err);
        }
        if (probe.reachable) {
            try {
                const res = await fetch(`${apiBase}/api/diagnostics`, { cache: 'no-store' });
                probe.diagnostics = await res.json();
            } catch (err) {
                probe.diagnosticsError = String((err && err.message) || err);
            }
        }
        return probe;
    }

    /** Giải thích "Failed to fetch" theo đúng trạng thái thật của backend. */
    function explainNetworkFailure(probe) {
        if (isFileProtocol) {
            return [
                'Trang đang mở bằng file:// nên không gọi được API. Mở http://localhost:3000 (backend tự serve giao diện này), hoặc chạy app qua Electron: cd desktop; npm start',
            ];
        }
        if (!probe.reachable) {
            return [
                `Backend tại ${probe.apiBase} không phản hồi — nó chưa chạy hoặc đã tắt/crash giữa chừng.`,
                'Chạy lại backend: cd backend; bun run index.ts  (hoặc mở lại app desktop).',
                'Nếu backend vừa chạy xong rồi chết: xem mục "Log backend" ở dưới sau khi khởi động lại, và kiểm tra cổng 3000 có bị chiếm không.',
            ];
        }
        return [
            'Backend vẫn sống nhưng kết nối của request này bị ngắt giữa chừng.',
            'Thường do: request bị hủy (đóng/refresh tab), mạng chập chờn, hoặc tiến trình convert bị kill.',
        ];
    }

    function esc(value) {
        return String(value).replace(/[&<>"]/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
        ));
    }

    function rows(pairs) {
        const cells = pairs
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
            .join('');
        return `<dl class="debug-grid">${cells}</dl>`;
    }

    function block(title, content, opts) {
        if (!content) return '';
        const cls = (opts && opts.className) || '';
        return `<div class="debug-block ${cls}"><h4>${esc(title)}</h4>${content}</div>`;
    }

    function pre(text) {
        return `<pre class="debug-pre">${esc(text)}</pre>`;
    }

    function toolsTable(tools) {
        if (!tools) return '';
        const order = [
            ['yt-dlp', tools.ytDlp],
            ['ffmpeg', tools.ffmpeg],
            ['ffprobe', tools.ffprobe],
            ['JS runtime', tools.jsRuntime],
        ];
        const items = order
            .filter(([, t]) => t)
            .map(([label, t]) => {
                const mark = t.available ? '<span class="ok">OK</span>' : '<span class="bad">THIẾU</span>';
                const detail = esc(t.available ? (t.version || t.resolvedPath || '') : (t.error || ''));
                return `<li>${mark} <b>${esc(label)}</b> <code>${esc(t.command)}</code><span class="debug-tool-detail">${detail}</span></li>`;
            })
            .join('');
        return `<ul class="debug-tools">${items}</ul>`;
    }

    function logsTable(logs) {
        if (!logs || !logs.length) return '';
        const text = logs
            .map((l) => `${l.time.slice(11, 19)} [${l.level}] ${l.message}`)
            .join('\n');
        return pre(text);
    }

    function buildReport(err, probe) {
        const kind = classify(err);
        const detail = (context.errorDetail) || null;
        const hints = [];

        if (kind === 'network') hints.push(...explainNetworkFailure(probe));
        if (detail && detail.hint) hints.push(detail.hint);
        if (probe.diagnostics && probe.diagnostics.problems) hints.push(...probe.diagnostics.problems);

        return {
            time: new Date().toISOString(),
            kind,
            message: String((err && err.message) || err || 'Unknown error'),
            errorName: (err && err.name) || 'Error',
            stack: (err && err.stack) || '',
            hints: Array.from(new Set(hints)),
            context,
            detail,
            events,
            probe,
            page: {
                url: window.location.href,
                protocol: window.location.protocol,
                apiBase: apiBase || '(same-origin)',
                electron: Boolean(window.desktopBridge && window.desktopBridge.isElectron),
                userAgent: navigator.userAgent,
            },
        };
    }

    function render(report) {
        const d = report.detail || {};
        const diag = report.probe.diagnostics;

        const hintsHtml = report.hints.length
            ? `<ul class="debug-hints">${report.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
            : '';

        const commandHtml = d.command
            ? pre([d.command].concat(d.args || []).join(' \\\n  '))
            : '';

        const eventsHtml = report.events.length
            ? pre(report.events.map((e) => `${e.at.slice(11, 23)}  ${JSON.stringify(e.event)}`).join('\n'))
            : '';

        bodyEl.innerHTML = [
            hintsHtml ? block('Nguyên nhân / cách xử lý', hintsHtml, { className: 'debug-hint-block' }) : '',
            block('Tóm tắt', rows([
                ['Thời điểm', report.time],
                ['Loại lỗi', report.kind === 'network' ? 'Không gọi được backend (network)' : report.kind === 'aborted' ? 'Request bị hủy' : 'Lỗi xử lý phía backend'],
                ['Thông báo', report.message],
                ['Bước lỗi', d.stage],
                ['Exit code', d.exitCode !== undefined && d.exitCode !== null ? d.exitCode : ''],
                ['Signal', d.signal],
            ])),
            block('Request', rows([
                ['Endpoint', `${context.method || 'POST'} ${context.endpoint || ''}`],
                ['HTTP status', context.httpStatus],
                ['Content-Type', context.responseContentType],
                ['Input', context.input],
                ['API base', report.page.apiBase],
                ['Trang', `${report.page.protocol}//${window.location.host || '(file)'}`],
                ['Electron', report.page.electron ? 'có' : 'không'],
            ])),
            block('Backend', rows([
                ['Kết nối', report.probe.reachable ? `OK (health ${report.probe.healthStatus})` : `KHÔNG PHẢN HỒI ${report.probe.healthError ? '— ' + report.probe.healthError : ''}`],
                ['Uptime', diag ? `${diag.uptimeSeconds}s` : ''],
                ['Port', diag ? diag.port : ''],
                ['Nền tảng', diag ? `${diag.platform.os} / bun ${diag.platform.bun}` : ''],
                ['Cookies', diag ? `${diag.cookies.mode}${diag.cookies.exists ? ' (' + diag.cookies.file + ')' : ' — chưa có cookies.txt'}` : ''],
                ['Thư mục output', diag ? diag.config.downloadsRoot : ''],
            ])),
            block('Công cụ ngoài', toolsTable(diag && diag.tools)),
            block('Lệnh đã chạy', commandHtml),
            block('stderr', d.stderr ? pre(d.stderr) : ''),
            block('stdout', d.stdout ? pre(d.stdout) : ''),
            block('Log backend', logsTable(diag && diag.logs)),
            block('Event nhận được', eventsHtml),
            block('Stack (frontend)', report.stack ? pre(report.stack) : ''),
        ].join('');

        section.hidden = false;
    }

    async function report(err) {
        if (!section || !bodyEl) return;
        const probe = await probeBackend();
        lastReport = buildReport(err, probe);
        render(lastReport);
        return lastReport;
    }

    async function refresh() {
        if (!lastReport) {
            const probe = await probeBackend();
            lastReport = buildReport(new Error('Kiểm tra thủ công'), probe);
        } else {
            lastReport.probe = await probeBackend();
            lastReport.time = new Date().toISOString();
        }
        render(lastReport);
    }

    function reportText() {
        if (!lastReport) return '';
        return JSON.stringify(lastReport, null, 2);
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const text = reportText();
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                copyBtn.textContent = 'Đã copy!';
            } catch {
                copyBtn.textContent = 'Copy thất bại';
            }
            setTimeout(() => { copyBtn.textContent = 'Copy báo cáo'; }, 2000);
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshBtn.disabled = true;
            refresh().finally(() => { refreshBtn.disabled = false; });
        });
    }

    /** Cảnh báo ngay khi mở app nếu thiếu công cụ — trước khi user bấm convert. */
    async function startupCheck() {
        if (!bannerEl) return;
        const probe = await probeBackend();
        if (!probe.reachable) {
            bannerEl.innerHTML = `<b>Backend không phản hồi.</b> ${esc(explainNetworkFailure(probe)[0])}`;
            bannerEl.hidden = false;
            return;
        }
        const problems = (probe.diagnostics && probe.diagnostics.problems) || [];
        if (problems.length) {
            bannerEl.innerHTML = `<b>Thiếu công cụ:</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
            bannerEl.hidden = false;
        }
    }

    window.Debug = { apiBase, isFileProtocol, reset, setContext, addEvent, report, refresh, reportText };

    startupCheck();
})();

import { randomUUIDv7 } from 'bun';
import express, { type Request, type Response } from 'express';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const app = express();
const port = Number(process.env.PORT) || 3000;

const YT_JS_RUNTIME = process.env.YT_JS_RUNTIME || 'node';

const home = os.homedir();
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const exe = process.platform === 'win32' ? '.exe' : '';

/** Các chỗ hay cài công cụ nhưng không nằm trong PATH. */
function fallbackPaths(name: string): string[] {
    return [
        path.join(import.meta.dir, `${name}${exe}`),
        path.join(import.meta.dir, '..', `${name}${exe}`),
        path.join(home, 'Programs', `${name}${exe}`),
        path.join(home, 'bin', `${name}${exe}`),
        path.join(localAppData, 'Programs', name, `${name}${exe}`),
        path.join(localAppData, 'Microsoft', 'WindowsApps', `${name}${exe}`),
        path.join('C:\\', 'Program Files', name, `${name}${exe}`),
        path.join('C:\\', name, `${name}${exe}`),
    ];
}

/**
 * PATH trước, sau đó dò các thư mục cài phổ biến. Trả lại tên gốc nếu không
 * tìm thấy, để thông báo lỗi vẫn nhắc đúng tên công cụ user cần cài.
 */
function findTool(name: string): string {
    if (Bun.which(name)) return name;
    for (const candidate of fallbackPaths(name)) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return name;
}

const YT_DLP_BIN = process.env.YT_DLP_BIN || findTool('yt-dlp');
const FFMPEG_BIN = process.env.FFMPEG_BIN || findTool('ffmpeg');
const FFPROBE_BIN = process.env.FFPROBE_BIN || findTool('ffprobe');

const cookiesFile = path.resolve(import.meta.dir, './cookies.txt');
const hasCookiesFile = fs.existsSync(cookiesFile);
const cookieArgs = hasCookiesFile
    ? ['--cookies', cookiesFile]
    : ['--cookies-from-browser', 'chrome'];

const frontendDir = path.resolve(import.meta.dir, '../frontend');
const downloadsRoot = path.resolve(import.meta.dir, './public/downloads');
fs.mkdirSync(downloadsRoot, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(frontendDir));
app.use('/downloads', express.static(downloadsRoot));

// ---------------------------------------------------------------------------
// Log ring buffer — served by /api/diagnostics so the browser debug panel can
// show what the backend actually saw, without needing a terminal.
// ---------------------------------------------------------------------------

type LogEntry = { time: string; level: 'info' | 'warn' | 'error'; message: string };

const LOG_LIMIT = 300;
const recentLogs: LogEntry[] = [];

function addLog(level: LogEntry['level'], ...parts: unknown[]): void {
    const message = parts
        .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
        .join(' ');
    recentLogs.push({ time: new Date().toISOString(), level, message });
    if (recentLogs.length > LOG_LIMIT) recentLogs.shift();
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(message);
}

// A crashed backend is invisible to the UI: every later request just fails with
// "Failed to fetch". Keep the process alive and record what happened instead.
process.on('uncaughtException', (err) => {
    addLog('error', '[uncaughtException]', err instanceof Error ? (err.stack ?? err.message) : String(err));
});
process.on('unhandledRejection', (reason) => {
    addLog('error', '[unhandledRejection]', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
});

function datedDir(): string {
    const now = new Date();
    const y = now.getFullYear().toString();
    const m = (now.getMonth() + 1).toString().padStart(2, '0');
    const d = now.getDate().toString().padStart(2, '0');
    const dir = path.join(downloadsRoot, y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function sanitizeFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

const PLAYLIST_PARAMS = new Set(['list', 'index', 'start_radio', 'pp', 'si']);

function stripPlaylistParams(rawUrl: string): string {
    try {
        const u = new URL(rawUrl);
        for (const key of PLAYLIST_PARAMS) u.searchParams.delete(key);
        return u.toString();
    } catch {
        return rawUrl;
    }
}

// ---------------------------------------------------------------------------
// NDJSON streaming
// ---------------------------------------------------------------------------

type ErrorDetail = {
    stage: string;
    command?: string;
    args?: string[];
    exitCode?: number | null;
    signal?: string | null;
    stderr?: string;
    stdout?: string;
    hint?: string;
    cause?: string;
};

type ProgressEvent =
    | { type: 'progress'; stage: string; percent?: number; extra?: Record<string, unknown> }
    | { type: 'done'; filename: string; downloadUrl: string }
    | { type: 'error'; message: string; detail?: ErrorDetail };

/**
 * Wraps the response so the stream can only be ended once.
 *
 * Without this guard a failed spawn fires BOTH 'error' and 'close': the second
 * handler writes after res.end(), Bun throws ERR_STREAM_WRITE_AFTER_END and the
 * whole backend process dies. Every request after that point shows up in the
 * browser as "Failed to fetch".
 */
function createNdjsonStream(res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let ended = false;

    const stream = {
        get ended() {
            return ended;
        },
        write(event: ProgressEvent) {
            if (ended || res.writableEnded || res.destroyed) return;
            try {
                res.write(JSON.stringify(event) + '\n');
            } catch (err) {
                ended = true;
                addLog('warn', '[ndjson] write failed:', err instanceof Error ? err.message : String(err));
            }
        },
        end() {
            if (ended) return;
            ended = true;
            if (!res.writableEnded) res.end();
        },
        fail(message: string, detail: ErrorDetail) {
            if (ended) return;
            addLog('error', `[${detail.stage}] ${message}`, detail.stderr ? `\n${detail.stderr}` : '');
            stream.write({ type: 'error', message, detail });
            stream.end();
        },
        done(filepath: string) {
            if (ended) return;
            const rel = path.relative(downloadsRoot, filepath).replace(/\\/g, '/');
            stream.write({
                type: 'done',
                filename: path.basename(filepath),
                downloadUrl: `/downloads/${rel}`,
            });
            stream.end();
        },
    };

    return stream;
}

function killOnDisconnect(res: Response, child: { exitCode: number | null; kill: () => boolean }) {
    res.on('close', () => {
        if (!res.writableEnded && child.exitCode === null) child.kill();
    });
}

function lastLines(text: string, count: number): string {
    return text.trim().split(/\r?\n/).slice(-count).join('\n');
}

/** Turns a raw tool failure into an actionable, human-readable hint. */
function hintFor(stage: string, command: string, stderr: string, spawnError?: string): string | undefined {
    const blob = `${spawnError ?? ''}\n${stderr}`.toLowerCase();

    if (blob.includes('enoent') || blob.includes('not found in $path') || blob.includes('executable not found')) {
        if (stage.startsWith('yt-dlp')) {
            return `Không tìm thấy "${command}". Cài yt-dlp (Windows: winget install yt-dlp), mở lại app, hoặc set env YT_DLP_BIN trỏ tới yt-dlp.exe.`;
        }
        if (stage.startsWith('ffmpeg')) {
            return `Không tìm thấy "${command}". Cài ffmpeg (Windows: winget install Gyan.FFmpeg), mở lại app, hoặc set env FFMPEG_BIN trỏ tới ffmpeg.exe.`;
        }
        return `Không tìm thấy "${command}" trong PATH.`;
    }
    if (blob.includes('sign in to confirm') || blob.includes('not a bot') || blob.includes('cookies')) {
        return 'YouTube yêu cầu xác minh. Tạo file backend/cookies.txt bằng extension "Get cookies.txt LOCALLY" (xem README).';
    }
    if (blob.includes('js runtime') || blob.includes('--js-runtimes') || blob.includes('nsig')) {
        return `yt-dlp cần JS runtime. Đang dùng "${YT_JS_RUNTIME}" — cài Node.js hoặc Deno, hoặc đổi env YT_JS_RUNTIME.`;
    }
    if (blob.includes('video unavailable') || blob.includes('private video') || blob.includes('members-only')) {
        return 'Video không truy cập được (private / members-only / chặn theo khu vực).';
    }
    if (blob.includes('http error 429') || blob.includes('too many requests')) {
        return 'YouTube rate-limit (429). Chờ vài phút, hoặc dùng cookies.txt của account khác.';
    }
    if (blob.includes('urlopen error') || blob.includes('getaddrinfo') || blob.includes('connection refused')) {
        return 'Không kết nối được tới YouTube. Kiểm tra internet / proxy / firewall.';
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// URL → MP3 (yt-dlp)
// ---------------------------------------------------------------------------

app.post('/api/convert/url', (req: Request, res: Response) => {
    const { url } = req.body ?? {};
    if (typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'Missing url' });
    }

    const stream = createNdjsonStream(res);
    stream.write({ type: 'progress', stage: 'starting', percent: 0 });

    const uuid = randomUUIDv7();
    const outDir = datedDir();
    const outputTemplate = path.join(outDir, `${uuid}-%(title)s.%(ext)s`);

    const cleanUrl = stripPlaylistParams(url);

    const ytArgs = [
        '--no-playlist',
        '-x',
        '--audio-format', 'mp3',
        '-o', outputTemplate,
        '--print', 'after_move:FILE|%(filepath)s',
        '--newline',
        // Bắt buộc: khi stdout là pipe (không phải terminal), yt-dlp tắt hẳn
        // phần progress → UI đứng ở 0% rồi nhảy thẳng sang xong.
        '--progress',
        '--progress-template', 'PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.title)s',
        cleanUrl,
    ];

    addLog('info', `[yt-dlp] spawn ${YT_DLP_BIN}`, cleanUrl);

    let yt: ReturnType<typeof spawn>;
    try {
        yt = spawn(YT_DLP_BIN, ytArgs);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return stream.fail(`Không chạy được yt-dlp: ${message}`, {
            stage: 'yt-dlp:spawn',
            command: YT_DLP_BIN,
            args: ytArgs,
            cause: message,
            hint: hintFor('yt-dlp:spawn', YT_DLP_BIN, '', message),
        });
    }

    let filepath = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    let logBuf = '';
    let lastPercent = -1;
    let stage: 'downloading' | 'converting' = 'downloading';
    let sawFinishedDownload = false;

    yt.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('PROG|')) {
                const parts = trimmed.split('|');
                const percentRaw = (parts[1] ?? '').replace('%', '').trim();
                const percent = parseFloat(percentRaw);
                const speed = (parts[2] ?? '').trim();
                const eta = (parts[3] ?? '').trim();
                const title = (parts[4] ?? '').trim();
                if (!Number.isFinite(percent)) continue;
                if (percent < lastPercent) {
                    stage = sawFinishedDownload ? 'converting' : stage;
                }
                if (percent >= 99.9) sawFinishedDownload = true;
                lastPercent = percent;
                stream.write({
                    type: 'progress',
                    stage,
                    percent,
                    extra: { speed, eta, title },
                });
            } else if (trimmed.startsWith('FILE|')) {
                filepath = trimmed.slice('FILE|'.length).trim();
            } else {
                logBuf += trimmed + '\n';
                addLog('info', '[yt-dlp]', trimmed);
            }
        }
    });

    yt.stderr?.on('data', (chunk) => {
        stderrBuf += chunk.toString();
    });

    yt.on('error', (err) => {
        stream.fail(`yt-dlp không chạy được: ${err.message}`, {
            stage: 'yt-dlp:spawn',
            command: YT_DLP_BIN,
            args: ytArgs,
            cause: err.message,
            stderr: stderrBuf.trim(),
            hint: hintFor('yt-dlp:spawn', YT_DLP_BIN, stderrBuf, err.message),
        });
    });

    killOnDisconnect(res, yt);

    yt.on('close', (code, signal) => {
        if (stream.ended) return;

        const tail = stdoutBuf.trim();
        if (tail.startsWith('FILE|')) filepath = tail.slice('FILE|'.length).trim();

        if (code !== 0) {
            const message = lastLines(stderrBuf, 5) || `yt-dlp thoát với code ${code}`;
            return stream.fail(message, {
                stage: 'yt-dlp:run',
                command: YT_DLP_BIN,
                args: ytArgs,
                exitCode: code,
                signal,
                stderr: stderrBuf.trim(),
                stdout: logBuf.trim(),
                hint: hintFor('yt-dlp:run', YT_DLP_BIN, stderrBuf),
            });
        }

        if (!filepath || !fs.existsSync(filepath)) {
            try {
                const candidates = fs.readdirSync(outDir)
                    .filter((f) => f.startsWith(uuid) && f.endsWith('.mp3'));
                if (candidates.length > 0) filepath = path.join(outDir, candidates[0]!);
            } catch { /* ignore */ }
        }

        if (!filepath || !fs.existsSync(filepath)) {
            return stream.fail('Không tìm thấy file output sau khi convert', {
                stage: 'yt-dlp:output',
                command: YT_DLP_BIN,
                args: ytArgs,
                exitCode: code,
                stderr: stderrBuf.trim(),
                stdout: logBuf.trim(),
                hint: `yt-dlp báo thành công nhưng không có file .mp3 nào trong ${outDir}. Kiểm tra ffmpeg đã cài chưa (yt-dlp cần ffmpeg để tách audio).`,
            });
        }

        stream.done(filepath);
    });
});

// ---------------------------------------------------------------------------
// Local file → MP3 (ffmpeg)
// ---------------------------------------------------------------------------

function probeDurationSeconds(input: string): number | null {
    try {
        const r = spawnSync(FFPROBE_BIN, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            input,
        ], { encoding: 'utf-8' });
        if (r.error || r.status !== 0) return null;
        const d = parseFloat((r.stdout ?? '').trim());
        return Number.isFinite(d) && d > 0 ? d : null;
    } catch {
        return null;
    }
}

app.post('/api/convert/file', (req: Request, res: Response) => {
    const contentType = req.headers['content-type'] ?? '';
    const nameHeader = req.headers['x-filename'];
    const originalName = typeof nameHeader === 'string' && nameHeader
        ? decodeURIComponent(nameHeader)
        : `video-${Date.now()}`;

    if (!contentType.startsWith('application/octet-stream') && !contentType.startsWith('video/')) {
        return res.status(400).json({ error: 'Send raw video bytes with Content-Type application/octet-stream' });
    }

    const stream = createNdjsonStream(res);
    stream.write({ type: 'progress', stage: 'uploading', percent: 0 });

    const uuid = randomUUIDv7();
    const tmpInput = path.join(os.tmpdir(), `${uuid}-${sanitizeFilename(originalName)}`);
    const outDir = datedDir();
    const baseName = sanitizeFilename(path.parse(originalName).name || 'audio');
    const outputPath = path.join(outDir, `${uuid}-${baseName}.mp3`);

    const totalBytes = Number(req.headers['content-length']) || 0;
    let receivedBytes = 0;
    let lastUploadPct = -5;

    const writeStream = fs.createWriteStream(tmpInput);

    req.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (totalBytes > 0) {
            const pct = (receivedBytes / totalBytes) * 100;
            if (pct - lastUploadPct >= 2 || pct >= 100) {
                lastUploadPct = pct;
                stream.write({
                    type: 'progress',
                    stage: 'uploading',
                    percent: Math.min(100, pct),
                    extra: { receivedBytes, totalBytes },
                });
            }
        }
    });

    req.pipe(writeStream);

    writeStream.on('error', (err) => {
        stream.fail(`Upload thất bại: ${err.message}`, {
            stage: 'upload',
            cause: err.message,
            hint: `Không ghi được file tạm ${tmpInput}. Kiểm tra dung lượng ổ đĩa và quyền ghi thư mục temp.`,
        });
    });

    writeStream.on('finish', () => {
        if (stream.ended) return;
        stream.write({ type: 'progress', stage: 'uploading', percent: 100 });

        const duration = probeDurationSeconds(tmpInput);
        stream.write({
            type: 'progress',
            stage: 'converting',
            percent: 0,
            extra: { duration },
        });

        const ffArgs = [
            '-y',
            '-i', tmpInput,
            '-vn',
            '-acodec', 'libmp3lame',
            '-q:a', '2',
            '-progress', 'pipe:1',
            '-nostats',
            outputPath,
        ];

        addLog('info', `[ffmpeg] spawn ${FFMPEG_BIN}`, originalName);

        let ff: ReturnType<typeof spawn>;
        try {
            ff = spawn(FFMPEG_BIN, ffArgs);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            fs.unlink(tmpInput, () => {});
            return stream.fail(`Không chạy được ffmpeg: ${message}`, {
                stage: 'ffmpeg:spawn',
                command: FFMPEG_BIN,
                args: ffArgs,
                cause: message,
                hint: hintFor('ffmpeg:spawn', FFMPEG_BIN, '', message),
            });
        }

        let progBuf = '';
        let stderrBuf = '';
        let lastPct = -5;

        ff.stdout?.on('data', (chunk) => {
            progBuf += chunk.toString();
            const lines = progBuf.split(/\r?\n/);
            progBuf = lines.pop() ?? '';
            const info: Record<string, string> = {};
            for (const line of lines) {
                const idx = line.indexOf('=');
                if (idx <= 0) continue;
                info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
            if (info.out_time_us !== undefined && duration) {
                const seconds = Number(info.out_time_us) / 1_000_000;
                const percent = Math.min(100, (seconds / duration) * 100);
                if (percent - lastPct >= 1 || percent >= 100) {
                    lastPct = percent;
                    stream.write({
                        type: 'progress',
                        stage: 'converting',
                        percent,
                        extra: { speed: info.speed, bitrate: info.bitrate },
                    });
                }
            }
        });

        ff.stderr?.on('data', (chunk) => { stderrBuf += chunk.toString(); });

        ff.on('error', (err) => {
            fs.unlink(tmpInput, () => {});
            stream.fail(`ffmpeg không chạy được: ${err.message}`, {
                stage: 'ffmpeg:spawn',
                command: FFMPEG_BIN,
                args: ffArgs,
                cause: err.message,
                stderr: stderrBuf.trim(),
                hint: hintFor('ffmpeg:spawn', FFMPEG_BIN, stderrBuf, err.message),
            });
        });

        ff.on('close', (code, signal) => {
            fs.unlink(tmpInput, () => {});
            if (stream.ended) return;

            if (code !== 0) {
                const message = lastLines(stderrBuf, 5) || `ffmpeg thoát với code ${code}`;
                return stream.fail(message, {
                    stage: 'ffmpeg:run',
                    command: FFMPEG_BIN,
                    args: ffArgs,
                    exitCode: code,
                    signal,
                    stderr: stderrBuf.trim(),
                    hint: hintFor('ffmpeg:run', FFMPEG_BIN, stderrBuf),
                });
            }

            if (!fs.existsSync(outputPath)) {
                return stream.fail('Không tìm thấy file MP3 sau khi convert', {
                    stage: 'ffmpeg:output',
                    command: FFMPEG_BIN,
                    args: ffArgs,
                    exitCode: code,
                    stderr: stderrBuf.trim(),
                });
            }

            stream.done(outputPath);
        });

        killOnDisconnect(res, ff);
    });

    res.on('close', () => {
        if (!res.writableEnded) fs.unlink(tmpInput, () => {});
    });
});

// ---------------------------------------------------------------------------
// Health + diagnostics
// ---------------------------------------------------------------------------

type ToolStatus = {
    command: string;
    available: boolean;
    resolvedPath?: string;
    version?: string;
    error?: string;
};

function resolveBin(command: string): string | null {
    if (command.includes('/') || command.includes('\\')) {
        return fs.existsSync(command) ? command : null;
    }
    return Bun.which(command);
}

/**
 * "Có/không" quyết định bằng PATH lookup, không bằng việc chạy thử: gọi
 * spawnSync trong request handler thỉnh thoảng trả ETIMEDOUT giả, và báo thiếu
 * nhầm một công cụ đang có thì còn tệ hơn là không báo gì.
 */
function probeTool(command: string, args: string[] = ['--version']): ToolStatus {
    const resolvedPath = resolveBin(command);
    if (!resolvedPath) {
        return { command, available: false, error: `Không tìm thấy "${command}" trong PATH` };
    }

    const status: ToolStatus = { command, available: true, resolvedPath };
    try {
        const r = spawnSync(resolvedPath, args, { encoding: 'utf-8', timeout: 8000 });
        if (r.error) {
            status.error = `Không lấy được version: ${r.error.message}`;
        } else if (r.status !== 0) {
            status.error = lastLines(r.stderr ?? '', 2) || `version check exited ${r.status}`;
        } else {
            status.version = (r.stdout ?? '').trim().split(/\r?\n/)[0] ?? '';
        }
    } catch (err) {
        status.error = err instanceof Error ? err.message : String(err);
    }
    return status;
}

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/diagnostics', (_req, res) => {
    const tools = {
        ytDlp: probeTool(YT_DLP_BIN),
        // ffmpeg/ffprobe dùng '-version' (một gạch), '--version' sẽ lỗi arg.
        ffmpeg: probeTool(FFMPEG_BIN, ['-version']),
        ffprobe: probeTool(FFPROBE_BIN, ['-version']),
        jsRuntime: probeTool(YT_JS_RUNTIME),
    };

    const problems: string[] = [];
    if (!tools.ytDlp.available) problems.push(`Chưa có yt-dlp ("${YT_DLP_BIN}") — không convert được từ URL.`);
    if (!tools.ffmpeg.available) problems.push(`Chưa có ffmpeg ("${FFMPEG_BIN}") — không convert được file local.`);
    if (!tools.ffprobe.available) problems.push(`Chưa có ffprobe ("${FFPROBE_BIN}") — vẫn convert được nhưng không hiện % tiến độ.`);
    if (!tools.jsRuntime.available) problems.push(`Chưa có JS runtime "${YT_JS_RUNTIME}" — YouTube có thể chặn yt-dlp.`);
    if (!hasCookiesFile) problems.push('Chưa có backend/cookies.txt — YouTube có thể yêu cầu xác minh "not a bot".');

    res.json({
        ok: problems.length === 0,
        time: new Date().toISOString(),
        port,
        uptimeSeconds: Math.round(process.uptime()),
        platform: {
            os: `${os.type()} ${os.release()}`,
            arch: os.arch(),
            bun: Bun.version,
            node: process.versions.node,
        },
        config: {
            ytJsRuntime: YT_JS_RUNTIME,
            ytDlpBin: YT_DLP_BIN,
            ffmpegBin: FFMPEG_BIN,
            ffprobeBin: FFPROBE_BIN,
            downloadsRoot,
            frontendDir,
        },
        cookies: {
            mode: hasCookiesFile ? 'file' : 'browser',
            file: cookiesFile,
            exists: hasCookiesFile,
        },
        tools,
        problems,
        logs: recentLogs.slice(-80),
    });
});

const server = app.listen(port, () => {
    addLog('info', `Backend listening on http://localhost:${port}`);
    addLog('info', `[tools] yt-dlp=${YT_DLP_BIN} ffmpeg=${FFMPEG_BIN} ffprobe=${FFPROBE_BIN}`);
});

// Không nuốt lỗi bind: server không nghe được cổng thì có sống cũng vô dụng,
// và desktop app sẽ treo ở bước chờ health check.
server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        addLog('error', `Cổng ${port} đang bị chiếm bởi tiến trình khác. Tắt backend cũ rồi chạy lại, hoặc đổi env PORT.`);
    } else {
        addLog('error', `Không mở được server: ${err.message}`);
    }
    process.exit(1);
});

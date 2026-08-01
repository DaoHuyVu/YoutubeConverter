import { randomUUIDv7 } from 'bun';
import express, { type Request, type Response } from 'express';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const app = express();
const port = Number(process.env.PORT) || 3000;

const YT_JS_RUNTIME = process.env.YT_JS_RUNTIME || 'node';
const cookiesFile = path.resolve(import.meta.dir, './cookies.txt');
const cookieArgs = fs.existsSync(cookiesFile)
    ? ['--cookies', cookiesFile]
    : ['--cookies-from-browser', 'chrome'];

const frontendDir = path.resolve(import.meta.dir, '../frontend');
const downloadsRoot = path.resolve(import.meta.dir, './public/downloads');
fs.mkdirSync(downloadsRoot, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(frontendDir));
app.use('/downloads', express.static(downloadsRoot));

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

type ProgressEvent =
    | { type: 'progress'; stage: string; percent?: number; extra?: Record<string, unknown> }
    | { type: 'done'; filename: string; downloadUrl: string }
    | { type: 'error'; message: string };

function ndjsonStart(res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
}

function ndjsonWrite(res: Response, event: ProgressEvent) {
    res.write(JSON.stringify(event) + '\n');
}

function emitDone(res: Response, filepath: string) {
    const rel = path.relative(downloadsRoot, filepath).replace(/\\/g, '/');
    ndjsonWrite(res, {
        type: 'done',
        filename: path.basename(filepath),
        downloadUrl: `/downloads/${rel}`,
    });
    res.end();
}

function killOnDisconnect(res: Response, child: { exitCode: number | null; kill: () => boolean }) {
    res.on('close', () => {
        if (!res.writableEnded && child.exitCode === null) child.kill();
    });
}

app.post('/api/convert/url', (req: Request, res: Response) => {
    const { url } = req.body ?? {};
    if (typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'Missing url' });
    }

    ndjsonStart(res);
    ndjsonWrite(res, { type: 'progress', stage: 'starting', percent: 0 });

    const uuid = randomUUIDv7();
    const outDir = datedDir();
    const outputTemplate = path.join(outDir, `${uuid}-%(title)s.%(ext)s`);

    const cleanUrl = stripPlaylistParams(url);

    const yt = spawn('yt-dlp', [
        '--no-playlist',
        '--js-runtimes', YT_JS_RUNTIME,
        ...cookieArgs,
        '-x',
        '--audio-format', 'mp3',
        '-o', outputTemplate,
        '--print', 'after_move:FILE|%(filepath)s',
        '--newline',
        '--progress-template', 'PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.title)s',
        cleanUrl,
    ]);

    let filepath = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    let lastPercent = -1;
    let stage: 'downloading' | 'converting' = 'downloading';
    let sawFinishedDownload = false;

    yt.stdout.on('data', (chunk) => {
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
                ndjsonWrite(res, {
                    type: 'progress',
                    stage,
                    percent,
                    extra: { speed, eta, title },
                });
            } else if (trimmed.startsWith('FILE|')) {
                filepath = trimmed.slice('FILE|'.length).trim();
            } else {
                console.log('[yt-dlp]', trimmed);
            }
        }
    });

    yt.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
    });

    yt.on('error', (err) => {
        ndjsonWrite(res, { type: 'error', message: `yt-dlp not available: ${err.message}` });
        res.end();
    });

    killOnDisconnect(res, yt);

    yt.on('close', (code) => {
        const tail = stdoutBuf.trim();
        if (tail.startsWith('FILE|')) filepath = tail.slice('FILE|'.length).trim();

        if (code !== 0) {
            const msg = stderrBuf.trim().split(/\r?\n/).slice(-5).join('\n') || `yt-dlp exited ${code}`;
            ndjsonWrite(res, { type: 'error', message: msg });
            return res.end();
        }

        if (!filepath || !fs.existsSync(filepath)) {
            try {
                const candidates = fs.readdirSync(outDir)
                    .filter((f) => f.startsWith(uuid) && f.endsWith('.mp3'));
                if (candidates.length > 0) filepath = path.join(outDir, candidates[0]!);
            } catch { /* ignore */ }
        }

        if (!filepath || !fs.existsSync(filepath)) {
            ndjsonWrite(res, { type: 'error', message: 'Output file not found' });
            return res.end();
        }

        emitDone(res, filepath);
    });

});

function probeDurationSeconds(input: string): number | null {
    const r = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        input,
    ], { encoding: 'utf-8' });
    if (r.status !== 0) return null;
    const d = parseFloat(r.stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : null;
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

    ndjsonStart(res);
    ndjsonWrite(res, { type: 'progress', stage: 'uploading', percent: 0 });

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
                ndjsonWrite(res, {
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
        ndjsonWrite(res, { type: 'error', message: `Upload failed: ${err.message}` });
        res.end();
    });

    writeStream.on('finish', () => {
        ndjsonWrite(res, { type: 'progress', stage: 'uploading', percent: 100 });

        const duration = probeDurationSeconds(tmpInput);
        ndjsonWrite(res, {
            type: 'progress',
            stage: 'converting',
            percent: 0,
            extra: { duration },
        });

        const ff = spawn('ffmpeg', [
            '-y',
            '-i', tmpInput,
            '-vn',
            '-acodec', 'libmp3lame',
            '-q:a', '2',
            '-progress', 'pipe:1',
            '-nostats',
            outputPath,
        ]);

        let progBuf = '';
        let stderrBuf = '';
        let lastPct = -5;

        ff.stdout.on('data', (chunk) => {
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
                    ndjsonWrite(res, {
                        type: 'progress',
                        stage: 'converting',
                        percent,
                        extra: { speed: info.speed, bitrate: info.bitrate },
                    });
                }
            }
        });

        ff.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

        ff.on('error', (err) => {
            fs.unlink(tmpInput, () => {});
            ndjsonWrite(res, { type: 'error', message: `ffmpeg not available: ${err.message}` });
            res.end();
        });

        ff.on('close', (code) => {
            fs.unlink(tmpInput, () => {});
            if (code !== 0) {
                const msg = stderrBuf.trim().split(/\r?\n/).slice(-5).join('\n') || `ffmpeg exited ${code}`;
                ndjsonWrite(res, { type: 'error', message: msg });
                return res.end();
            }
            emitDone(res, outputPath);
        });

        killOnDisconnect(res, ff);
    });

    res.on('close', () => {
        if (!res.writableEnded) fs.unlink(tmpInput, () => {});
    });
});

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.listen(port, () => {
    console.log(`Backend listening on http://localhost:${port}`);
});

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const PORT = 3987;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let serverLog = '';

async function waitForHealth(timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(`${BASE}/api/health`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await Bun.sleep(200);
    }
    throw new Error(`Server never became healthy.\n--- server log ---\n${serverLog}`);
}

async function readNdjson(res: Response): Promise<any[]> {
    const text = await res.text();
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}

beforeAll(async () => {
    server = spawn('bun', ['run', 'index.ts'], {
        cwd: import.meta.dir,
        env: {
            ...process.env,
            PORT: String(PORT),
            // Force the "tool is missing" failure path deterministically, so the test
            // reproduces the crash regardless of whether yt-dlp is installed.
            YT_DLP_BIN: path.join(import.meta.dir, 'no-such-yt-dlp-binary'),
            FFMPEG_BIN: path.join(import.meta.dir, 'no-such-ffmpeg-binary'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (d) => { serverLog += d.toString(); });
    server.stderr?.on('data', (d) => { serverLog += d.toString(); });
    await waitForHealth();
});

afterAll(() => {
    server?.kill();
});

test('missing yt-dlp reports an error event without killing the server', async () => {
    const res = await fetch(`${BASE}/api/convert/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }),
    });

    const events = await readNdjson(res);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('yt-dlp');

    // The whole point: one failed conversion must not take the backend down.
    // A crashed backend is what surfaces in the browser as "Failed to fetch".
    const health = await fetch(`${BASE}/api/health`);
    expect(health.ok).toBe(true);
    expect(serverLog).not.toContain('ERR_STREAM_WRITE_AFTER_END');
});

test('missing ffmpeg reports an error event without killing the server', async () => {
    const res = await fetch(`${BASE}/api/convert/file`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': 'sample.mp4',
        },
        body: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    });

    const events = await readNdjson(res);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ffmpeg');

    const health = await fetch(`${BASE}/api/health`);
    expect(health.ok).toBe(true);
    expect(serverLog).not.toContain('ERR_STREAM_WRITE_AFTER_END');
});

test('/api/diagnostics reports which external tools are available', async () => {
    const res = await fetch(`${BASE}/api/diagnostics`);
    expect(res.ok).toBe(true);

    const body = await res.json();
    expect(body.port).toBe(PORT);
    expect(body.tools.ytDlp.available).toBe(false);
    expect(body.tools.ytDlp.command).toContain('no-such-yt-dlp-binary');
    expect(body.tools.ffmpeg.available).toBe(false);
    expect(typeof body.cookies.mode).toBe('string');
});

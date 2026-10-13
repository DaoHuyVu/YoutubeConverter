// Chuẩn bị resource cho bản cài: compile backend thành backend.exe (không cần
// Bun trên máy đích) và copy yt-dlp / ffmpeg / ffprobe vào staging/tools.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const backendDir = path.resolve(desktopDir, '..', 'backend');
const buildDir = path.join(desktopDir, 'staging');
const toolsDir = path.join(buildDir, 'tools');

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(toolsDir, { recursive: true });

console.log('[prepare] compiling backend...');
execFileSync('bun', [
    'build', path.join(backendDir, 'index.ts'),
    '--compile', '--minify', '--target=bun-windows-x64',
    '--outfile', path.join(buildDir, 'backend', 'backend.exe'),
], { cwd: backendDir, stdio: 'inherit' });

/** Đường dẫn công cụ: env <NAME>_BIN trước, sau đó `where`. */
function locate(name, envVar) {
    if (process.env[envVar]) return process.env[envVar];
    try {
        const out = execFileSync('where.exe', [`${name}.exe`], { encoding: 'utf8' });
        return out.split(/\r?\n/).find(Boolean);
    } catch {
        return null;
    }
}

for (const [name, envVar] of [['yt-dlp', 'YT_DLP_BIN'], ['ffmpeg', 'FFMPEG_BIN'], ['ffprobe', 'FFPROBE_BIN']]) {
    const src = locate(name, envVar);
    if (!src || !fs.existsSync(src)) {
        console.error(`[prepare] Không tìm thấy ${name}.exe. Cài vào PATH hoặc set env ${envVar}.`);
        process.exit(1);
    }
    fs.copyFileSync(src, path.join(toolsDir, `${name}.exe`));
    console.log(`[prepare] ${name}: ${src}`);
}

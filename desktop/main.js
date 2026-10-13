const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

// Bản cài đặt: thư mục cài có thể bị xoá khi gỡ app, nên file MP3 lưu vào
// thư mục Music của user, cookies.txt đặt trong userData.
const DOWNLOADS_ROOT = app.isPackaged
    ? path.join(app.getPath('music'), 'Video to MP3')
    : path.resolve(__dirname, '..', 'backend', 'public', 'downloads');

ipcMain.handle('show-in-folder', (_event, relativeUrl) => {
    if (typeof relativeUrl !== 'string') return false;
    const rel = relativeUrl.replace(/^\/+/, '').replace(/^downloads\//, '');
    const absolute = path.resolve(DOWNLOADS_ROOT, rel);
    if (!absolute.startsWith(DOWNLOADS_ROOT) || !fs.existsSync(absolute)) return false;
    shell.showItemInFolder(absolute);
    return true;
});

const BACKEND_PORT = 3000;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

let backendProcess = null;
let mainWindow = null;

function startBackend() {
    if (app.isPackaged) {
        const res = process.resourcesPath;
        const backendExe = path.join(res, 'backend', 'backend.exe');
        backendProcess = spawn(backendExe, [], {
            cwd: path.dirname(backendExe),
            env: {
                ...process.env,
                PORT: String(BACKEND_PORT),
                FRONTEND_DIR: path.join(res, 'frontend'),
                TOOLS_DIR: path.join(res, 'tools'),
                DOWNLOADS_DIR: DOWNLOADS_ROOT,
                COOKIES_FILE: path.join(app.getPath('userData'), 'cookies.txt'),
            },
            windowsHide: true,
        });
    } else {
        const backendDir = path.resolve(__dirname, '..', 'backend');
        const bunCmd = process.platform === 'win32' ? 'bun.exe' : 'bun';
        backendProcess = spawn(bunCmd, ['run', 'index.ts'], {
            cwd: backendDir,
            env: { ...process.env, PORT: String(BACKEND_PORT) },
            windowsHide: true,
        });
    }

    backendProcess.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
    backendProcess.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
    backendProcess.on('error', (err) => {
        dialog.showErrorBox('Backend error', `Không khởi động được bun backend: ${err.message}\n\nHãy cài Bun: https://bun.sh`);
    });
    backendProcess.on('exit', (code) => {
        console.log(`[backend] exited with code ${code}`);
    });
}

function waitForBackend(timeoutMs = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            const req = http.get(`${BACKEND_URL}/api/health`, (res) => {
                res.resume();
                if (res.statusCode === 200) return resolve();
                retry();
            });
            req.on('error', retry);
            req.setTimeout(1000, () => { req.destroy(); retry(); });
        };
        const retry = () => {
            if (Date.now() - start > timeoutMs) return reject(new Error('Backend timeout'));
            setTimeout(tick, 300);
        };
        tick();
    });
}

function createWindow() {
    const iconPath = path.join(__dirname, 'assets',
        process.platform === 'win32' ? 'icon.ico' : 'icon.png');

    mainWindow = new BrowserWindow({
        width: 640,
        height: 720,
        title: 'Video → MP3 Converter',
        autoHideMenuBar: true,
        icon: iconPath,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    mainWindow.loadURL(BACKEND_URL);
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
    startBackend();
    try {
        await waitForBackend();
    } catch (err) {
        dialog.showErrorBox('Startup failed', `Backend không phản hồi: ${err.message}`);
        app.quit();
        return;
    }
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (backendProcess && !backendProcess.killed) {
        backendProcess.kill();
    }
});

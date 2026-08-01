# YouTube / Video → MP3 Converter

Desktop app đơn giản để convert video sang MP3, hỗ trợ 2 nguồn:

- **URL** (YouTube, ...) → dùng `yt-dlp`
- **File video local** → dùng `ffmpeg`

## Cấu trúc

- [backend/](backend/) — Express + Bun HTTP server, xử lý conversion
- [frontend/](frontend/) — HTML/CSS/JS UI (backend serve static)
- [desktop/](desktop/) — Electron wrapper

## Yêu cầu

- [Bun](https://bun.sh) (đã cài: `bun --version`)
- [Node.js](https://nodejs.org) + npm (cho Electron)
- [ffmpeg](https://ffmpeg.org) — cần cho convert file local
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — cần cho convert từ URL. Windows: `winget install yt-dlp`

## Cài dependencies

```powershell
cd backend; bun install
cd ../desktop; npm install
```

## Chạy desktop app

```powershell
cd desktop; npm start
```

Electron sẽ tự spawn backend (port 3000) và mở cửa sổ ứng dụng.

## Cấu hình yt-dlp

**Env vars:**

| Var | Mặc định | Ý nghĩa |
|---|---|---|
| `YT_JS_RUNTIME` | `node` | Truyền vào `--js-runtimes` để yt-dlp giải các format YouTube mới cần JS runtime. Có thể đổi thành `deno` nếu đã cài deno. |

**Cookies (bắt buộc để né bot check của YouTube):**

Backend tự phát hiện theo thứ tự:

1. **Nếu có file `backend/cookies.txt`** → dùng `--cookies backend/cookies.txt` *(khuyến nghị, ổn định nhất)*
2. **Nếu không** → thử `--cookies-from-browser chrome` *(có thể lỗi DPAPI với Chrome 127+, hoặc "Could not copy cookie database" nếu Chrome đang mở)*

**Cách tạo `cookies.txt`:**

1. Cài extension **"Get cookies.txt LOCALLY"** trong Chrome / Edge / Firefox
2. Mở [youtube.com](https://youtube.com) (login sẵn)
3. Click icon extension → **Export**
4. Đổi tên file thành `cookies.txt`, đặt vào [backend/](backend/)

File `backend/cookies.txt` đã được thêm vào `.gitignore` để không lỡ push lên git.

## Chạy backend riêng (chế độ web)

```powershell
cd backend; bun run index.ts
```

Mở [http://localhost:3000](http://localhost:3000).

## API

- `POST /api/convert/url` — body `{ "url": "..." }` → `{ filename, downloadUrl }`
- `POST /api/convert/file` — raw bytes, header `X-Filename: <tên file>` → `{ filename, downloadUrl }`
- `GET /downloads/...` — static access tới file MP3 đã convert
- `GET /api/health` — health check

File output lưu tại [backend/public/downloads/YYYY/MM/DD/](backend/public/downloads/).

Lệnh PowerShell tạo Shortcut: $desktop=[Environment]::GetFolderPath('Desktop');$shortcut=Join-Path $desktop 'Video to MP3.lnk';$projectRoot='D:\VuDH\Projects\YoutubeConverter';$target=Join-Path $projectRoot 'desktop\node_modules\electron\dist\electron.exe';$workDir=Join-Path $projectRoot 'desktop';$iconPath=Join-Path $projectRoot 'desktop\assets\icon.ico';if(!(Test-Path $target)){Write-Host "ERROR: $target not found";exit 1};$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut($shortcut);$sc.TargetPath=$target;$sc.Arguments="`"$workDir`"";$sc.WorkingDirectory=$workDir;if(Test-Path $iconPath){$sc.IconLocation=$iconPath};$sc.Description='Convert video to MP3';$sc.WindowStyle=1;$sc.Save();Write-Host "Created: $shortcut"
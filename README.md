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

## Build file cài đặt (.exe)

```powershell
cd desktop; npm run dist
```

Kết quả: `desktop/dist/VideoToMP3-Setup-<version>.exe`. Script [desktop/scripts/prepare.js](desktop/scripts/prepare.js) compile backend thành `backend.exe` (máy cài không cần Bun) và copy `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe` từ máy build vào bộ cài (lấy từ PATH, hoặc env `YT_DLP_BIN` / `FFMPEG_BIN` / `FFPROBE_BIN`).

Bản cài đặt lưu MP3 vào `%USERPROFILE%\Music\Video to MP3\`, đọc cookies từ `%APPDATA%\Video to MP3\cookies.txt`. `backend/cookies.txt` **không** được đóng gói vào bộ cài.

## Cấu hình yt-dlp

**Env vars:**

| Var | Mặc định | Ý nghĩa |
|---|---|---|
| `YT_JS_RUNTIME` | `node` | Truyền vào `--js-runtimes` để yt-dlp giải các format YouTube mới cần JS runtime. Có thể đổi thành `deno` nếu đã cài deno. |
| `YT_DLP_BIN` | tự dò | Đường dẫn tới `yt-dlp`, ghi đè phần tự dò. |
| `FFMPEG_BIN` | tự dò | Đường dẫn tới `ffmpeg`, ghi đè phần tự dò. |
| `FFPROBE_BIN` | tự dò | Đường dẫn tới `ffprobe`, ghi đè phần tự dò. |

**Không cần thêm vào PATH:** backend tìm công cụ theo PATH trước, nếu không có thì dò các thư mục hay dùng — `backend/`, thư mục gốc project, `%USERPROFILE%\Programs\`, `%USERPROFILE%\bin\`, `%LOCALAPPDATA%\Programs\<tên>\`, `C:\Program Files\<tên>\`. Đường dẫn thực tế được in trong log lúc khởi động và hiện trong section debug.

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

## Debug khi convert lỗi

Khi một lần convert thất bại, app mở section **"Chi tiết lỗi (debug)"** ngay dưới thông báo lỗi, gồm:

- **Nguyên nhân / cách xử lý** — gợi ý cụ thể (thiếu yt-dlp, YouTube đòi cookies, rate-limit 429, mất mạng...)
- **Request** — endpoint, HTTP status, API base, input
- **Backend** — còn sống không, uptime, port, chế độ cookies, thư mục output
- **Công cụ ngoài** — yt-dlp / ffmpeg / ffprobe / JS runtime có hay thiếu, kèm version và đường dẫn
- **Lệnh đã chạy** + **stderr** / **stdout** của yt-dlp hoặc ffmpeg
- **Log backend** và toàn bộ event NDJSON nhận được

Nút **Copy báo cáo** copy tất cả dưới dạng JSON, **Kiểm tra lại backend** probe lại backend mà không cần convert lại.

Ngoài ra app kiểm tra ngay lúc mở: nếu thiếu công cụ, banner vàng hiện ở đầu trang trước khi bấm convert.

Endpoint thô: [`GET /api/diagnostics`](http://localhost:3000/api/diagnostics).

### "Failed to fetch" nghĩa là gì

Đây là lỗi của trình duyệt khi request **không tới được backend**, không phải lỗi convert. Hai nguyên nhân hay gặp:

1. **Backend chưa chạy hoặc đã chết** — mở lại app desktop, hoặc `cd backend; bun run index.ts`. Nếu cổng 3000 đang bị chiếm, backend sẽ báo rõ và thoát.
2. **Mở `frontend/index.html` trực tiếp bằng `file://`** — trang không gọi được API tương đối. Hãy mở [http://localhost:3000](http://localhost:3000) (backend tự serve giao diện) hoặc chạy qua Electron.

Section debug tự phân biệt hai trường hợp này và in ra đúng hướng xử lý.

## Chạy backend riêng (chế độ web)

```powershell
cd backend; bun run index.ts
```

Mở [http://localhost:3000](http://localhost:3000).

## Test

```powershell
cd backend; bun test
```

[backend/server.test.ts](backend/server.test.ts) kiểm tra rằng khi thiếu yt-dlp/ffmpeg, backend trả event lỗi **mà không chết** — đây chính là bug từng khiến app báo "Failed to fetch" ở lần convert thứ hai.

## API

- `POST /api/convert/url` — body `{ "url": "..." }` → `{ filename, downloadUrl }`
- `POST /api/convert/file` — raw bytes, header `X-Filename: <tên file>` → `{ filename, downloadUrl }`
- `GET /downloads/...` — static access tới file MP3 đã convert
- `GET /api/health` — health check

File output lưu tại [backend/public/downloads/YYYY/MM/DD/](backend/public/downloads/).

Lệnh PowerShell tạo Shortcut: $desktop=[Environment]::GetFolderPath('Desktop');$shortcut=Join-Path $desktop 'Video to MP3.lnk';$projectRoot='D:\VuDH\Projects\YoutubeConverter';$target=Join-Path $projectRoot 'desktop\node_modules\electron\dist\electron.exe';$workDir=Join-Path $projectRoot 'desktop';$iconPath=Join-Path $projectRoot 'desktop\assets\icon.ico';if(!(Test-Path $target)){Write-Host "ERROR: $target not found";exit 1};$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut($shortcut);$sc.TargetPath=$target;$sc.Arguments="`"$workDir`"";$sc.WorkingDirectory=$workDir;if(Test-Path $iconPath){$sc.IconLocation=$iconPath};$sc.Description='Convert video to MP3';$sc.WindowStyle=1;$sc.Save();Write-Host "Created: $shortcut"
import { randomUUIDv7 } from 'bun';
import express from 'express';
import { spawn } from 'node:child_process';

const app = express();
const port = 3000;

app.use(express.json());
express.static("public");

app.post('/', (req, res) => {
    const { url }= req.body;
    const now = new Date();
    const uuid = randomUUIDv7();

    const yt = spawn("yt-dlp",[
        "-x",
        "--audio-format",
        "mp3",
        "-o",
        `./public/downloads/${now.getFullYear()}/${now.getMonth().toString().padStart(2,'0')}/${now.getDate().toString().padStart(2,'0')}/${uuid}-%(title)s.%(ext)s`,
        "--print",
        "after_move:filepath",
        url
    ])

    let filepath = "";
    let stderr = "";

    yt.stdout.on("data", (data) => {
        filepath += data.toString();
    });

    yt.stderr.on("data", (data) => {
        stderr += data.toString();
    });

    yt.on("close", (code) => {
        if (code !== 0) {
            return res.status(500).json({ error: stderr });
        }

        filepath = filepath.trim();

        res.download(filepath);
    });
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
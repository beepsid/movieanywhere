// movieanywhere: stream videos from a local folder to any device on your home Wi-Fi.
// No dependencies. Run: node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const MOVIE_DIR = path.resolve(process.env.MOVIE_DIR || "C:\\local\\movie");
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, "cache"));

// Locate ffmpeg/ffprobe: env var, PATH, or the winget install location.
function findTool(name) {
  const candidates = [
    process.env[name.toUpperCase()],
    name,
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", name + ".exe"),
    ...wingetPackageBins(name),
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ["-version"], { stdio: "ignore" }); return c; } catch {}
  }
  return null;
}
// winget sometimes skips the Links alias; look inside its package folder (…\Gyan.FFmpeg_*\ffmpeg-*\bin).
function wingetPackageBins(name) {
  const root = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  try {
    return fs.readdirSync(root).filter((d) => /ffmpeg/i.test(d)).flatMap((d) =>
      fs.readdirSync(path.join(root, d)).map((sub) => path.join(root, d, sub, "bin", name + ".exe")));
  } catch { return []; }
}
const FFMPEG = findTool("ffmpeg");
const FFPROBE = findTool("ffprobe");

const VIDEO_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".ts": "video/mp2t",
};
const SUB_TYPES = { ".vtt": "text/vtt", ".srt": "text/plain" };

// Only allow devices on the local network (home Wi-Fi), never the internet.
function isLocalAddress(addr) {
  if (!addr) return false;
  addr = addr.replace(/^::ffff:/, "");
  if (addr === "::1" || addr === "127.0.0.1") return true;
  const p = addr.split(".").map(Number);
  if (p.length === 4) {
    return (
      p[0] === 10 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254)
    );
  }
  return /^f[cd]/i.test(addr) || /^fe80:/i.test(addr); // IPv6 private / link-local
}

// Resolve a user-supplied relative path, refusing anything outside MOVIE_DIR.
function safeResolve(rel) {
  const full = path.resolve(MOVIE_DIR, "." + path.sep + (rel || ""));
  if (full !== MOVIE_DIR && !full.startsWith(MOVIE_DIR + path.sep)) return null;
  return full;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function listDir(res, rel) {
  const dir = safeResolve(rel);
  if (!dir) return sendJson(res, 400, { error: "Bad path" });
  fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
    if (err) return sendJson(res, 404, { error: "Folder not found" });
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const relPath = path.posix.join((rel || "").replace(/\\/g, "/"), e.name);
      const ext = path.extname(e.name).toLowerCase();
      if (e.isDirectory()) {
        items.push({ type: "folder", name: e.name, path: relPath });
      } else if (VIDEO_TYPES[ext]) {
        let size = 0;
        try { size = fs.statSync(path.join(dir, e.name)).size; } catch {}
        items.push({ type: "video", name: e.name, path: relPath, size, ext: ext.slice(1) });
      }
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "folder" ? -1 : 1));
    sendJson(res, 200, { path: (rel || "").replace(/\\/g, "/"), items });
  });
}

// Stream a file with HTTP Range support so seeking works on every device.
function streamFile(req, res, file, type) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end("Not found"); }
    const total = stat.size;
    const range = req.headers.range;
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (m && !m[1] && m[2]) { start = total - parseInt(m[2], 10); end = total - 1; } // suffix range
      if (isNaN(start) || start >= total || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        return res.end();
      }
      end = Math.min(end, total - 1);
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "Content-Length": total });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
}

// ---- Making files playable in every browser ----

const BROWSER_AUDIO = new Set(["aac", "mp3"]);
const BROWSER_VIDEO = new Set(["h264", "hevc"]);
const TEXT_SUBS = new Set(["subrip", "ass", "ssa", "webvtt", "mov_text"]);
const jobs = new Map(); // cacheKey -> { progress, error }
const probes = new Map();

function cacheKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
}
const cachedVideo = (key) => path.join(CACHE_DIR, key + ".mp4");
const cachedSub = (key) => path.join(CACHE_DIR, key + ".vtt");

function probe(file) {
  if (probes.has(file)) return Promise.resolve(probes.get(file));
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name:stream_tags=language", "-of", "json", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed"));
      const info = JSON.parse(out);
      probes.set(file, info);
      resolve(info);
    });
  });
}

function needsConversion(file, info) {
  const ext = path.extname(file).toLowerCase();
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  const okContainer = ext === ".mp4" || ext === ".m4v";
  const okVideo = v && BROWSER_VIDEO.has(v.codec_name);
  const okAudio = !a || BROWSER_AUDIO.has(a.codec_name);
  return !(okContainer && okVideo && okAudio);
}

// Prefer an audio track in the user's language order (Hindi, then English), else the first.
function pickAudio(info) {
  const audio = info.streams.filter((s) => s.codec_type === "audio");
  for (const lang of ["hin", "eng"]) {
    const s = audio.find((x) => x.tags && x.tags.language === lang);
    if (s) return s;
  }
  return audio[0];
}

function startConversion(file, key, info) {
  if (jobs.has(key)) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const job = { progress: 0, error: null };
  jobs.set(key, job);
  const duration = Number(info.format.duration) || 0;
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = pickAudio(info);
  const part = cachedVideo(key) + ".part";

  const args = ["-y", "-v", "error", "-i", file, "-map", `0:${v.index}`];
  if (a) {
    args.push("-map", `0:${a.index}`);
    if (BROWSER_AUDIO.has(a.codec_name)) args.push("-c:a", "copy");
    else args.push("-c:a", "aac", "-ac", "2", "-b:a", "192k");
  }
  args.push("-c:v", "copy");
  if (v.codec_name === "hevc") args.push("-tag:v", "hvc1"); // needed for Safari/iPhone
  args.push("-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", part);

  const p = spawn(FFMPEG, args);
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.stdout.on("data", (d) => {
    const m = /out_time_us=(\d+)/g;
    let hit, last;
    while ((hit = m.exec(d.toString()))) last = hit;
    if (last && duration) job.progress = Math.min(99, Math.round(Number(last[1]) / 1e6 / duration * 100));
  });
  p.on("close", (code) => {
    if (code === 0) {
      fs.renameSync(part, cachedVideo(key));
      jobs.delete(key);
      console.log(`  Ready: ${path.basename(file)}`);
    } else {
      job.error = err.trim().split("\n").pop() || "Conversion failed";
      fs.rm(part, { force: true }, () => {});
      console.error(`  Failed: ${path.basename(file)}: ${job.error}`);
    }
  });
  console.log(`  Preparing: ${path.basename(file)}`);

  // Pull out the first text subtitle track (English preferred) as WebVTT.
  const subs = info.streams.filter((s) => s.codec_type === "subtitle" && TEXT_SUBS.has(s.codec_name));
  const sub = subs.find((s) => s.tags && s.tags.language === "eng") || subs[0];
  if (sub && !fs.existsSync(cachedSub(key))) {
    spawn(FFMPEG, ["-y", "-v", "error", "-i", file, "-map", `0:${sub.index}`, "-f", "webvtt", cachedSub(key)]);
  }
}

// Tells the page whether a file can play right away, is being prepared, or can't be fixed.
async function prepare(res, rel) {
  const file = safeResolve(rel);
  if (!file || !VIDEO_TYPES[path.extname(file).toLowerCase()] || !fs.existsSync(file)) return sendJson(res, 404, { error: "Not found" });
  if (!FFMPEG || !FFPROBE) return sendJson(res, 200, { status: "direct", warning: "ffmpeg is not installed, so files with unsupported audio may play silently." });
  try {
    const key = cacheKey(file);
    if (fs.existsSync(cachedVideo(key))) return sendJson(res, 200, { status: "ready" });
    const info = await probe(file);
    if (!needsConversion(file, info)) return sendJson(res, 200, { status: "direct" });
    startConversion(file, key, info);
    const job = jobs.get(key);
    if (job.error) { jobs.delete(key); return sendJson(res, 200, { status: "failed", error: job.error }); }
    sendJson(res, 200, { status: "preparing", progress: job.progress });
  } catch (e) {
    sendJson(res, 200, { status: "direct", warning: e.message });
  }
}

// Serve the browser-friendly copy if one exists, otherwise the original file.
function playableFile(file) {
  try {
    const c = cachedVideo(cacheKey(file));
    if (fs.existsSync(c)) return { file: c, type: "video/mp4" };
  } catch {}
  return { file, type: VIDEO_TYPES[path.extname(file).toLowerCase()] };
}

// Find a matching subtitle file (movie.srt / movie.vtt / movie.en.srt ...) next to a video,
// or one extracted from inside the movie.
function findSubtitle(videoFile) {
  try {
    const c = cachedSub(cacheKey(videoFile));
    if (fs.existsSync(c) && fs.statSync(c).size > 10) return c;
  } catch {}
  const dir = path.dirname(videoFile);
  const base = path.basename(videoFile, path.extname(videoFile)).toLowerCase();
  try {
    const subs = fs.readdirSync(dir).filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return SUB_TYPES[ext] && f.toLowerCase().startsWith(base);
    });
    return subs.length ? path.join(dir, subs[0]) : null;
  } catch { return null; }
}

// Convert SRT to WebVTT on the fly (browsers only understand VTT).
function sendSubtitle(res, file) {
  fs.readFile(file, "utf8", (err, text) => {
    if (err) { res.writeHead(404); return res.end(); }
    if (path.extname(file).toLowerCase() === ".srt") {
      text = "WEBVTT\n\n" + text.replace(/\r/g, "").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
    }
    res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8" });
    res.end(text);
  });
}

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
  if (!isLocalAddress(req.socket.remoteAddress)) {
    res.writeHead(403);
    return res.end("Local network only");
  }
  const url = new URL(req.url, "http://localhost");
  const p = url.searchParams.get("path") || "";

  if (url.pathname === "/api/list") return listDir(res, p);

  if (url.pathname === "/api/prepare") return prepare(res, p);

  if (url.pathname === "/video") {
    const file = safeResolve(p);
    if (!file || !VIDEO_TYPES[path.extname(file).toLowerCase()]) { res.writeHead(400); return res.end("Bad path"); }
    const play = playableFile(file);
    return streamFile(req, res, play.file, play.type);
  }

  if (url.pathname === "/subtitle") {
    const file = safeResolve(p);
    const sub = file && findSubtitle(file);
    if (!sub) { res.writeHead(404); return res.end(); }
    return sendSubtitle(res, sub);
  }

  // Static files: the single page app.
  const name = url.pathname === "/" || url.pathname === "/watch" ? "index.html" : url.pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(name));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(400); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": STATIC_TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && isLocalAddress(i.address))
    .map((i) => i.address);
  console.log(`\n  movieanywhere is running. Movies folder: ${MOVIE_DIR}\n`);
  console.log(`  On this laptop:      http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  On phone / TV:       http://${ip}:${PORT}`);
  console.log(`\n  (Devices must be on the same Wi-Fi. Press Ctrl+C to stop.)\n`);
  if (!FFMPEG || !FFPROBE) console.log("  ffmpeg not found: movies with Dolby/DTS audio may have no sound.\n  Install it with:  winget install Gyan.FFmpeg\n");
});

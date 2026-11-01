// movieanywhere: stream videos from a local folder to any device on your home Wi-Fi.
// No dependencies. Run: node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const MOVIE_DIR = path.resolve(process.env.MOVIE_DIR || "C:\\local\\movie");
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, "public");

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

// Find a matching subtitle file (movie.srt / movie.vtt / movie.en.srt ...) next to a video.
function findSubtitle(videoFile) {
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

  if (url.pathname === "/video") {
    const file = safeResolve(p);
    const type = file && VIDEO_TYPES[path.extname(file).toLowerCase()];
    if (!type) { res.writeHead(400); return res.end("Bad path"); }
    return streamFile(req, res, file, type);
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
});

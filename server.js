const express = require("express");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const archiver = require("archiver");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PUBLIC_DIR = path.join(__dirname, "public");

app.disable("x-powered-by");
// Render sits behind a trusted reverse proxy; needed for correct client IP/rate-limit handling.
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

function normalizeInstagramUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("Paste a valid Instagram URL.");
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { throw new Error("That URL doesn't look valid. Copy the link directly from Instagram."); }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!["instagram.com", "m.instagram.com"].includes(host)) throw new Error("For safety, this tool only accepts Instagram links.");
  if (!/^\/(reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) {
    throw new Error("Use a public Reel or post link, such as instagram.com/reel/…");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function safeName(value, fallback = "instagram-media") {
  return String(value || fallback).normalize("NFKD")
    .replace(/[^a-zA-Z0-9 _.-]/g, "").trim()
    .replace(/[ .]+/g, "-").slice(0, 80) || fallback;
}

function runParthDl(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("parth-dl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Instagram took too long to respond. Please try again later."));
    }, timeoutMs);
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(value);
    }
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (stdout.length > 5_000_000) {
        child.kill("SIGKILL");
        finish(new Error("The media information was unexpectedly large."));
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    child.on("error", () => finish(new Error("The media service is not available right now.")));
    child.on("close", code => {
      if (code !== 0) {
        const detail = stderr.toLowerCase();
        if (detail.includes("login") || detail.includes("private") || detail.includes("authentication") || detail.includes("checkpoint") || detail.includes("consent")) {
          return finish(new Error("Instagram is blocking automated access to this post. It can happen even when the profile is public, so this does not prove the post is private. Try another public Reel or try again later."));
        }
        if (detail.includes("429") || detail.includes("rate limit") || detail.includes("too many requests")) {
          return finish(new Error("Instagram is temporarily rate-limiting downloads. Please wait a few minutes and try again."));
        }
        return finish(new Error("Instagram couldn't provide this media. The post may be public but unavailable to automated access, or the link may be invalid. Try another public Reel."));
      }
      finish(null, stdout);
    });
  });
}

async function getInfo(url) {
  const raw = await runParthDl(["--json", "--no-banner", url]);
  const item = JSON.parse(raw);
  const entries = Array.isArray(item.entries) ? item.entries : [];
  const formats = entries.flatMap(entry => Array.isArray(entry.formats) ? entry.formats : []);
  const dimensions = formats
    .filter(format => Number.isFinite(format.width) && Number.isFinite(format.height))
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  return {
    title: item.title || "Instagram media",
    thumbnail: item.thumbnail || null,
    duration: Number.isFinite(item.duration) ? item.duration : null,
    uploader: item.uploader || null,
    webpage_url: url,
    type: item.type || "video",
    availableFormats: formats.length,
    bestResolution: dimensions ? { width: dimensions.width, height: dimensions.height } : null,
    filesizeBytes: null
  };
}

async function downloadToDirectory(url, dir, baseName) {
  const targetDir = path.join(dir, safeName(baseName, "media"));
  await fs.promises.mkdir(targetDir, { recursive: true });
  // Explicitly request the best rendition exposed by Instagram to this public, logged-out client.
  await runParthDl([url, "--quality", "best", "--paths", targetDir, "--quiet", "--no-banner"], 180_000);
  const files = (await fs.promises.readdir(targetDir))
    .filter(name => !name.endsWith(".part") && !name.endsWith(".part.json") && !name.endsWith(".json"));
  if (!files.length) throw new Error("The media download did not produce a file.");
  files.sort((a, b) => (a.endsWith(".mp4") ? -1 : 0) - (b.endsWith(".mp4") ? -1 : 0));
  const source = path.join(targetDir, files[0]);
  const ext = path.extname(source).toLowerCase() || ".mp4";
  const output = path.join(dir, safeName(baseName, "media") + ext);
  await fs.promises.rename(source, output);
  return output;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "instagram-reels-downloader" }));

app.post("/api/info", async (req, res) => {
  try {
    const url = normalizeInstagramUrl(req.body?.url);
    res.json(await getInfo(url));
  } catch (err) {
    res.status(400).json({ error: err.message || "Unable to retrieve this media." });
  }
});

app.get("/api/download", async (req, res) => {
  let url;
  try { url = normalizeInstagramUrl(req.query.url); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const requestedName = safeName(req.query.title || "instagram-video", "instagram-video");
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "reelsave-"));
  try {
    // The page already looked up metadata. Avoid a second Instagram extraction before downloading.
    const file = await downloadToDirectory(url, dir, requestedName);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === ".webm" ? "video/webm" : ext === ".mkv" ? "video/x-matroska" : "video/mp4";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", 'attachment; filename="' + requestedName + ext + '"');
    res.setHeader("Cache-Control", "no-store");
    res.on("close", () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}));
    await pipeline(fs.createReadStream(file), res);
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) res.status(400).json({ error: err.message || "Unable to download this media." });
    else res.destroy(err);
  }
});

const batchJobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;
function cleanOldJobs() {
  const now = Date.now();
  for (const [id, job] of batchJobs) if (now - job.createdAt > JOB_TTL_MS) {
    batchJobs.delete(id); fs.promises.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }
}
setInterval(cleanOldJobs, 5 * 60 * 1000).unref();

app.post("/api/batch-download", async (req, res) => {
  let urls;
  try {
    if (!Array.isArray(req.body?.urls) || !req.body.urls.length) throw new Error("Paste one or more Instagram links first.");
    if (req.body.urls.length > 10) throw new Error("Bulk mode supports up to 10 links at a time.");
    urls = [...new Set(req.body.urls.map(normalizeInstagramUrl))];
    if (!urls.length) throw new Error("No valid Instagram links were provided.");
  } catch (err) { return res.status(400).json({ error: err.message || "Please check your links." }); }
  const id = require("crypto").randomUUID();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "reelsave-bulk-"));
  const job = { id, dir, createdAt: Date.now(), status: "processing", total: urls.length, completed: 0, currentTitle: "", items: [], zipPath: null, error: null };
  batchJobs.set(id, job);
  res.status(202).json({ jobId: id });
  (async () => {
    const files = [];
    for (let i = 0; i < urls.length; i++) {
      const item = { index: i + 1, url: urls[i], title: "Link " + (i + 1), status: "queued", sizeBytes: null, error: null };
      job.items.push(item); job.currentTitle = item.title;
      try {
        item.status = "downloading";
        const info = await getInfo(urls[i]); item.title = info.title || item.title; item.sizeBytes = info.filesizeBytes || null; job.currentTitle = item.title;
        const file = await downloadToDirectory(urls[i], dir, String(i + 1).padStart(2, "0") + "-" + safeName(item.title, "reel"));
        item.sizeBytes = (await fs.promises.stat(file)).size; item.status = "ready"; files.push({ file, name: path.basename(file) });
      } catch (err) { item.status = "failed"; item.error = err.message || "This link could not be downloaded."; }
      job.completed++;
    }
    if (!files.length) { job.status = "failed"; job.error = "None of these links could be downloaded. Check that the posts are publicly accessible."; return; }
    try {
      job.zipPath = path.join(dir, "instagram-reels.zip");
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(job.zipPath);
        const archive = archiver("zip", { zlib: { level: 1 } });
        output.on("close", resolve); output.on("error", reject); archive.on("error", reject);
        archive.pipe(output); for (const file of files) archive.file(file.file, { name: file.name });
        archive.finalize().catch(reject);
      });
      job.zipSizeBytes = (await fs.promises.stat(job.zipPath)).size; job.status = "ready";
    } catch { job.status = "failed"; job.error = "Videos downloaded, but the ZIP could not be prepared. Please download items individually."; }
  })().catch(err => { job.status = "failed"; job.error = err.message || "Bulk download failed."; });
});

app.get("/api/batch-status/:id", (req, res) => {
  const job = batchJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "This bulk download expired. Please start it again." });
  res.setHeader("Cache-Control", "no-store");
  res.json({ jobId: job.id, status: job.status, total: job.total, completed: job.completed, currentTitle: job.currentTitle,
    items: job.items.map(({ index, title, status, sizeBytes, error }) => ({ index, title, status, sizeBytes, error })),
    zipSizeBytes: job.zipSizeBytes || null, error: job.error });
});

app.get("/api/batch-download/:id", async (req, res) => {
  const job = batchJobs.get(req.params.id);
  if (!job || job.status !== "ready" || !job.zipPath) return res.status(409).json({ error: "ZIP is not ready yet. Wait for progress to finish." });
  res.setHeader("Content-Type", "application/zip"); res.setHeader("Content-Disposition", 'attachment; filename="instagram-reels.zip"');
  res.setHeader("Content-Length", String(job.zipSizeBytes)); res.setHeader("Cache-Control", "no-store");
  await pipeline(fs.createReadStream(job.zipPath), res);
  setTimeout(() => { const current = batchJobs.get(job.id); if (current) { batchJobs.delete(job.id); fs.promises.rm(job.dir, { recursive: true, force: true }).catch(() => {}); } }, 5 * 60 * 1000).unref();
});

app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.listen(PORT, "0.0.0.0", () => console.log("Instagram downloader listening on port " + PORT));

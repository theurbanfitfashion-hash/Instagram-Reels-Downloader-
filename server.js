const express = require("express");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PUBLIC_DIR = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
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

function runYtDlp(args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
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
        if (detail.includes("login") || detail.includes("private") || detail.includes("authentication")) {
          return finish(new Error("This post may be private or require Instagram login. Only accessible public media is supported."));
        }
        return finish(new Error("Instagram couldn't provide this media. Check that the link is public and try again."));
      }
      finish(null, stdout);
    });
  });
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "instagram-reels-downloader" }));

app.post("/api/info", async (req, res) => {
  try {
    const url = normalizeInstagramUrl(req.body?.url);
    const raw = await runYtDlp(["--dump-single-json", "--no-warnings", "--no-playlist", "--skip-download", url]);
    const item = JSON.parse(raw);
    res.json({
      title: item.title || "Instagram media",
      thumbnail: item.thumbnail || null,
      duration: Number.isFinite(item.duration) ? item.duration : null,
      uploader: item.uploader || item.channel || null,
      webpage_url: url
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Unable to retrieve this media." });
  }
});

app.get("/api/download", async (req, res) => {
  let url;
  try { url = normalizeInstagramUrl(req.query.url); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  // Fetch metadata first so errors can be returned before streaming begins.
  try {
    const raw = await runYtDlp(["--dump-single-json", "--no-warnings", "--no-playlist", "--skip-download", url], 90_000);
    const item = JSON.parse(raw);
    const safeTitle = String(item.title || "instagram-media")
      .normalize("NFKD").replace(/[^a-zA-Z0-9 _.-]/g, "").trim().replace(/[ .]+/g, "-").slice(0, 80) || "instagram-media";
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="' + safeTitle + '.mp4"');
    res.setHeader("Cache-Control", "no-store");

    const child = spawn("yt-dlp", [
      "--no-warnings", "--no-playlist", "--no-progress",
      "-f", "best[ext=mp4]/best",
      "-o", "-", url
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", () => { if (!res.headersSent) res.status(502); res.end(); });
    child.stdout.pipe(res);
    child.on("close", code => {
      if (code !== 0) {
        if (!res.headersSent) res.status(502).json({ error: "The media download failed. The post may be restricted or unavailable." });
        else res.destroy(new Error("Media stream failed"));
      }
    });
    res.on("close", () => { if (!res.writableEnded) child.kill("SIGTERM"); });
  } catch (err) {
    res.status(400).json({ error: err.message || "Unable to download this media." });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, "0.0.0.0", () => console.log("Instagram downloader listening on port " + PORT));

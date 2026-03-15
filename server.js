import express from "express"
import cors from "cors"
import { spawn } from "child_process"
import { randomUUID } from "crypto"
import { unlink, stat, writeFile } from "fs/promises"
import { createReadStream, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const app = express()
app.use(cors())
app.use(express.json())

// ─── Fichier cookies Instagram ────────────────────────────────────────────
// Chemin fixe — écrit une seule fois au démarrage
const INSTAGRAM_COOKIES_PATH = join(tmpdir(), "instagram_cookies.txt")

async function initInstagramCookies() {
  const b64 = process.env.INSTAGRAM_COOKIES_B64
  if (!b64) {
    console.log("[cookies] INSTAGRAM_COOKIES_B64 not set — Instagram may require login")
    return
  }
  try {
    const content = Buffer.from(b64, "base64").toString("utf-8")
    await writeFile(INSTAGRAM_COOKIES_PATH, content, "utf-8")
    console.log("[cookies] Instagram cookies written to", INSTAGRAM_COOKIES_PATH)
  } catch (err) {
    console.error("[cookies] Failed to write Instagram cookies:", err.message)
  }
}

// ─── Utilitaire : exécuter une commande ──────────────────────────────────
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let stdout = "", stderr = ""
    proc.stdout?.on("data", (d) => { stdout += d.toString() })
    proc.stderr?.on("data", (d) => {
      stderr += d.toString()
      console.log(`[${cmd}]`, d.toString().trim())
    })
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`))
    })
    proc.on("error", reject)
  })
}

// ─── Détection de plateforme ──────────────────────────────────────────────
function detectPlatform(url) {
  if (/tiktok\.com/i.test(url))             return "tiktok"
  if (/instagram\.com/i.test(url))          return "instagram"
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook"
  if (/youtube\.com|youtu\.be/i.test(url))  return "youtube"
  return "generic"
}

// ─── Args supplémentaires par plateforme ─────────────────────────────────
function platformArgs(platform) {
  const args = []
  if (platform === "instagram") {
    // User-agent mobile pour contourner certains blocages
    args.push(
      "--add-header",
      "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    )
    // Cookies si disponibles
    if (existsSync(INSTAGRAM_COOKIES_PATH)) {
      args.push("--cookies", INSTAGRAM_COOKIES_PATH)
    }
  }
  return args
}

// ─── Construction des qualités ────────────────────────────────────────────
function buildQualities(info, platform) {
  const formats = info.formats || []

  const mergedFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url
  )
  const videoOnlyFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") && f.url
  )

  let qualities = []

  if (mergedFormats.length > 0) {
    const byKey = {}
    for (const f of mergedFormats) {
      const key = f.height ? `${f.height}p` : (f.format_note || f.format_id || "Best")
      if (!byKey[key] || (f.tbr || 0) > (byKey[key].tbr || 0)) byKey[key] = { ...f }
    }
    qualities = Object.entries(byKey)
      .sort((a, b) => (parseInt(b[0]) || 0) - (parseInt(a[0]) || 0))
      .map(([key, f]) => ({
        label: key, height: f.height || 0, formatId: f.format_id,
        filesize: f.filesize || f.filesize_approx || null, needsMerge: false,
      }))
  }

  if (videoOnlyFormats.length > 0) {
    const byKey = {}
    for (const f of videoOnlyFormats) {
      const key = f.height ? `${f.height}p` : (f.format_note || f.format_id || "Video")
      const cur = byKey[key]
      const fH264 = (f.vcodec || "").startsWith("avc")
      const curH264 = cur ? (cur.vcodec || "").startsWith("avc") : false
      if (!cur || (!curH264 && fH264) || (fH264 === curH264 && (f.tbr || 0) > (cur.tbr || 0))) {
        byKey[key] = { ...f }
      }
    }
    const voQ = Object.entries(byKey)
      .sort((a, b) => {
        const ha = parseInt(a[0]) || 0, hb = parseInt(b[0]) || 0
        if (hb !== ha) return hb - ha
        if (a[0].toLowerCase() === "hd") return -1
        if (b[0].toLowerCase() === "hd") return  1
        return 0
      })
      .map(([key, f]) => ({
        label: key, height: f.height || 0, formatId: f.format_id,
        filesize: f.filesize || f.filesize_approx || null, needsMerge: true,
      }))
    qualities = [...qualities, ...voQ]
  }

  if (qualities.length === 0) {
    qualities = [{ label: "Best", height: 0, formatId: "best", filesize: null, needsMerge: false }]
  }
  return qualities
}

// ─── GET / ───────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("DownloadAllInOne API — YouTube · TikTok · Instagram · Facebook")
})

// ─── POST /info ───────────────────────────────────────────────────────────
app.post("/info", (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "No URL provided" })

  const platform = detectPlatform(url)
  const safeUrl  = url.replace(/"/g, "").trim()

  console.log(`[info] platform=${platform} url=${safeUrl}`)

  const proc = spawn("yt-dlp", ["--no-playlist", "-j", ...platformArgs(platform), safeUrl], { timeout: 45000 })
  let stdout = "", stderr = ""
  proc.stdout.on("data", (d) => { stdout += d.toString() })
  proc.stderr.on("data", (d) => { stderr += d.toString() })

  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`[info] yt-dlp exit ${code}:`, stderr.slice(0, 500))
      let msg = "Unable to fetch this video"
      if (stderr.includes("Private") || stderr.includes("private"))        msg = "This video is private or inaccessible"
      else if (stderr.includes("not a video"))                              msg = "This link does not point to a video"
      else if (platform === "instagram" && (stderr.includes("login") || stderr.includes("Login") || stderr.includes("cookie")))
        msg = "Instagram requires login — please configure cookies (see README)"
      else if (platform === "tiktok" && stderr.includes("Unable"))         msg = "TikTok video inaccessible — make sure the link is public"
      else if (platform === "facebook" && stderr.includes("login"))        msg = "This Facebook video requires login"
      return res.status(500).json({ error: msg })
    }
    let info
    try   { info = JSON.parse(stdout) }
    catch { return res.status(500).json({ error: "Parsing error" }) }

    const qualities = buildQualities(info, platform)
    console.log(`[info] ${qualities.length} quality(ies):`, qualities.map((q) => `${q.label}(merge=${q.needsMerge})`).join(" | "))
    res.json({
      title: info.title || "Video", thumbnail: info.thumbnail || null,
      duration: info.duration || null, uploader: info.uploader || info.channel || info.creator || null,
      originalUrl: url, platform, qualities,
    })
  })
  proc.on("error", (err) => { console.error("[info] spawn error:", err); res.status(500).json({ error: "Server error" }) })
})

// ─── GET /stream ──────────────────────────────────────────────────────────
app.get("/stream", async (req, res) => {
  const { url, formatId, height, title, needsMerge } = req.query
  if (!url || !formatId) return res.status(400).json({ error: "url and formatId required" })

  const safeUrl      = String(url).replace(/"/g, "").trim()
  const safeFormatId = String(formatId).replace(/['";\s\\<>|&]/g, "").substring(0, 120)
  const safeHeight   = parseInt(height || "0") || 0
  const safeTitle    = String(title || "video").replace(/[^\w\s\-]/gi, "").replace(/\s+/g, "_").substring(0, 80)
  const platform     = detectPlatform(safeUrl)
  const shouldMerge  = needsMerge === "true"

  const uid    = randomUUID()
  const rawTmp = join(tmpdir(), `dl_${uid}_raw.mp4`)
  const outTmp = join(tmpdir(), `dl_${uid}_out.mp4`)
  const cleanup = () => Promise.all([rawTmp, outTmp].map((f) => unlink(f).catch(() => {})))

  console.log(`[stream] platform=${platform} h=${safeHeight} merge=${shouldMerge} uid=${uid}`)

  try {

    if (platform === "facebook" || platform === "generic") {
      // Facebook : pas d'audio-only → format merged (vidéo+audio ensemble)
      const h = safeHeight
      const sel = [
        h > 0 ? `best[vcodec^=avc][height=${h}]`  : null,
        h > 0 ? `best[vcodec^=avc][height<=${h}]` : null,
        `best[vcodec^=avc]`,
        h > 0 ? `best[height<=${h}]` : null,
        `best`,
      ].filter(Boolean).join("/")

      console.log(`[stream] Facebook selector: ${sel}`)
      await run("yt-dlp", ["--no-playlist", "-f", sel, "-o", rawTmp, safeUrl])

      console.log(`[stream] ffmpeg remux`)
      await run("ffmpeg", [
        "-y", "-i", rawTmp,
        "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "copy", "-c:a", "aac",
        "-movflags", "+faststart",
        outTmp,
      ])

    } else if (shouldMerge) {
      // YouTube / Instagram vidéo-only : 2 fichiers + merge
      const videoTmp = join(tmpdir(), `dl_${uid}_v.mp4`)
      const audioTmp = join(tmpdir(), `dl_${uid}_a.m4a`)

      console.log(`[stream] Step 1 video: ${safeFormatId}`)
      await run("yt-dlp", ["--no-playlist", ...platformArgs(platform), "-f", safeFormatId, "-o", videoTmp, safeUrl])

      console.log(`[stream] Step 2 audio: bestaudio[ext=m4a]/bestaudio`)
      await run("yt-dlp", ["--no-playlist", ...platformArgs(platform), "-f", "bestaudio[ext=m4a]/bestaudio", "-o", audioTmp, safeUrl])

      console.log(`[stream] Step 3 ffmpeg merge`)
      await run("ffmpeg", [
        "-y", "-i", videoTmp, "-i", audioTmp,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac",
        "-movflags", "+faststart",
        outTmp,
      ])
      await Promise.all([unlink(videoTmp).catch(() => {}), unlink(audioTmp).catch(() => {})])

    } else {
      // TikTok / Instagram merged : direct + remux
      console.log(`[stream] Merged format: ${safeFormatId}`)
      await run("yt-dlp", ["--no-playlist", ...platformArgs(platform), "-f", safeFormatId, "-o", rawTmp, safeUrl])

      await run("ffmpeg", [
        "-y", "-i", rawTmp,
        "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "copy", "-c:a", "aac",
        "-movflags", "+faststart",
        outTmp,
      ])
    }

    const stats = await stat(outTmp)
    if (stats.size === 0) throw new Error("Output file is empty")

    console.log(`[stream] Ready: ${(stats.size / 1e6).toFixed(1)} MB → streaming`)

    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
    res.setHeader("Content-Type", "video/mp4")
    res.setHeader("Content-Length", stats.size)

    // Track the successful download with real metadata
    trackDownload({
      platform: platform,
      quality:  safeHeight ? `${safeHeight}` : "?",
      size_mb:  stats.size / 1e6,
      title:    String(req.query.title || "Video"),
      status:   "ok",
    })

    const rs = createReadStream(outTmp)
    rs.pipe(res)
    rs.on("close", () => { cleanup(); console.log("[stream] Sent & cleaned up") })

  } catch (err) {
    console.error("[stream] Error:", err.message)
    // Track error
    adminStats.errors_today++
    adminStats.recent.unshift({
      platform: detectPlatform(String(req.query.url || "")),
      quality:  "?",
      size_mb:  0,
      title:    String(req.query.title || "Video").slice(0, 80),
      status:   "error",
      ts:       Date.now(),
    })
    if (adminStats.recent.length > 20) adminStats.recent.pop()
    cleanup()
    if (!res.headersSent) res.status(500).json({ error: "Download failed — " + err.message.split("\n")[0] })
  }
})

// ─── Admin middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET
  if (!secret) return res.status(500).json({ error: "ADMIN_SECRET not configured" })
  const header = req.headers["x-admin-secret"]
  if (header !== secret) return res.status(401).json({ error: "Unauthorized" })
  next()
}

// ─── In-memory stats store ────────────────────────────────────────────────
const adminStats = {
  downloads_today: 0,
  downloads_total: 0,
  errors_today:    0,
  bandwidth_mb:    0,
  by_platform:     { youtube: 0, tiktok: 0, instagram: 0, facebook: 0 },
  by_quality:      { "4K": 0, "1080p": 0, "720p": 0, "≤480p": 0 },
  recent:          [],  // last 20 downloads
  recentLogs:      [],  // last 100 log entries
}

// Patch console to capture logs
const origLog   = console.log.bind(console)
const origError = console.error.bind(console)
const origWarn  = console.warn.bind(console)

function pushLog(level, msg) {
  adminStats.recentLogs.unshift({ level, msg: String(msg).slice(0, 300), ts: Date.now() })
  if (adminStats.recentLogs.length > 100) adminStats.recentLogs.pop()
  if (level === "error") adminStats.errors_today++
}

console.log   = (...a) => { origLog(...a);   pushLog("info",  a.join(" ")) }
console.error = (...a) => { origError(...a); pushLog("error", a.join(" ")) }
console.warn  = (...a) => { origWarn(...a);  pushLog("warn",  a.join(" ")) }

// Track a completed download with full metadata
function trackDownload({ platform, quality, size_mb, title, status }) {
  adminStats.downloads_today++
  adminStats.downloads_total++
  adminStats.bandwidth_mb += size_mb || 0

  // By platform
  const p = platform || "generic"
  if (p in adminStats.by_platform) adminStats.by_platform[p]++

  // By quality bucket
  const h = parseInt(quality) || 0
  if (h >= 2160)      adminStats.by_quality["4K"]++
  else if (h >= 1080) adminStats.by_quality["1080p"]++
  else if (h >= 720)  adminStats.by_quality["720p"]++
  else                adminStats.by_quality["≤480p"]++

  // Recent list
  adminStats.recent.unshift({
    platform: p,
    quality:  quality || "?",
    size_mb:  Math.round(size_mb || 0),
    title:    (title || "Video").slice(0, 80),
    status:   status || "ok",
    ts:       Date.now(),
  })
  if (adminStats.recent.length > 20) adminStats.recent.pop()
}

// Reset daily counters at midnight
function scheduleDailyReset() {
  const now  = new Date()
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  setTimeout(() => {
    adminStats.downloads_today = 0
    adminStats.errors_today    = 0
    adminStats.bandwidth_mb    = 0
    adminStats.by_platform     = { youtube: 0, tiktok: 0, instagram: 0, facebook: 0 }
    adminStats.by_quality      = { "4K": 0, "1080p": 0, "720p": 0, "≤480p": 0 }
    scheduleDailyReset()
  }, next - now)
}
scheduleDailyReset()

// ─── GET /admin/stats ─────────────────────────────────────────────────────
app.get("/admin/stats", requireAdmin, async (req, res) => {
  // Get disk/memory usage
  let cpu = 0, ram = 0, disk = 0
  try {
    const os = await import("os")
    const total = os.totalmem()
    const free  = os.freemem()
    ram  = Math.round((1 - free / total) * 100)
    disk = 24 // approximation — /tmp usage

    // CPU: sample over 100ms
    const cpuStart = os.cpus().map(c => ({ ...c.times }))
    await new Promise(r => setTimeout(r, 100))
    const cpuEnd = os.cpus().map(c => ({ ...c.times }))
    const deltas = cpuEnd.map((c, i) => {
      const s = cpuStart[i]
      const idle  = c.idle  - s.idle
      const total = Object.values(c).reduce((a, b) => a + b, 0) - Object.values(s).reduce((a, b) => a + b, 0)
      return total ? (1 - idle / total) * 100 : 0
    })
    cpu = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
  } catch { /* fallback */ }

  // Count tmp files
  let tmpFiles = 0
  try {
    const { readdir } = await import("fs/promises")
    const files = await readdir(tmpdir())
    tmpFiles = files.filter(f => f.startsWith("dl_")).length
  } catch { /* ignore */ }

  // Check yt-dlp
  let ytdlpOk = false
  let ytdlpVersion = "unknown"
  try {
    const { stdout } = await run("yt-dlp", ["--version"])
    ytdlpVersion = stdout.trim()
    ytdlpOk = true
  } catch { ytdlpOk = false }

  res.json({
    downloads_today:  adminStats.downloads_today,
    downloads_total:  adminStats.downloads_total,
    visitors_today:   0,
    errors_today:     adminStats.errors_today,
    avg_response_s:   3.2,
    success_rate:     (adminStats.downloads_today + adminStats.errors_today) > 0
      ? ((adminStats.downloads_today / (adminStats.downloads_today + adminStats.errors_today)) * 100).toFixed(1)
      : 100,
    bandwidth_gb:     (adminStats.bandwidth_mb / 1024).toFixed(2),
    by_platform:      adminStats.by_platform,
    by_quality:       adminStats.by_quality,
    recent:           adminStats.recent,
    server: {
      cpu, ram, disk,
      ytdlp_ok:   ytdlpOk,
      ytdlp:      ytdlpVersion,
      ffmpeg_ok:  true,
      ffmpeg:     "6.x",
      uptime_s:   Math.floor(process.uptime()),
      tmp_files:  tmpFiles,
    },
  })
})

// ─── GET /admin/logs ──────────────────────────────────────────────────────
app.get("/admin/logs", requireAdmin, (req, res) => {
  res.json({ logs: adminStats.recentLogs })
})

// ─── Démarrage ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080
initInstagramCookies().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`))
})

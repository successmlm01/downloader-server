import express from "express"
import cors from "cors"
import { spawn } from "child_process"
import { randomUUID } from "crypto"
import { unlink, stat } from "fs/promises"
import { createReadStream } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const app = express()
app.use(cors())
app.use(express.json())

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
  if (platform === "instagram") {
    return [
      "--add-header",
      "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    ]
  }
  return []
}

// ─── Construction des qualités ────────────────────────────────────────────
function buildQualities(info, platform) {
  const formats = info.formats || []

  // Formats avec vidéo ET audio fusionnés (TikTok, Instagram)
  const mergedFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url
  )

  // Formats vidéo seuls (YouTube, Facebook — height peut être null)
  const videoOnlyFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") && f.url
  )

  let qualities = []

  // ── Formats fusionnés (TikTok, Instagram) ──
  if (mergedFormats.length > 0) {
    const byKey = {}
    for (const f of mergedFormats) {
      const key = f.height ? `${f.height}p` : (f.format_note || f.format_id || "Best")
      if (!byKey[key] || (f.tbr || 0) > (byKey[key].tbr || 0)) byKey[key] = { ...f }
    }
    qualities = Object.entries(byKey)
      .sort((a, b) => (parseInt(b[0]) || 0) - (parseInt(a[0]) || 0))
      .map(([key, f]) => ({
        label:      key,
        height:     f.height || 0,
        formatId:   f.format_id,
        filesize:   f.filesize || f.filesize_approx || null,
        needsMerge: false,
      }))
  }

  // ── Formats vidéo seuls (YouTube, Facebook) ──
  if (videoOnlyFormats.length > 0) {
    const byKey = {}
    for (const f of videoOnlyFormats) {
      const key = f.height ? `${f.height}p` : (f.format_note || f.format_id || "Video")
      // Préférer H.264 (avc) sur VP9 à hauteur identique
      const cur = byKey[key]
      const fH264  = (f.vcodec || "").startsWith("avc")
      const curH264 = cur ? (cur.vcodec || "").startsWith("avc") : false
      if (!cur || (!curH264 && fH264) || (fH264 === curH264 && (f.tbr || 0) > (cur.tbr || 0))) {
        byKey[key] = { ...f }
      }
    }
    const voQ = Object.entries(byKey)
      .sort((a, b) => {
        const ha = parseInt(a[0]) || 0
        const hb = parseInt(b[0]) || 0
        if (hb !== ha) return hb - ha
        if (a[0].toLowerCase() === "hd") return -1
        if (b[0].toLowerCase() === "hd") return  1
        return 0
      })
      .map(([key, f]) => ({
        label:      key,
        height:     f.height || 0,
        formatId:   f.format_id,
        filesize:   f.filesize || f.filesize_approx || null,
        needsMerge: true,
      }))
    qualities = [...qualities, ...voQ]
  }

  if (qualities.length === 0) {
    qualities = [{ label: "Best", height: 0, formatId: "best", filesize: null, needsMerge: false }]
  }

  return qualities
}

// ─── Construire le format selector yt-dlp ────────────────────────────────
//
// Objectif : H.264 + AAC natifs dans le fichier final
//   → compatible QuickTime, iOS, Android, Windows sans réencodage
//   → réencodage = lent + risque de perte audio si mal configuré
//
// Facebook : URLs signées expirent → sélecteur par hauteur uniquement
// YouTube  : format_id stable → on l'utilise directement
//
function buildSelector(platform, formatId, height, needsMerge) {
  if (!needsMerge) {
    // TikTok / Instagram merged : format direct, pas de merge
    return formatId
  }

  if (platform === "facebook" || platform === "generic") {
    // Facebook : URLs signées expirent → sélecteur basé sur hauteur
    // On construit une chaîne de fallbacks du plus strict au plus permissif
    const h = height || 0
    const hFilter = h > 0 ? `[height<=${h}]` : ""
    const hExact  = h > 0 ? `[height=${h}]`  : ""

    return [
      // Idéal : H.264 + AAC m4a à la bonne hauteur
      `bestvideo[vcodec^=avc]${hExact}+bestaudio[ext=m4a]`,
      // H.264 + AAC à hauteur ≤
      `bestvideo[vcodec^=avc]${hFilter}+bestaudio[ext=m4a]`,
      // H.264 + n'importe quel audio
      `bestvideo[vcodec^=avc]${hFilter}+bestaudio`,
      // N'importe quelle vidéo + AAC m4a
      `bestvideo${hFilter}+bestaudio[ext=m4a]`,
      // N'importe quelle vidéo + n'importe quel audio
      `bestvideo${hFilter}+bestaudio`,
      // Dernier recours : meilleur format unique (déjà merged)
      `best`,
    ].join("/")
  }

  // YouTube / Instagram vidéo-only : format_id stable
  return [
    `${formatId}+bestaudio[ext=m4a]`,
    `${formatId}+bestaudio`,
  ].join("/")
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
  const args     = ["--no-playlist", "-j", ...platformArgs(platform), safeUrl]

  console.log(`[info] platform=${platform} url=${safeUrl}`)

  const proc = spawn("yt-dlp", args, { timeout: 45000 })
  let stdout = ""
  let stderr = ""

  proc.stdout.on("data", (d) => { stdout += d.toString() })
  proc.stderr.on("data", (d) => { stderr += d.toString() })

  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`[info] yt-dlp exit ${code}:`, stderr.slice(0, 500))
      let msg = "Unable to fetch this video"
      if (stderr.includes("Private") || stderr.includes("private"))
        msg = "This video is private or inaccessible"
      else if (stderr.includes("not a video"))
        msg = "This link does not point to a video"
      else if (platform === "instagram" && stderr.includes("login"))
        msg = "This Instagram post requires login"
      else if (platform === "tiktok" && stderr.includes("Unable"))
        msg = "TikTok video inaccessible — make sure the link is public"
      else if (platform === "facebook" && stderr.includes("login"))
        msg = "This Facebook video requires login"
      return res.status(500).json({ error: msg })
    }

    let info
    try   { info = JSON.parse(stdout) }
    catch { return res.status(500).json({ error: "Parsing error" }) }

    const qualities = buildQualities(info, platform)
    console.log(
      `[info] ${qualities.length} quality(ies):`,
      qualities.map((q) => `${q.label}(merge=${q.needsMerge})`).join(" | ")
    )

    res.json({
      title:       info.title     || "Video",
      thumbnail:   info.thumbnail || null,
      duration:    info.duration  || null,
      uploader:    info.uploader  || info.channel || info.creator || null,
      originalUrl: url,
      platform,
      qualities,
    })
  })

  proc.on("error", (err) => {
    console.error("[info] spawn error:", err)
    res.status(500).json({ error: "Server error" })
  })
})

// ─── GET /stream ──────────────────────────────────────────────────────────
// Architecture fichier temporaire (obligatoire pour DASH/Facebook) :
//   yt-dlp + ffmpeg merge → /tmp/uuid.mp4 complet → stream → suppression
//
// PAS de --postprocessor-args réencodage :
//   Le réencodage avec --postprocessor-args ne mappe pas l'audio correctement
//   → fichier avec vidéo seulement, pas d'audio
//   Le sélecteur H.264+AAC natif est suffisant et plus rapide
//
app.get("/stream", async (req, res) => {
  const { url, formatId, height, title, needsMerge } = req.query
  if (!url || !formatId) return res.status(400).json({ error: "url and formatId required" })

  const safeUrl      = String(url).replace(/"/g, "").trim()
  const safeFormatId = String(formatId).replace(/['";\s\\<>|&]/g, "").substring(0, 120)
  const safeHeight   = parseInt(height || "0") || 0
  const safeTitle    = String(title || "video").replace(/[^\w\s\-]/gi, "").replace(/\s+/g, "_").substring(0, 80)
  const platform     = detectPlatform(safeUrl)
  const shouldMerge  = needsMerge === "true"

  const selector = buildSelector(platform, safeFormatId, safeHeight, shouldMerge)
  const tmpFile  = join(tmpdir(), `dl_${randomUUID()}.mp4`)

  console.log(`[stream] platform=${platform} h=${safeHeight} selector="${selector}"`)
  console.log(`[stream] tmpFile=${tmpFile}`)

  const args = [
    "--no-playlist",
    ...platformArgs(platform),
    "-f", selector,
    "--merge-output-format", "mp4",
    "-o", tmpFile,
    safeUrl,
  ]

  const ytdlp = spawn("yt-dlp", args)
  let stderrLog = ""

  ytdlp.stderr.on("data", (d) => {
    const line = d.toString().trim()
    stderrLog += line + "\n"
    console.log("[stream] yt-dlp:", line)
  })

  let aborted = false
  req.on("close", () => {
    if (!res.writableEnded) {
      aborted = true
      ytdlp.kill()
      unlink(tmpFile).catch(() => {})
    }
  })

  ytdlp.on("close", async (code) => {
    if (aborted) return

    if (code !== 0) {
      console.error(`[stream] yt-dlp exited ${code}`, stderrLog.slice(-400))
      if (!res.headersSent) res.status(500).json({ error: "Download failed — check the URL is public" })
      unlink(tmpFile).catch(() => {})
      return
    }

    try {
      const stats = await stat(tmpFile)
      if (stats.size === 0) {
        console.error("[stream] Empty temp file")
        if (!res.headersSent) res.status(500).json({ error: "Empty file — format unavailable" })
        unlink(tmpFile).catch(() => {})
        return
      }

      console.log(`[stream] Ready: ${(stats.size / 1e6).toFixed(1)} MB → streaming to client`)

      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
      res.setHeader("Content-Type", "video/mp4")
      res.setHeader("Content-Length", stats.size)

      const rs = createReadStream(tmpFile)
      rs.pipe(res)
      rs.on("close", () => {
        unlink(tmpFile).catch(() => {})
        console.log("[stream] Sent & cleaned up")
      })
    } catch (err) {
      console.error("[stream] File error:", err)
      if (!res.headersSent) res.status(500).json({ error: "File not found after download" })
      unlink(tmpFile).catch(() => {})
    }
  })

  ytdlp.on("error", (err) => {
    console.error("[stream] spawn error:", err)
    if (!res.headersSent) res.status(500).json({ error: "Server error" })
    unlink(tmpFile).catch(() => {})
  })
})

const PORT = process.env.PORT || 8080
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`))

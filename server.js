import express from "express"
import cors from "cors"
import { spawn } from "child_process"

const app = express()
app.use(cors())
app.use(express.json())

// ─── Détection de plateforme ───────────────────────────────────────────────
function detectPlatform(url) {
  if (/tiktok\.com/i.test(url))             return "tiktok"
  if (/instagram\.com/i.test(url))          return "instagram"
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook"
  if (/youtube\.com|youtu\.be/i.test(url))  return "youtube"
  return "generic"
}

// ─── Extra args yt-dlp selon plateforme ───────────────────────────────────
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

  // ── 1. Formats avec vidéo ET audio fusionnés (TikTok, Instagram parfois) ──
  const mergedFormats = formats.filter(
    (f) =>
      f.vcodec && f.vcodec !== "none" &&
      f.acodec && f.acodec !== "none" &&
      f.url
  )

  // ── 2. Formats vidéo seuls, avec ou sans height (YouTube, Facebook, Instagram DASH) ──
  //   ✅ FIX: on ne filtre plus sur f.height — Facebook a height=null sur ses formats hd/sd
  const videoOnlyFormats = formats.filter(
    (f) =>
      f.vcodec && f.vcodec !== "none" &&
      (!f.acodec || f.acodec === "none") &&
      f.url
  )

  let qualities = []

  // ── Priorité aux formats fusionnés ──
  if (mergedFormats.length > 0) {
    const byKey = {}
    for (const f of mergedFormats) {
      // Clé : résolution si dispo, sinon format_note (ex: "HD", "SD"), sinon format_id
      const key = f.height
        ? `${f.height}p`
        : (f.format_note || f.format_id || "Best")
      if (!byKey[key] || (f.tbr || 0) > (byKey[key].tbr || 0)) {
        byKey[key] = { ...f, _key: key }
      }
    }
    qualities = Object.entries(byKey)
      .sort((a, b) => {
        const ha = parseInt(a[0]) || 0
        const hb = parseInt(b[0]) || 0
        if (hb !== ha) return hb - ha
        // HD > SD si pas de chiffre
        if (a[0].toLowerCase().includes("hd")) return -1
        if (b[0].toLowerCase().includes("hd")) return  1
        return 0
      })
      .map(([key, f]) => ({
        label:      key,
        height:     f.height || 0,
        formatId:   f.format_id,
        filesize:   f.filesize || f.filesize_approx || null,
        needsMerge: false,
      }))
  }

  // ── Formats vidéo seuls → needsMerge: true ──
  if (videoOnlyFormats.length > 0) {
    const byKey = {}
    for (const f of videoOnlyFormats) {
      // Clé : résolution si dispo, sinon format_note (HD/SD), sinon format_id
      const key = f.height
        ? `${f.height}p`
        : (f.format_note || f.format_id || "Best")
      if (!byKey[key] || (f.tbr || 0) > (byKey[key].tbr || 0)) {
        byKey[key] = { ...f, _key: key }
      }
    }
    const voQ = Object.entries(byKey)
      .sort((a, b) => {
        const ha = parseInt(a[0]) || 0
        const hb = parseInt(b[0]) || 0
        if (hb !== ha) return hb - ha
        if (a[0].toLowerCase().includes("hd")) return -1
        if (b[0].toLowerCase().includes("hd")) return  1
        return 0
      })
      .map(([key, f]) => ({
        label:      key,
        height:     f.height || 0,
        formatId:   f.format_id,
        filesize:   f.filesize || f.filesize_approx || null,
        needsMerge: true,   // ← fusion ffmpeg requise (audio séparé)
      }))
    qualities = [...qualities, ...voQ]
  }

  // ── Fallback absolu si rien trouvé ──
  if (qualities.length === 0) {
    // "bestvideo+bestaudio" garantit vidéo+son même sans connaître le formatId
    qualities = [{
      label:      "Best",
      height:     0,
      formatId:   "bestvideo",
      filesize:   null,
      needsMerge: true,    // ← TOUJOURS merger pour être sûr d'avoir le son
    }]
  }

  return qualities
}

// ─── GET / ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("DownloadAllInOne API — YouTube · TikTok · Instagram · Facebook")
})

// ─── POST /info ────────────────────────────────────────────────────────────
app.post("/info", (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "No URL provided" })

  const platform = detectPlatform(url)
  const safeUrl  = url.replace(/"/g, "").trim()

  const args = ["--no-playlist", "-j", ...platformArgs(platform), safeUrl]
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
      qualities.map((q) => `${q.label}(merge=${q.needsMerge})`).join(", ")
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

// ─── GET /stream ───────────────────────────────────────────────────────────
app.get("/stream", (req, res) => {
  const { url, formatId, title, needsMerge } = req.query
  if (!url || !formatId) return res.status(400).json({ error: "url and formatId required" })

  const safeUrl = String(url).replace(/"/g, "").trim()

  // ✅ Sanitize formatId : garde lettres, chiffres, tirets, underscores, points
  // (les format_id Facebook/TikTok ressemblent à "hd", "sd", "h264_540p_xxx-0")
  const safeFormatId = String(formatId)
    .replace(/['";\s\\<>|&]/g, "")
    .substring(0, 120)

  const safeTitle = String(title || "video")
    .replace(/[^\w\s\-]/gi, "")
    .replace(/\s+/g, "_")
    .substring(0, 80)

  const platform    = detectPlatform(safeUrl)
  const shouldMerge = needsMerge === "true"

  console.log(
    `[stream] platform=${platform} formatId="${safeFormatId}" merge=${shouldMerge}`
  )

  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
  res.setHeader("Content-Type", "video/mp4")

  const args = ["--no-playlist", ...platformArgs(platform)]

  if (shouldMerge) {
    // Vidéo seule + meilleur audio disponible → fusion ffmpeg → mp4
    // Fallbacks : m4a d'abord (compatible mp4), sinon n'importe quel audio
    args.push(
      "-f", `${safeFormatId}+bestaudio[ext=m4a]/${safeFormatId}+bestaudio`,
      "--merge-output-format", "mp4"
    )
  } else {
    // Format déjà fusionné (TikTok, Instagram merged) → direct
    args.push(
      "-f", safeFormatId,
      "--merge-output-format", "mp4"  // convertit si besoin (webm→mp4 etc.)
    )
  }

  args.push("-o", "-", safeUrl)

  const ytdlp = spawn("yt-dlp", args)

  ytdlp.stdout.pipe(res)
  ytdlp.stderr.on("data", (d) => console.log("[stream]", d.toString().trim()))
  ytdlp.on("error", (err) => {
    console.error("[stream] spawn error:", err)
    if (!res.headersSent) res.status(500).end()
  })
  ytdlp.on("close", (code) => {
    if (code !== 0) console.warn(`[stream] yt-dlp exited code ${code}`)
  })
  req.on("close", () => ytdlp.kill())
})

// ─── Dockerfile hint: pip3 install yt-dlp curl_cffi --break-system-packages
const PORT = process.env.PORT || 8080
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on port ${PORT}`)
)

import express from "express"
import cors from "cors"
import { exec, spawn } from "child_process"

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

// ─── Construction des qualités selon la plateforme ────────────────────────
function buildQualities(info, platform) {
  const formats = info.formats || []

  // Formats avec vidéo ET audio déjà fusionnés (TikTok, Instagram, Facebook)
  const mergedFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url
  )

  // Formats vidéo seuls (YouTube — nécessitent fusion ffmpeg)
  const videoOnlyFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") && f.url && f.height
  )

  let qualities = []

  // ── Formats fusionnés (TikTok, Instagram, Facebook) ──
  if (mergedFormats.length > 0) {
    const byKey = {}
    for (const f of mergedFormats) {
      const key = f.height > 0
        ? `${f.height}p`
        : (f.format_note || f.format_id || "Best")
      if (!byKey[key] || (f.tbr || 0) > (byKey[key].tbr || 0)) {
        byKey[key] = { ...f, _key: key }
      }
    }
    qualities = Object.entries(byKey)
      .sort((a, b) => (parseInt(b[0]) || 0) - (parseInt(a[0]) || 0))
      .map(([key, f]) => ({
        label:      key,
        height:     f.height || 0,
        formatId:   f.format_id,   // ← gardé intact, pas de strip
        filesize:   f.filesize || f.filesize_approx || null,
        needsMerge: false,         // déjà audio+vidéo
      }))
  }

  // ── Formats vidéo seuls (YouTube) ──
  if (videoOnlyFormats.length > 0) {
    const byHeight = {}
    for (const f of videoOnlyFormats) {
      const h = f.height
      if (!byHeight[h] || (f.tbr || 0) > (byHeight[h].tbr || 0)) byHeight[h] = f
    }
    const ytQ = Object.entries(byHeight)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([height, f]) => ({
        label:      `${height}p`,
        height:     Number(height),
        formatId:   f.format_id,
        filesize:   f.filesize || f.filesize_approx || null,
        needsMerge: true,          // fusion ffmpeg requise
      }))
    qualities = [...qualities, ...ytQ]
  }

  // ── Fallback : rien trouvé ──
  if (qualities.length === 0) {
    qualities = [{ label: "Best", height: 0, formatId: "best", filesize: null, needsMerge: false }]
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

  // Args de base
  const args = ["--no-playlist", "-j"]

  // Instagram : user-agent mobile
  if (platform === "instagram") {
    args.push("--add-header", "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")
  }

  args.push(safeUrl)
  console.log(`[info] platform=${platform} args=${args.join(" ")}`)

  const proc = spawn("yt-dlp", args, { timeout: 45000 })
  let stdout = ""
  let stderr = ""

  proc.stdout.on("data", (d) => { stdout += d.toString() })
  proc.stderr.on("data", (d) => { stderr += d.toString() })

  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`[info] yt-dlp exit ${code}:`, stderr.slice(0, 400))
      let msg = "Unable to fetch this video"
      if (stderr.includes("Private") || stderr.includes("private"))         msg = "This video is private or inaccessible"
      else if (stderr.includes("not a video"))                               msg = "This link does not point to a video"
      else if (platform === "instagram" && stderr.includes("login"))        msg = "This Instagram post requires login"
      else if (platform === "tiktok"    && stderr.includes("Unable"))       msg = "TikTok video inaccessible — make sure the link is public"
      else if (platform === "facebook"  && stderr.includes("login"))        msg = "This Facebook video is private"
      return res.status(500).json({ error: msg })
    }

    let info
    try   { info = JSON.parse(stdout) }
    catch { return res.status(500).json({ error: "Parsing error" }) }

    const qualities = buildQualities(info, platform)
    console.log(`[info] ${qualities.length} quality(ies) — needsMerge=${qualities.map(q=>q.needsMerge)}`)

    res.json({
      title:       info.title    || "Video",
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

  // ✅ FIX CRITIQUE : on garde les underscores, tirets, points, chiffres, lettres
  // Les format_id TikTok ressemblent à : "h264_540p_4193159-0" ou "playAddr"
  // L'ancien regex /[^a-z0-9+\-]/gi supprimait les underscores → formatId corrompu → 0B
  const safeFormatId = String(formatId)
    .replace(/['";\s\\<>|&]/g, "")  // seulement les chars vraiment dangereux
    .substring(0, 120)

  const safeTitle = String(title || "video")
    .replace(/[^\w\s\-]/gi, "")
    .replace(/\s+/g, "_")
    .substring(0, 80)

  const platform = detectPlatform(safeUrl)

  // ✅ FIX : needsMerge vient comme string "true"/"false" depuis l'URL query
  const shouldMerge = needsMerge === "true"

  console.log(`[stream] platform=${platform} formatId="${safeFormatId}" merge=${shouldMerge}`)

  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
  res.setHeader("Content-Type", "video/mp4")

  const args = ["--no-playlist"]

  // Instagram : user-agent mobile
  if (platform === "instagram") {
    args.push("--add-header", "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")
  }

  if (shouldMerge) {
    // YouTube : vidéo seule + audio séparé → fusion ffmpeg
    args.push(
      "-f", `${safeFormatId}+bestaudio[ext=m4a]/bestaudio`,
      "--merge-output-format", "mp4"
    )
  } else {
    // TikTok / Instagram / Facebook : format déjà fusionné → direct
    args.push("-f", safeFormatId)
    // Si le format n'est pas déjà mp4, on convertit à la volée
    args.push("--merge-output-format", "mp4")
  }

  args.push("-o", "-", safeUrl)

  const ytdlp = spawn("yt-dlp", args)

  ytdlp.stdout.pipe(res)
  ytdlp.stderr.on("data", (d) => console.log("[stream] yt-dlp:", d.toString().trim()))
  ytdlp.on("error", (err) => {
    console.error("[stream] spawn error:", err)
    if (!res.headersSent) res.status(500).end()
  })
  ytdlp.on("close", (code) => {
    if (code !== 0) console.warn(`[stream] yt-dlp exited code ${code}`)
  })
  req.on("close", () => ytdlp.kill())
})

const PORT = process.env.PORT || 8080
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`))

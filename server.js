import express from "express"
import cors from "cors"
import { exec, spawn } from "child_process"

const app = express()
app.use(cors())
app.use(express.json())

// ─── Détection de plateforme ───────────────────────────────────────────────
function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return "tiktok"
  if (/instagram\.com/i.test(url)) return "instagram"
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook"
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube"
  return "generic"
}

// ─── Construction des qualités selon la plateforme ────────────────────────
function buildQualities(info, platform) {
  const formats = info.formats || []

  // TikTok / Instagram / Facebook : souvent un seul format "complet" (vidéo+audio)
  // On cherche d'abord les formats avec vidéo ET audio intégrés
  const mergedFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url
  )

  // Formats vidéo seuls (YouTube style, nécessitent fusion ffmpeg)
  const videoOnlyFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") && f.url && f.height
  )

  let qualities = []

  if (mergedFormats.length > 0) {
    // Plateforme avec formats fusionnés (TikTok, Instagram, Facebook)
    const byHeight = {}
    for (const f of mergedFormats) {
      const h = f.height || 0
      const key = h > 0 ? `${h}p` : (f.format_note || f.format_id || "Meilleure qualité")
      if (!byHeight[key] || (f.tbr || 0) > (byHeight[key].tbr || 0)) {
        byHeight[key] = { ...f, _key: key }
      }
    }
    qualities = Object.entries(byHeight)
      .sort((a, b) => {
        const ha = parseInt(a[0]) || 0
        const hb = parseInt(b[0]) || 0
        return hb - ha
      })
      .map(([key, f]) => ({
        label: key,
        height: f.height || 0,
        formatId: f.format_id,
        filesize: f.filesize || f.filesize_approx || null,
        needsMerge: false,
      }))
  }

  if (videoOnlyFormats.length > 0) {
    // YouTube style : formats vidéo seuls à fusionner avec audio
    const byHeight = {}
    for (const f of videoOnlyFormats) {
      const h = f.height
      if (!byHeight[h] || (f.tbr || 0) > (byHeight[h].tbr || 0)) {
        byHeight[h] = f
      }
    }
    const ytQualities = Object.entries(byHeight)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([height, f]) => ({
        label: `${height}p`,
        height: Number(height),
        formatId: f.format_id,
        filesize: f.filesize || f.filesize_approx || null,
        needsMerge: true,
      }))
    qualities = [...qualities, ...ytQualities]
  }

  // Fallback : si toujours vide, prendre "best"
  if (qualities.length === 0) {
    qualities = [{
      label: "Meilleure qualité",
      height: 0,
      formatId: "best",
      filesize: null,
      needsMerge: false,
    }]
  }

  return qualities
}

// ─── Route racine ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Downloader API running — YouTube, TikTok, Instagram, Facebook")
})

// ─── Route /info ───────────────────────────────────────────────────────────
app.post("/info", (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "No URL provided" })

  const platform = detectPlatform(url)
  const safeUrl = url.replace(/"/g, "")

  // Options spécifiques par plateforme
  let extraArgs = "--no-playlist"
  if (platform === "instagram") {
    // Instagram peut nécessiter un user-agent différent
    extraArgs += " --add-header \"User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15\""
  }

  exec(
    `yt-dlp -j ${extraArgs} "${safeUrl}"`,
    { timeout: 45000 },
    (error, stdout, stderr) => {
      if (error) {
        console.error("yt-dlp error:", stderr || error.message)

        // Messages d'erreur clairs selon la plateforme
        let msg = "Impossible de récupérer la vidéo"
        if (stderr?.includes("Private") || stderr?.includes("private")) {
          msg = "Cette vidéo est privée ou inaccessible"
        } else if (stderr?.includes("not a video")) {
          msg = "Le lien ne pointe pas vers une vidéo"
        } else if (platform === "instagram" && stderr?.includes("login")) {
          msg = "Cette publication Instagram nécessite d'être connecté"
        } else if (platform === "tiktok" && stderr?.includes("Unable")) {
          msg = "Vidéo TikTok inaccessible — vérifie que le lien est public"
        } else if (platform === "facebook" && stderr?.includes("login")) {
          msg = "Cette vidéo Facebook est privée ou nécessite une connexion"
        }

        return res.status(500).json({ error: msg })
      }

      let info
      try { info = JSON.parse(stdout) }
      catch { return res.status(500).json({ error: "Erreur de parsing de la réponse" }) }

      const qualities = buildQualities(info, platform)

      res.json({
        title: info.title || "Vidéo",
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        uploader: info.uploader || info.channel || info.creator || null,
        originalUrl: url,
        platform,
        qualities,
      })
    }
  )
})

// ─── Route /stream ─────────────────────────────────────────────────────────
app.get("/stream", (req, res) => {
  const { url, formatId, title, needsMerge } = req.query
  if (!url || !formatId) return res.status(400).json({ error: "url et formatId requis" })

  const safeUrl = String(url).replace(/"/g, "")
  const safeFormatId = String(formatId).replace(/[^a-z0-9+\-]/gi, "")
  const safeTitle = String(title || "video").replace(/[^\w\s\-]/gi, "").substring(0, 80)
  const platform = detectPlatform(safeUrl)

  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
  res.setHeader("Content-Type", "video/mp4")

  let ytdlpArgs = ["--no-playlist"]

  if (safeFormatId === "best" || needsMerge === "false") {
    // Format déjà fusionné (TikTok, Instagram, Facebook) — pas besoin de ffmpeg merge
    ytdlpArgs.push("-f", safeFormatId)
  } else {
    // YouTube style : fusionner vidéo + meilleur audio
    const format = `${safeFormatId}+bestaudio[ext=m4a]/bestaudio`
    ytdlpArgs.push("-f", format, "--merge-output-format", "mp4")
  }

  // User-agent spécifique Instagram
  if (platform === "instagram") {
    ytdlpArgs.push(
      "--add-header",
      "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    )
  }

  ytdlpArgs.push("-o", "-", safeUrl)

  console.log(`[stream] platform=${platform} format=${safeFormatId} merge=${needsMerge}`)

  const ytdlp = spawn("yt-dlp", ytdlpArgs)

  ytdlp.stdout.pipe(res)
  ytdlp.stderr.on("data", (d) => console.log("yt-dlp:", d.toString().trim()))
  ytdlp.on("error", (err) => {
    console.error("spawn error:", err)
    if (!res.headersSent) res.status(500).end()
  })
  ytdlp.on("close", (code) => {
    if (code !== 0) console.warn(`yt-dlp exited with code ${code}`)
  })
  req.on("close", () => ytdlp.kill())
})

const PORT = process.env.PORT || 8080
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`))

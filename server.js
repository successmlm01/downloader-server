import express from "express"
import cors from "cors"
import { spawn } from "child_process"
import { randomUUID } from "crypto"
import { unlink, stat } from "fs/promises"
import { createReadStream, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

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

// ─── Args supplémentaires par plateforme ──────────────────────────────────
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
    (f) =>
      f.vcodec && f.vcodec !== "none" &&
      f.acodec && f.acodec !== "none" &&
      f.url
  )

  // Formats vidéo seuls — ✅ height optionnel (Facebook hd/sd n'ont pas height)
  const videoOnlyFormats = formats.filter(
    (f) =>
      f.vcodec && f.vcodec !== "none" &&
      (!f.acodec || f.acodec === "none") &&
      f.url
  )

  let qualities = []

  // ── Formats fusionnés en priorité ──
  if (mergedFormats.length > 0) {
    const byKey = {}
    for (const f of mergedFormats) {
      const key = f.height
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
        formatId:   f.format_id,
        filesize:   f.filesize || f.filesize_approx || null,
        needsMerge: false,
      }))
  }

  // ── Formats vidéo seuls → needsMerge: true ──
  if (videoOnlyFormats.length > 0) {
    const byKey = {}
    for (const f of videoOnlyFormats) {
      const key = f.height
        ? `${f.height}p`
        : (f.format_note || f.format_id || "Video")
      if (!byKey[key] || (f.tbr || 0) > (byKey[key].tbr || 0)) {
        byKey[key] = { ...f, _key: key }
      }
    }
    const voQ = Object.entries(byKey)
      .sort((a, b) => {
        const ha = parseInt(a[0]) || 0
        const hb = parseInt(b[0]) || 0
        if (hb !== ha) return hb - ha
        // HD avant SD si pas de chiffre
        if (a[0] === "hd" || a[0].toLowerCase().includes("hd")) return -1
        if (b[0] === "hd" || b[0].toLowerCase().includes("hd")) return  1
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

  // ── Fallback ──
  if (qualities.length === 0) {
    qualities = [{
      label:      "Best",
      height:     0,
      formatId:   "bestvideo",
      filesize:   null,
      needsMerge: true,
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
// Architecture fichier temporaire :
//   1. yt-dlp télécharge + merge dans /tmp/uuid.mp4
//   2. Une fois terminé, on streame le fichier vers le client
//   3. On supprime le fichier temp
//
// Pourquoi pas stdout pipe ?
//   Facebook DASH: yt-dlp télécharge segments séparés puis les fusionnent via ffmpeg.
//   ffmpeg ne peut pas écrire un mp4 valide sur stdout pendant ce process
//   (il a besoin d'écrire le moov atom à la fin du fichier).
//   Résultat avec pipe: fichier .ts corrompu sans piste vidéo reconnue.
//
app.get("/stream", async (req, res) => {
  const { url, formatId, title, needsMerge } = req.query
  if (!url || !formatId) return res.status(400).json({ error: "url and formatId required" })

  const safeUrl = String(url).replace(/"/g, "").trim()

  // Sanitize formatId: garder lettres, chiffres, tirets, underscores, points
  const safeFormatId = String(formatId)
    .replace(/['";\s\\<>|&]/g, "")
    .substring(0, 120)

  const safeTitle = String(title || "video")
    .replace(/[^\w\s\-]/gi, "")
    .replace(/\s+/g, "_")
    .substring(0, 80)

  const platform    = detectPlatform(safeUrl)
  const shouldMerge = needsMerge === "true"

  // Fichier temporaire unique
  const tmpFile = join(tmpdir(), `dl_${randomUUID()}.mp4`)

  console.log(
    `[stream] platform=${platform} formatId="${safeFormatId}" merge=${shouldMerge} tmp=${tmpFile}`
  )

  const args = ["--no-playlist", ...platformArgs(platform)]

  if (shouldMerge) {
    // Vidéo seule + audio séparé → fusion ffmpeg → mp4
    args.push(
      "-f", `${safeFormatId}+bestaudio[ext=m4a]/${safeFormatId}+bestaudio`,
      "--merge-output-format", "mp4"
    )
  } else {
    // Format déjà fusionné (TikTok, Instagram merged)
    args.push(
      "-f", safeFormatId,
      "--merge-output-format", "mp4"
    )
  }

  // ✅ Écriture dans fichier temp (pas stdout)
  args.push("-o", tmpFile, safeUrl)

  const ytdlp = spawn("yt-dlp", args)
  let stderr = ""

  ytdlp.stderr.on("data", (d) => {
    const line = d.toString().trim()
    stderr += line + "\n"
    console.log("[stream] yt-dlp:", line)
  })

  // Gérer l'annulation client
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
      console.error(`[stream] yt-dlp exited ${code}`)
      if (!res.headersSent) res.status(500).json({ error: "Download failed" })
      unlink(tmpFile).catch(() => {})
      return
    }

    // Vérifier que le fichier existe et n'est pas vide
    try {
      const stats = await stat(tmpFile)
      if (stats.size === 0) {
        console.error("[stream] Temp file is empty!")
        if (!res.headersSent) res.status(500).json({ error: "Empty file — format may be unsupported" })
        unlink(tmpFile).catch(() => {})
        return
      }

      console.log(`[stream] File ready: ${(stats.size / 1e6).toFixed(1)} MB, streaming...`)

      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
      res.setHeader("Content-Type", "video/mp4")
      res.setHeader("Content-Length", stats.size)

      const readStream = createReadStream(tmpFile)
      readStream.pipe(res)
      readStream.on("close", () => {
        unlink(tmpFile).catch(() => {})
        console.log(`[stream] Done, temp file deleted`)
      })
    } catch (err) {
      console.error("[stream] Error reading temp file:", err)
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
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on port ${PORT}`)
)

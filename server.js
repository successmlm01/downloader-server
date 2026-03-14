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
  if (platform === "instagram") {
    return ["--add-header", "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"]
  }
  return []
}

// ─── Construction des qualités ────────────────────────────────────────────
function buildQualities(info, platform) {
  const formats = info.formats || []

  // Formats avec vidéo ET audio fusionnés
  const mergedFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url
  )
  // Formats vidéo seuls
  const videoOnlyFormats = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") && f.url
  )

  let qualities = []

  // ── Formats merged (TikTok, Instagram, Facebook merged) ──
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
        filesize: f.filesize || f.filesize_approx || null,
        needsMerge: false,
      }))
  }

  // ── Formats vidéo seuls (YouTube, Facebook DASH) ──
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
        filesize: f.filesize || f.filesize_approx || null,
        needsMerge: true,
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
      if (stderr.includes("Private") || stderr.includes("private")) msg = "This video is private or inaccessible"
      else if (stderr.includes("not a video"))                       msg = "This link does not point to a video"
      else if (platform === "instagram" && stderr.includes("login")) msg = "This Instagram post requires login"
      else if (platform === "tiktok"    && stderr.includes("Unable"))msg = "TikTok video inaccessible — make sure the link is public"
      else if (platform === "facebook"  && stderr.includes("login")) msg = "This Facebook video requires login"
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
//
// STRATÉGIE PAR PLATEFORME :
//
//  Facebook / generic (URLs signées qui expirent, pas d'audio-only):
//    → yt-dlp -f "best[vcodec^=avc][height<=H]/best[height<=H]/best"
//      = format merged (vidéo+audio déjà ensemble)
//    → ffmpeg -map 0:v:0 -map 0:a:0 remuxe proprement en mp4
//
//  YouTube (format_id stable, audio-only disponible):
//    → yt-dlp -f "formatId+bestaudio[ext=m4a]/formatId+bestaudio"
//    → ffmpeg -map 0:v:0 -map 1:a:0 merge vidéo+audio
//
//  TikTok / Instagram merged (format_id direct, déjà vidéo+audio):
//    → yt-dlp -f formatId directement
//    → ffmpeg -map 0:v:0 -map 0:a:0 remuxe
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

  const uid    = randomUUID()
  const rawTmp = join(tmpdir(), `dl_${uid}_raw.mp4`)   // téléchargement brut
  const outTmp = join(tmpdir(), `dl_${uid}_out.mp4`)   // fichier final remuxé
  const cleanup = () => Promise.all([rawTmp, outTmp].map((f) => unlink(f).catch(() => {})))

  console.log(`[stream] platform=${platform} h=${safeHeight} merge=${shouldMerge} uid=${uid}`)

  try {

    if (platform === "facebook" || platform === "generic") {
      // ── Facebook : télécharger le format merged (vidéo+audio ensemble) ──
      // Pas de format audio-only disponible sur Facebook
      // On prend le meilleur format merged H264, puis on remuxe avec ffmpeg
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

      // Remuxer avec ffmpeg en forçant le mapping explicite vidéo+audio
      console.log(`[stream] ffmpeg remux (Facebook merged → mp4)`)
      await run("ffmpeg", [
        "-y",
        "-i", rawTmp,
        "-map", "0:v:0",       // stream vidéo
        "-map", "0:a:0",       // stream audio
        "-c:v", "copy",        // pas de réencodage vidéo
        "-c:a", "aac",         // audio → AAC (compatible QuickTime/iOS)
        "-movflags", "+faststart",
        outTmp,
      ])

    } else if (shouldMerge) {
      // ── YouTube / Instagram vidéo-only : 2 fichiers séparés ────────────
      // Étape 1 : vidéo
      const videoTmp = join(tmpdir(), `dl_${uid}_v.mp4`)
      const audioTmp = join(tmpdir(), `dl_${uid}_a.m4a`)

      const vSel = [
        `${safeFormatId}`,
      ].join("/")
      console.log(`[stream] Step 1 video: ${vSel}`)
      await run("yt-dlp", ["--no-playlist", ...platformArgs(platform), "-f", vSel, "-o", videoTmp, safeUrl])

      // Étape 2 : audio
      const aSel = "bestaudio[ext=m4a]/bestaudio"
      console.log(`[stream] Step 2 audio: ${aSel}`)
      await run("yt-dlp", ["--no-playlist", ...platformArgs(platform), "-f", aSel, "-o", audioTmp, safeUrl])

      // Étape 3 : merge ffmpeg explicite
      console.log(`[stream] Step 3 ffmpeg merge`)
      await run("ffmpeg", [
        "-y",
        "-i", videoTmp,
        "-i", audioTmp,
        "-map", "0:v:0",   // vidéo du fichier 0
        "-map", "1:a:0",   // audio du fichier 1
        "-c:v", "copy",
        "-c:a", "aac",
        "-movflags", "+faststart",
        outTmp,
      ])

      // Supprimer les fichiers intermédiaires
      await Promise.all([unlink(videoTmp).catch(() => {}), unlink(audioTmp).catch(() => {})])

    } else {
      // ── TikTok / Instagram merged : téléchargement direct ──────────────
      const sel = safeFormatId
      console.log(`[stream] Merged format: ${sel}`)
      await run("yt-dlp", ["--no-playlist", ...platformArgs(platform), "-f", sel, "-o", rawTmp, safeUrl])

      // Remuxer pour garantir mp4 valide avec audio
      await run("ffmpeg", [
        "-y",
        "-i", rawTmp,
        "-map", "0:v:0",
        "-map", "0:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-movflags", "+faststart",
        outTmp,
      ])
    }

    // ── Stream le fichier final ───────────────────────────────────────────
    const stats = await stat(outTmp)
    if (stats.size === 0) throw new Error("Output file is empty")

    console.log(`[stream] Ready: ${(stats.size / 1e6).toFixed(1)} MB → streaming`)

    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
    res.setHeader("Content-Type", "video/mp4")
    res.setHeader("Content-Length", stats.size)

    const rs = createReadStream(outTmp)
    rs.pipe(res)
    rs.on("close", () => { cleanup(); console.log("[stream] Sent & cleaned up") })

  } catch (err) {
    console.error("[stream] Error:", err.message)
    cleanup()
    if (!res.headersSent) res.status(500).json({ error: "Download failed — " + err.message.split("\n")[0] })
  }
})

const PORT = process.env.PORT || 8080
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`))

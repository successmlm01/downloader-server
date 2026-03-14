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

// ─── Utilitaire : exécuter une commande et retourner stdout ───────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts)
    let stdout = ""
    let stderr = ""
    proc.stdout?.on("data", (d) => { stdout += d.toString() })
    proc.stderr?.on("data", (d) => {
      stderr += d.toString()
      console.log(`[${cmd}]`, d.toString().trim())
    })
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-300)}`))
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
// Architecture : 2 téléchargements séparés + merge ffmpeg explicite
//
//   Étape 1 : yt-dlp -f "bestvideo[vcodec^=avc]..."  → /tmp/uuid_v.mp4
//   Étape 2 : yt-dlp -f "bestaudio"                  → /tmp/uuid_a.m4a
//   Étape 3 : ffmpeg -i video -i audio
//                    -map 0:v:0 -map 1:a:0            ← mapping EXPLICITE
//                    -c:v copy -c:a aac               → /tmp/uuid_out.mp4
//   Étape 4 : stream le fichier final → client
//   Étape 5 : supprimer les 3 fichiers temp
//
// Pourquoi cette approche :
//   - Le merge interne yt-dlp ne garantit pas l'inclusion de l'audio
//     quand l'ext de l'audio Facebook n'est pas reconnu comme compatible
//   - ffmpeg avec -map explicite garantit que vidéo ET audio sont présents
//   - -c:a aac réencode l'audio si nécessaire pour compatibilité QuickTime
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

  const uid      = randomUUID()
  const videoTmp = join(tmpdir(), `dl_${uid}_v.mp4`)
  const audioTmp = join(tmpdir(), `dl_${uid}_a.m4a`)
  const outTmp   = join(tmpdir(), `dl_${uid}_out.mp4`)

  const cleanup  = () => Promise.all([videoTmp, audioTmp, outTmp].map((f) => unlink(f).catch(() => {})))

  console.log(`[stream] platform=${platform} h=${safeHeight} merge=${shouldMerge} uid=${uid}`)

  try {
    if (!shouldMerge) {
      // ── TikTok / Instagram merged : téléchargement direct ──────────────
      console.log(`[stream] merged format, downloading directly`)
      await run("yt-dlp", [
        "--no-playlist",
        ...platformArgs(platform),
        "-f", safeFormatId,
        "--merge-output-format", "mp4",
        "-o", outTmp,
        safeUrl,
      ])
    } else {
      // ── Étape 1 : télécharger la vidéo (H.264 préféré) ─────────────────
      const h = safeHeight
      const hFilter = h > 0 ? `[height<=${h}]` : ""

      const videoSelector = [
        `bestvideo[vcodec^=avc]${h > 0 ? `[height=${h}]` : ""}`,
        `bestvideo[vcodec^=avc]${hFilter}`,
        `bestvideo${hFilter}`,
        `bestvideo`,
      ].join("/")

      console.log(`[stream] Step 1 — video: ${videoSelector}`)
      await run("yt-dlp", [
        "--no-playlist",
        ...platformArgs(platform),
        "-f", videoSelector,
        "-o", videoTmp,
        safeUrl,
      ])

      // ── Étape 2 : télécharger l'audio séparément ───────────────────────
      const audioSelector = "bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio"
      console.log(`[stream] Step 2 — audio: ${audioSelector}`)
      await run("yt-dlp", [
        "--no-playlist",
        ...platformArgs(platform),
        "-f", audioSelector,
        "-o", audioTmp,
        safeUrl,
      ])

      // ── Étape 3 : merge ffmpeg avec mapping EXPLICITE ───────────────────
      console.log(`[stream] Step 3 — ffmpeg merge with explicit -map`)
      await run("ffmpeg", [
        "-y",
        "-i", videoTmp,   // input 0 = vidéo
        "-i", audioTmp,   // input 1 = audio
        "-map", "0:v:0",  // prendre stream vidéo du fichier 0
        "-map", "1:a:0",  // prendre stream audio du fichier 1
        "-c:v", "copy",   // copier vidéo sans réencodage (rapide)
        "-c:a", "aac",    // réencoder audio en AAC (compatible QuickTime/iOS)
        "-movflags", "+faststart", // moov atom en début = lecture immédiate
        outTmp,
      ])
    }

    // ── Étape 4 : vérifier et streamer ────────────────────────────────────
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

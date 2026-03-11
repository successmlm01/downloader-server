import express from "express"
import cors from "cors"
import { exec, spawn } from "child_process"

const app = express()
app.use(cors())
app.use(express.json())

app.get("/", (req, res) => {
  res.send("Downloader API running")
})

app.post("/info", (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "No URL provided" })

  const safeUrl = url.replace(/"/g, "")
  exec(`yt-dlp -j --no-playlist "${safeUrl}"`, { timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error("yt-dlp error:", stderr || error.message)
      return res.status(500).json({ error: "Impossible de récupérer la vidéo" })
    }
    let info
    try { info = JSON.parse(stdout) }
    catch { return res.status(500).json({ error: "Erreur de parsing" }) }

    const allFormats = info.formats || []
    const videoFormats = allFormats.filter((f) => f.height && f.vcodec && f.vcodec !== "none" && f.url)

    const byHeight = {}
    for (const f of videoFormats) {
      const h = f.height
      if (!byHeight[h] || (f.tbr || 0) > (byHeight[h].tbr || 0)) {
        byHeight[h] = f
      }
    }

    const qualities = Object.entries(byHeight)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([height, f]) => ({
        label: `${height}p`,
        height: Number(height),
        formatId: f.format_id,
        filesize: f.filesize || f.filesize_approx || null,
      }))

    res.json({
      title: info.title || "Vidéo",
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      uploader: info.uploader || null,
      originalUrl: url,
      qualities,
    })
  })
})

// Stream vidéo + audio fusionnés par yt-dlp+ffmpeg directement vers le client
app.get("/stream", (req, res) => {
  const { url, formatId, title } = req.query
  if (!url || !formatId) return res.status(400).json({ error: "url et formatId requis" })

  const safeUrl = String(url).replace(/"/g, "")
  const safeFormatId = String(formatId).replace(/[^a-z0-9+\-]/gi, "")
  const safeTitle = String(title || "video").replace(/[^\w\s\-]/gi, "").substring(0, 80)

  // yt-dlp fusionne automatiquement la vidéo avec le meilleur audio dispo
  const format = `${safeFormatId}+bestaudio[ext=m4a]/bestaudio`

  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
  res.setHeader("Content-Type", "video/mp4")

  const ytdlp = spawn("yt-dlp", [
    "--no-playlist",
    "-f", format,
    "--merge-output-format", "mp4",
    "-o", "-",
    safeUrl
  ])

  ytdlp.stdout.pipe(res)
  ytdlp.stderr.on("data", (d) => console.log("yt-dlp:", d.toString()))
  ytdlp.on("error", (err) => {
    console.error("spawn error:", err)
    if (!res.headersSent) res.status(500).end()
  })
  req.on("close", () => ytdlp.kill())
})

const PORT = process.env.PORT || 8080
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`))

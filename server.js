import express from "express"
import cors from "cors"
import { exec } from "child_process"

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
  const command = `yt-dlp -j --no-playlist "${safeUrl}"`

  exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error("yt-dlp error:", stderr || error.message)
      return res.status(500).json({ error: "Impossible de récupérer la vidéo" })
    }

    let info
    try { info = JSON.parse(stdout) }
    catch { return res.status(500).json({ error: "Erreur de parsing" }) }

    const allFormats = info.formats || []

    // Formats progressifs = vidéo + audio dans le même fichier
    const progressive = allFormats.filter(
      (f) =>
        f.url &&
        f.vcodec && f.vcodec !== "none" &&
        f.acodec && f.acodec !== "none" &&
        f.height
    )

    // Une qualité par résolution, garder le meilleur bitrate
    const byHeight = {}
    for (const f of progressive) {
      const h = f.height
      if (!byHeight[h] || (f.filesize || 0) > (byHeight[h].filesize || 0)) {
        byHeight[h] = f
      }
    }

    let qualities = Object.entries(byHeight)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([height, f]) => ({
        label: `${height}p`,
        height: Number(height),
        url: f.url,
        filesize: f.filesize || null,
        hasAudio: true,
      }))

    // Fallback si aucun format progressif
    if (qualities.length === 0) {
      const fallback = allFormats
        .filter((f) => f.url && f.height)
        .sort((a, b) => (b.height || 0) - (a.height || 0))
      const seen = {}
      for (const f of fallback) {
        if (!seen[f.height]) {
          seen[f.height] = true
          qualities.push({
            label: `${f.height}p`,
            height: f.height,
            url: f.url,
            filesize: f.filesize || null,
            hasAudio: f.acodec && f.acodec !== "none",
          })
        }
      }
    }

    res.json({
      title: info.title || "Vidéo",
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      uploader: info.uploader || null,
      qualities,
    })
  })
})

const PORT = process.env.PORT || 8080
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`)
})

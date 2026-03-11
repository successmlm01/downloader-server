import express from "express"
import cors from "cors"
import { exec } from "child_process"

const app = express()

app.use(cors())
app.use(express.json())

app.get("/", (req, res) => {
  res.send("Downloader API running")
})

// Route pour récupérer les formats disponibles
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
    try {
      info = JSON.parse(stdout)
    } catch {
      return res.status(500).json({ error: "Erreur de parsing" })
    }

    // Construire la liste des qualités disponibles
    const formats = (info.formats || [])
      .filter((f) => f.ext === "mp4" && f.height && f.url)
      .reduce((acc, f) => {
        const key = f.height
        if (!acc[key] || f.filesize > (acc[key].filesize || 0)) {
          acc[key] = f
        }
        return acc
      }, {})

    const qualities = Object.entries(formats)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([height, f]) => ({
        label: `${height}p`,
        height: Number(height),
        url: f.url,
        filesize: f.filesize || null,
      }))

    // Fallback si aucun mp4
    if (qualities.length === 0) {
      const fallback = (info.formats || []).find((f) => f.url)
      if (fallback) {
        qualities.push({ label: "Auto", height: 0, url: fallback.url, filesize: null })
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

// Route de téléchargement direct (garde la compatibilité)
app.post("/download", (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "No URL provided" })

  const safeUrl = url.replace(/"/g, "")
  const command = `yt-dlp -j --no-playlist "${safeUrl}"`

  exec(command, { timeout: 30000 }, (error, stdout) => {
    if (error) return res.status(500).json({ error: "Failed to fetch video info" })

    let info
    try { info = JSON.parse(stdout) } catch { return res.status(500).json({ error: "Parse error" }) }

    const formats = (info.formats || []).filter((f) => f.ext === "mp4" && f.url)
    const best = formats.length > 0 ? formats[formats.length - 1] : (info.formats || []).find((f) => f.url)

    if (!best) return res.status(500).json({ error: "No downloadable format found" })

    res.json({
      title: info.title || "Video",
      thumbnail: info.thumbnail || null,
      download: best.url,
      ext: best.ext || "mp4",
    })
  })
})

const PORT = process.env.PORT || 8080
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`)
})

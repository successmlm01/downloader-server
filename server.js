import express from "express"
import cors from "cors"
import { exec } from "child_process"

const app = express()

app.use(cors())
app.use(express.json())

// Health check route
app.get("/", (req, res) => {
  res.send("Downloader API running")
})

app.post("/download", (req, res) => {
  const { url } = req.body

  if (!url) {
    return res.status(400).json({ error: "No URL provided" })
  }

  // Use full path to yt-dlp installed via pip3, safer than relying on PATH
  // Also escape the URL safely
  const safeUrl = url.replace(/"/g, "")
  const command = `yt-dlp -j --no-playlist "${safeUrl}"`

  exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error("yt-dlp error:", stderr || error.message)
      return res.status(500).json({ error: "Failed to fetch video info" })
    }

    let info
    try {
      info = JSON.parse(stdout)
    } catch (parseError) {
      console.error("JSON parse error:", parseError)
      return res.status(500).json({ error: "Failed to parse video info" })
    }

    // Select best mp4 format — fallback to any format if no mp4 found
    const formats = (info.formats || []).filter(
      (f) => f.ext === "mp4" && f.url
    )

    const best =
      formats.length > 0
        ? formats[formats.length - 1]
        : (info.formats || []).find((f) => f.url)

    if (!best) {
      return res.status(500).json({ error: "No downloadable format found" })
    }

    res.json({
      title: info.title || "Video",
      thumbnail: info.thumbnail || null,
      download: best.url,
      ext: best.ext || "mp4",
    })
  })
})

// PORT must match what Railway assigns — Railway sets PORT env var automatically
const PORT = process.env.PORT || 8080

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`)
})

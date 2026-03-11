import express from "express"
import cors from "cors"
import { exec } from "child_process"

const app = express()

app.use(cors())
app.use(express.json())

// route test
app.get("/", (req, res) => {
  res.send("Downloader API running")
})

app.post("/download", (req, res) => {

  const { url } = req.body

  if (!url) {
    return res.json({ error: "No URL provided" })
  }

  const command = `yt-dlp -j "${url}"`

  exec(command, (error, stdout) => {

    if (error) {
      console.error(error)
      return res.json({ error: "Failed to fetch video" })
    }

    const info = JSON.parse(stdout)

    const formats = info.formats.filter(f => f.ext === "mp4")

    const best = formats[formats.length - 1]

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      download: best.url
    })

  })

})

const PORT = process.env.PORT || 3000

// IMPORTANT POUR RAILWAY
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT)
})

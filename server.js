import express from "express"
import cors from "cors"
import ytdlp from "yt-dlp-exec"

const app = express()

app.use(cors())
app.use(express.json())

app.post("/download", async (req, res) => {

  const { url } = req.body

  try {

    const info = await ytdlp(url, {
      dumpSingleJson: true
    })

    const formats = info.formats.filter(f => f.ext === "mp4")

    const best = formats[formats.length - 1]

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      download: best.url
    })

  } catch (error) {

    res.json({
      error: "Video not supported"
    })

  }

})

app.listen(3000, () => {
  console.log("Downloader server running")
})

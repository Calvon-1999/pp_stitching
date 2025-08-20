const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/downloads', express.static('outputs'));

// Ensure dirs
['./uploads', './outputs', './temp'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ----------------- 🔥 In-memory job store -----------------
const jobs = {};

// ----------------- Helpers -----------------
async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
  const buffer = await response.buffer();
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function uploadToPublicServer(localFilePath, uuid, type) {
  const filename = `${type}-${uuid}-${Date.now()}${path.extname(localFilePath)}`;
  const publicPath = path.join('./outputs', filename);
  fs.copyFileSync(localFilePath, publicPath);

  // ✅ Force HTTPS with Railway domain
  const baseUrl = process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;
  const protocolFixed = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;

  return `${protocolFixed}/downloads/${filename}`;
}


async function mergeVideoWithMusic(videoUrl, musicUrl, uuid) {
  const videoPath = `./temp/video-${uuid}.mp4`;
  const musicPath = `./temp/music-${uuid}.mp3`;
  const outputPath = `./outputs/final-${uuid}.mp4`;

  // Download video + music
  await downloadFile(videoUrl, videoPath);
  await downloadFile(musicUrl, musicPath);

  // Get video duration
  const videoDuration = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });

  // ✅ Process music: trim to match video duration
  const processedMusicPath = `./temp/processed-music-${uuid}.mp3`;
  await new Promise((resolve, reject) => {
    ffmpeg(musicPath)
      .audioFilters([
        `atrim=0:${videoDuration}`, // trim to video length
        `afade=t=out:st=${Math.max(0, videoDuration - 2)}:d=2`, // fade out last 2s
        `volume=-5dB` // slight volume reduction
      ])
      .outputOptions(["-t", videoDuration]) // force cut to duration
      .output(processedMusicPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  // ✅ Mix video audio + trimmed music
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(processedMusicPath)
      .complexFilter([
        "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]"
      ])
      .outputOptions([
        "-map 0:v",    // keep original video
        "-map [aout]", // use mixed audio
        "-c:v copy",   // don't re-encode video
        "-c:a aac",    // ensure MP4 compatibility
        "-shortest"    // ensure final length = video length
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  return outputPath;
}

// ----------------- Routes -----------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'healthy', time: new Date().toISOString() }));

// POST -> start merge job
app.post('/api/create-video', async (req, res) => {
  const { uuid: clientUuid, final_stitch_video, final_music_url } = req.body;

  if (!final_stitch_video || !final_music_url) {
    return res.status(400).json({ error: "final_stitch_video and final_music_url required" });
  }

  const uuid = clientUuid || uuidv4();

  // Mark job as processing
  jobs[uuid] = { status: "processing", final_merged_video: null };

  // Run async merge job
  (async () => {
    try {
      const finalPath = await mergeVideoWithMusic(final_stitch_video, final_music_url, uuid);
      const publicUrl = await uploadToPublicServer(finalPath, uuid, 'merged');

      jobs[uuid] = { status: "completed", final_merged_video: publicUrl };
      console.log(`✅ Job ${uuid} completed: ${publicUrl}`);
    } catch (err) {
      console.error(`❌ Job ${uuid} failed:`, err);
      jobs[uuid] = { status: "failed", error: err.message };
    }
  })();

  res.json({ uuid, status: "processing" });
});

// GET -> check job status
app.get('/api/status/:uuid', (req, res) => {
  const { uuid } = req.params;
  if (!jobs[uuid]) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(jobs[uuid]);
});

// ----------------- Cleanup -----------------
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  ['./uploads', './outputs', './temp'].forEach(dir => {
    if (!fs.existsSync(dir)) return;
    fs.readdir(dir, (err, files) => {
      if (err) return;
      files.forEach(file => {
        const filePath = path.join(dir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtime.getTime() > oneHour) {
            fs.unlink(filePath, () => {});
          }
        });
      });
    });
  });
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Video+Music Merge API running on port ${PORT}`);
});

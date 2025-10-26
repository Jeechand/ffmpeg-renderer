// server.js
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const {execSync, spawn} = require('child_process');
const {Storage} = require('@google-cloud/storage');
const path = require('path');

const app = express();
app.use(express.json({ limit: '100mb' }));

const storage = new Storage();
const BUCKET = process.env.BUCKET_NAME; // set in Cloud Run
const RENDER_SECRET = process.env.RENDER_SECRET || 'change_me';

// helper: convert frames to ASS (simple style)
function framesToAss(frames, styles, playResX = 1920, playResY = 1080) {
  const topFont = (styles && (styles.fontTop || styles.font)) || 'Lexend';
  const fontSize = (styles && styles.fontSizeTop) || 56;
  // ASS header
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CAPTION,${topFont},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  function secToAss(tSec) {
    const h = Math.floor(tSec / 3600);
    const m = Math.floor((tSec % 3600) / 60);
    const s = Math.floor(tSec % 60);
    const cs = Math.floor((tSec - Math.floor(tSec)) * 100);
    return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
  }
  const events = frames.map(f => {
    // frames expected in ms (start, end). If ms, convert to sec
    const startSec = (f.start || 0) / 1000;
    const endSec = (f.end || (startSec + 2000)) / 1000;
    const text = ((f.line1 ? f.line1 : '') + (f.line2 ? '\\N' + f.line2 : '')).replace(/\n/g, '\\N');
    return `Dialogue: 0,${secToAss(startSec)},${secToAss(endSec)},CAPTION,,0,0,0,,${text}`;
  }).join('\n');
  return header + events;
}

async function uploadToGCS(localPath, destName) {
  const bucket = storage.bucket(BUCKET);
  await bucket.upload(localPath, { destination: destName });
  const file = bucket.file(destName);
  await file.makePublic(); // for simplicity — consider signed URLs in production
  return `https://storage.googleapis.com/${BUCKET}/${encodeURIComponent(destName)}`;
}

function runCommandSync(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

// Run a local ffmpeg command (promise)
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: 'inherit' });
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exit code ' + code));
    });
  });
}

async function getVideoResolution(inputPath) {
  try {
    const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${inputPath}"`).toString().trim();
    const [w, h] = out.split(',');
    return { width: parseInt(w), height: parseInt(h) };
  } catch (e) {
    // fallback
    return { width: 1920, height: 1080 };
  }
}

app.post('/render', async (req, res) => {
  try {
    const secret = req.header('X-Render-Secret') || req.body.render_secret || '';
    if (secret !== RENDER_SECRET) {
      return res.status(401).json({ status: 'error', error: 'unauthorized' });
    }

    const { job_id, reservation_id, video_url, frames, style, callback_url, plan_tier } = req.body;
    if (!video_url || !frames) return res.status(400).json({ error: 'missing fields' });

    const tmpDir = '/tmp';
    const inputPath = path.join(tmpDir, `in-${job_id}.mp4`);
    const assPath = path.join(tmpDir, `subs-${job_id}.ass`);
    const gradientPath = path.join(tmpDir, `gradient-${job_id}.png`);
    const watermarkPath = path.join(tmpDir, `watermark-${job_id}.png`);
    const outPath = path.join(tmpDir, `out-${job_id}.mp4`);

    // 1) Download video
    const writer = (await axios({ url: video_url, method: 'GET', responseType: 'stream' })).data;
    const outStream = fsSync.createWriteStream(inputPath);
    await new Promise((resolve, reject) => {
      writer.pipe(outStream);
      writer.on('end', resolve);
      writer.on('error', reject);
    });

    // 2) Write ASS subtitle
    const ass = framesToAss(frames, style);
    await fs.writeFile(assPath, ass, 'utf8');

    // 3) Get resolution for gradient size
    const { width, height } = await getVideoResolution(inputPath);
    const gradH = Math.max( Math.round(height / 4), 80 ); // bottom 1/4

    // 4) Create gradient (try gradient, else solid translucent)
    try {
      runCommandSync(`convert -size ${width}x${gradH} gradient:"#242229-#00000000" ${gradientPath}`);
    } catch (e) {
      // fallback: solid translucent rectangle
      runCommandSync(`convert -size ${width}x${gradH} canvas:none -fill "rgba(36,34,41,0.85)" -draw "rectangle 0,0 ${width},${gradH}" ${gradientPath}`);
    }

    // 5) Create watermark if plan_tier == 'free'
    const addWatermark = (plan_tier === 'free' || plan_tier === 'trial');
    if (addWatermark) {
      const watermarkText = "YourBrand";
      // choose a font from /app/fonts if exists else default
      const fontFiles = fsSync.existsSync('/app/fonts') ? fsSync.readdirSync('/app/fonts') : [];
      const fontPath = fontFiles.length ? `/app/fonts/${fontFiles[0]}` : '';
      let fontFlag = fontPath ? `-font "${fontPath}"` : '';
      try {
        runCommandSync(`convert -background none -fill "rgba(255,255,255,0.7)" -gravity SouthEast -pointsize 28 ${fontFlag} label:"${watermarkText}" ${watermarkPath}`);
      } catch (e) {
        // fallback to default
        runCommandSync(`convert -background none -fill "rgba(255,255,255,0.7)" -gravity SouthEast -pointsize 28 label:"${watermarkText}" ${watermarkPath}`);
      }
    }

    // 6) Compose video: overlay gradient (bottom) and watermark (optional) and burn ASS subtitles
    // Build filter_complex depending on watermark
    let filterCmd;
    if (addWatermark) {
      // three inputs: in.mp4, gradient.png, watermark.png
      // We'll use filter_complex chain: overlay gradient, overlay watermark, then ass
      filterCmd = [
        '-y', '-i', inputPath,
        '-i', gradientPath,
        '-i', watermarkPath,
        '-filter_complex',
        `[0:v][1:v]overlay=0:main_h-overlay_h[tmpv];[tmpv][2:v]overlay=main_w-overlay_w-10:main_h-overlay_h-10[tmp2];[tmp2]ass=${assPath}`,
        '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
      ];
    } else {
      // two inputs: in.mp4, gradient.png
      filterCmd = [
        '-y', '-i', inputPath,
        '-i', gradientPath,
        '-filter_complex',
        `[0:v][1:v]overlay=0:main_h-overlay_h[tmpv];[tmpv]ass=${assPath}[v]`,
        '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
      ];
    }

    // run ffmpeg
    await runFFmpeg(filterCmd);

    // 7) upload out.mp4 to GCS
    const destName = `renders/${job_id}-${Date.now()}.mp4`;
    const publicUrl = await uploadToGCS(outPath, destName);

    // 8) optional callback to Bubble if provided
    if (callback_url) {
      try {
        await axios.post(callback_url, { render_secret: RENDER_SECRET, reservation_id, job_id, status: 'success', video_url: publicUrl });
      } catch (e) {
        console.warn('Callback failed', e.message);
      }
    }

    // 9) return final response
    return res.json({ status: 'success', job_id, video_url: publicUrl });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('listening on', port));

// server.js
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const { execSync, spawn } = require('child_process');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const app = express();
app.use(express.json({ limit: '200mb' })); // allow large payloads if needed

const storage = new Storage();
const BUCKET = process.env.BUCKET_NAME || '';
const RENDER_SECRET = process.env.RENDER_SECRET || 'change_me';

// -------------------------
// Utility functions
// -------------------------
function runCommandSync(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: 'inherit' });
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exit code ' + code));
    });
  });
}

async function uploadToGCS(localPath, destName) {
  if (!BUCKET) throw new Error('BUCKET_NAME not set in env');
  const bucket = storage.bucket(BUCKET);
  await bucket.upload(localPath, { destination: destName });
  const file = bucket.file(destName);
  // For simplicity we make the file public — consider signed URLs in production
  await file.makePublic();
  return `https://storage.googleapis.com/${BUCKET}/${encodeURIComponent(destName)}`;
}

function secToAss(tSec) {
  const h = Math.floor(tSec / 3600);
  const m = Math.floor((tSec % 3600) / 60);
  const s = Math.floor(tSec % 60);
  const cs = Math.floor((tSec - Math.floor(tSec)) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function framesToAss(frames, styles, playResX = 1920, playResY = 1080) {
  const topFont = (styles && (styles.fontTop || styles.font)) || 'Lexend';
  const fontSize = (styles && styles.fontSizeTop) || 56;
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
  const events = frames.map(f => {
    const startSec = (f.start || 0) / 1000;
    const endSec = (f.end || (startSec + 2000)) / 1000;
    const text = ((f.line1 ? f.line1 : '') + (f.line2 ? '\\N' + f.line2 : '')).replace(/\n/g, '\\N');
    return `Dialogue: 0,${secToAss(startSec)},${secToAss(endSec)},CAPTION,,0,0,0,,${text}`;
  }).join('\n');
  return header + events;
}

async function getVideoResolution(inputPath) {
  try {
    const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${inputPath}"`).toString().trim();
    const [w, h] = out.split(',');
    return { width: parseInt(w), height: parseInt(h) };
  } catch (e) {
    return { width: 1920, height: 1080 };
  }
}

// -------------------------
// Main /render endpoint
// -------------------------
app.post('/render', async (req, res) => {
  try {
    // Auth check
    const headerSecret = req.header('X-Render-Secret');
    const bodySecret = req.body && req.body.render_secret;
    const provided = headerSecret || bodySecret || '';
    if (provided !== RENDER_SECRET) {
      return res.status(401).json({ status: 'error', error: 'unauthorized' });
    }

    // Extract inputs
    const { job_id, reservation_id, video_url, frames, style, callback_url, plan_tier } = req.body || {};

    if (!video_url || !frames) {
      return res.status(400).json({ status: 'error', error: 'missing fields - require video_url and frames' });
    }

    // file paths
    const tmpDir = '/tmp';
    const inputPath = path.join(tmpDir, `in-${job_id}.mp4`);
    const assPath = path.join(tmpDir, `subs-${job_id}.ass`);
    const gradientPath = path.join(tmpDir, `gradient-${job_id}.png`);
    const outPath = path.join(tmpDir, `out-${job_id}.mp4`);

    // 1) Download the input video
    const writer = (await axios({ url: video_url, method: 'GET', responseType: 'stream' })).data;
    const outStream = fsSync.createWriteStream(inputPath);
    await new Promise((resolve, reject) => {
      writer.pipe(outStream);
      writer.on('end', resolve);
      writer.on('error', reject);
    });

    // 2) Create ASS subtitles
    const ass = framesToAss(frames, style);
    await fs.writeFile(assPath, ass, 'utf8');

    // 3) Determine resolution and generate gradient
    const { width, height } = await getVideoResolution(inputPath);
    const gradH = Math.max(Math.round(height / 4), 80);

    try {
      // try gradient with ImageMagick
      runCommandSync(`convert -size ${width}x${gradH} gradient:"#242229-#00000000" ${gradientPath}`);
    } catch (e) {
      // fallback to translucent rectangle
      runCommandSync(`convert -size ${width}x${gradH} canvas:none -fill "rgba(36,34,41,0.85)" -draw "rectangle 0,0 ${width},${gradH}" ${gradientPath}`);
    }

    // 4) Decide watermark via drawtext (ffmpeg)
    const addWatermark = (plan_tier === 'free' || plan_tier === 'trial');
    const watermarkText = (style && style.watermarkText) ? style.watermarkText : 'YourBrand';

    // find a font file if available under /app/fonts
    let fontFile = '';
    try {
      const fontsExist = fsSync.existsSync('/app/fonts');
      if (fontsExist) {
        const fontFiles = fsSync.readdirSync('/app/fonts').filter(f => f.toLowerCase().endsWith('.ttf') || f.toLowerCase().endsWith('.otf'));
        if (fontFiles.length) {
          fontFile = `/app/fonts/${fontFiles[0]}`;
        }
      }
    } catch (e) {
      fontFile = '';
    }

    // Build drawtext snippet
    const escapedText = watermarkText.replace(/[:']/g, ""); // remove problematic chars for drawtext
    const drawtextSnippet = addWatermark
      ? (fontFile
          ? `drawtext=fontfile='${fontFile}':text='${escapedText}':fontsize=28:fontcolor=white@0.7:x=main_w-tw-10:y=main_h-th-10`
          : `drawtext=font='Sans':text='${escapedText}':fontsize=28:fontcolor=white@0.7:x=main_w-tw-10:y=main_h-th-10`)
      : '';

    // 5) Build ffmpeg filter_complex
    // We'll overlay gradient first, then drawtext (if any), then ass subtitles.
    let ffArgs;
    if (addWatermark) {
      ffArgs = [
        '-y', '-i', inputPath,
        '-i', gradientPath,
        '-filter_complex',
        `[0:v][1:v]overlay=0:main_h-overlay_h[tmpv];[tmpv]${drawtextSnippet}[tmp2];[tmp2]ass=${assPath}[v]`,
        '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
      ];
    } else {
      ffArgs = [
        '-y', '-i', inputPath,
        '-i', gradientPath,
        '-filter_complex',
        `[0:v][1:v]overlay=0:main_h-overlay_h[tmpv];[tmpv]ass=${assPath}[v]`,
        '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
      ];
    }

    // 6) Run ffmpeg
    try {
      await runFFmpeg(ffArgs);
    } catch (ffErr) {
      console.error('ffmpeg failed:', ffErr);
      return res.status(500).json({ status: 'error', error: 'ffmpeg failed: ' + ffErr.message });
    }

    // 7) Upload result to GCS
    const destName = `renders/${job_id}-${Date.now()}.mp4`;
    let publicUrl;
    try {
      publicUrl = await uploadToGCS(outPath, destName);
    } catch (uerr) {
      console.error('upload failed:', uerr);
      return res.status(500).json({ status: 'error', error: 'upload failed: ' + uerr.message });
    }

    // 8) Optional callback to Bubble
    if (callback_url) {
      try {
        await axios.post(callback_url, {
          render_secret: RENDER_SECRET,
          reservation_id,
          job_id,
          status: 'success',
          video_url: publicUrl
        }, { timeout: 10000 });
      } catch (e) {
        console.warn('Callback failed (non-fatal):', e.message);
      }
    }

    // 9) Respond
    return res.json({ status: 'success', job_id, video_url: publicUrl });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ status: 'error', error: err.message || String(err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('listening on', port));

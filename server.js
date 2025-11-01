// server.js
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const { execSync, spawn } = require('child_process');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const app = express();
app.use(express.json({ limit: '200mb' }));

const storage = new Storage();
const BUCKET = process.env.BUCKET_NAME || '';
const RENDER_SECRET = process.env.RENDER_SECRET || 'change_me';

// -------------------------
// Utilities
// -------------------------
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: 'inherit' });
    ff.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exited with ' + code)));
  });
}

async function uploadToGCS(localPath, destName) {
  if (!BUCKET) throw new Error('BUCKET_NAME not set');
  const bucket = storage.bucket(BUCKET);
  await bucket.upload(localPath, { destination: destName });
  const [url] = await bucket.file(destName).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  return url;
}

function secToAss(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function cssToAssColor(hex) {
  if (!hex?.startsWith('#')) return '&H00FFFFFF';
  const [r,g,b] = hex.length === 7
    ? [hex.slice(1,3), hex.slice(3,5), hex.slice(5,7)]
    : [hex[1]+hex[1], hex[2]+hex[2], hex[3]+hex[3]];
  return `&H00${b}${g}${r}`.toUpperCase();
}

async function getVideoResolution(file) {
  try {
    const res = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${file}"`).toString().trim().split(',');
    return { width: +res[0], height: +res[1] };
  } catch {
    console.warn('ffprobe failed, using fallback 1920x1080');
    return { width: 1920, height: 1080 };
  }
}

// -------------------------
// FIXED framesToAss()
// -------------------------
function framesToAss(frames, styles, videoWidth, videoHeight) {
  const playResX = videoWidth;
  const playResY = videoHeight;
  const baseH = 1080;

  // Style configs
  const font1 = styles?.fontTop || 'Lexend';
  const font2 = styles?.fontBottom || 'Cormorant Garamond';
  const size1 = styles?.fontSizeTop || 64;
  const size2 = styles?.fontSizeBottom || 100;
  const color1 = cssToAssColor(styles?.colorTop);
  const color2 = cssToAssColor(styles?.colorBottom);
  const weight1 = styles?.fontWeightTop === '700' ? '1' : '0';
  const weight2 = styles?.fontWeightBottom === '700' ? '1' : '0';
  const italic1 = styles?.isItalicTop ? '1' : '0';
  const italic2 = styles?.isItalicBottom ? '1' : '0';
  const paddingBottom = styles?.paddingBottom || 200;

  const scale = playResY / baseH;
  const scaledGap = 15 * scale;
  const scaledSize1 = size1 * scale;
  const scaledSize2 = size2 * scale;
  const Y_pos_Line2 = playResY - (paddingBottom * scale);
  const Y_pos_Line1 = Y_pos_Line2 - scaledSize2 - scaledGap; // top goes ABOVE bottom

  const shadowColor = '&H80000000';
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: STYLE1,${font1},${size1},${color1},${color1},&H00000000,${shadowColor},${weight1},${italic1},0,0,100,100,0,0,1,0,2,2,20,20,0,1
Style: STYLE2,${font2},${size2},${color2},${color2},&H00000000,${shadowColor},${weight2},${italic2},0,0,100,100,0,0,1,0,2,2,20,20,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const text = frames.flatMap(f => {
    const start = secToAss((f.start || 0) / 1000);
    const end = secToAss((f.end || f.start + 2000) / 1000);
    const out = [];
    if (f.line1?.trim())
      out.push(`Dialogue: 0,${start},${end},STYLE1,,0,0,0,,{\\pos(${playResX/2},${Y_pos_Line1})}${f.line1.trim()}`);
    if (f.line2?.trim())
      out.push(`Dialogue: 0,${start},${end},STYLE2,,0,0,0,,{\\pos(${playResX/2},${Y_pos_Line2})}${f.line2.trim()}`);
    return out;
  }).join('\n');

  return header + text;
}

// -------------------------
// Main Endpoint
// -------------------------
app.post('/render', async (req, res) => {
  try {
    const { job_id, video_url, frames, style, callback_url, watermark_url, plan_tier } = req.body || {};
    const provided = req.header('X-Render-Secret') || req.body?.render_secret || '';
    if (provided !== RENDER_SECRET) return res.status(401).json({ error: 'unauthorized' });
    if (!video_url || !frames) return res.status(400).json({ error: 'missing fields' });

    const tmp = '/tmp';
    const inPath = `${tmp}/in-${job_id}.mp4`;
    const assPath = `${tmp}/subs-${job_id}.ass`;
    const outPath = `${tmp}/out-${job_id}.mp4`;
    const wmPath = `${tmp}/wm-${job_id}.png`;

    // Download input
    const stream = (await axios({ url: video_url, responseType: 'stream' })).data;
    await new Promise((resv, rej) => {
      stream.pipe(fsSync.createWriteStream(inPath));
      stream.on('end', resv);
      stream.on('error', rej);
    });

    // Detect resolution
    const reso = await getVideoResolution(inPath);

    // Download watermark if free plan
    let wmInput = null;
    if (plan_tier === 'free' && watermark_url) {
      try {
        const s = (await axios({ url: watermark_url, responseType: 'stream' })).data;
        await new Promise((r, j) => {
          s.pipe(fsSync.createWriteStream(wmPath));
          s.on('end', r); s.on('error', j);
        });
        wmInput = wmPath;
      } catch (e) { console.warn('watermark download failed', e.message); }
    }

    // Write ASS
    await fs.writeFile(assPath, framesToAss(frames, style, reso.width, reso.height));

    // FFmpeg filters
    const assFilter = `ass=filename=${assPath}:fontsdir=/app/fonts`;
    let ffArgs;

    if (plan_tier === 'free' && wmInput) {
      const filter = `[0:v]scale=-1:28[wm];[1:v][wm]overlay=W-w-24:24[v1];[v1]${assFilter}[v]`;
      ffArgs = ['-y','-i',wmInput,'-i',inPath,'-filter_complex',filter,'-map','[v]','-map','1:a?','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','copy',outPath];
    } else {
      const filter = `[0:v]${assFilter}[v]`;
      ffArgs = ['-y','-i',inPath,'-filter_complex',filter,'-map','[v]','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','copy',outPath];
    }

    await runFFmpeg(ffArgs);
    const gcsUrl = await uploadToGCS(outPath, `renders/${job_id}-${Date.now()}.mp4`);

    if (callback_url) axios.post(callback_url, { job_id, status: 'success', video_url: gcsUrl, render_secret: RENDER_SECRET }).catch(()=>{});
    res.json({ status: 'success', video_url: gcsUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 8080, () => console.log('listening...'));

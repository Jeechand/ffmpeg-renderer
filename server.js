// server.js — damped scaling (sqrt) from 360p baseline
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn, execSync } = require('child_process');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const app = express();
app.use(express.json({ limit: '300mb' }));

const storage = new Storage();
const BUCKET = process.env.BUCKET_NAME || '';
const RENDER_SECRET = process.env.RENDER_SECRET || 'change_me';
const SYSTEM_FONTS_DIR = process.env.SYSTEM_FONTS_DIR || '/usr/local/share/fonts/custom';
const TMP_DIR = '/tmp';

// ---------------- Utilities ----------------
function secToAss(tSec) {
  tSec = isFinite(tSec) ? tSec : 0;
  const h = Math.floor(tSec / 3600);
  const m = Math.floor((tSec % 3600) / 60);
  const s = Math.floor(tSec % 60);
  const cs = Math.floor((tSec - Math.floor(tSec)) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function cssToAssColor(hex) {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return '&H00FFFFFF';
  let r,g,b;
  if (hex.length === 7) { r = hex.substring(1,3); g = hex.substring(3,5); b = hex.substring(5,7); }
  else { r = hex[1]+hex[1]; g = hex[2]+hex[2]; b = hex[3]+hex[3]; }
  return `&H00${b}${g}${r}`.toUpperCase();
}

function escapeAssText(s) {
  if (!s && s !== 0) return '';
  let t = String(s).trim();
  t = t.replace(/\r\n?/g, '\n').replace(/\n/g, '\\N');
  t = t.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}');
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return t;
}

async function getVideoResolution(inputPath) {
  try {
    const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${inputPath}"`).toString().trim();
    const [w,h] = out.split(',');
    return { width: parseInt(w,10) || 1920, height: parseInt(h,10) || 1080 };
  } catch (e) {
    console.warn('ffprobe failed; using fallback 1920x1080', e.message || e);
    return { width: 1920, height: 1080 };
  }
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log('Spawning ffmpeg with args:', args.join(' '));
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    ff.stdout.on('data', d => { stdout += d.toString(); });
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error('ffmpeg exit code ' + code);
        err.stdout = stdout; err.stderr = stderr;
        reject(err);
      }
    });
  });
}

// ---------------- ASS generation: sqrt damped scaling from 360p --------------
/*
  Rule:
    base sizes you send are treated as pixel sizes at 360p (height=360).
    scale = sqrt(videoHeight / 360)
    font = Math.round(base * scale)
*/
function framesToAss(frames, styles = {}, videoWidth = 1920, videoHeight = 1080) {
  const BASELINE = 360;
  const ratio = (videoHeight || BASELINE) / BASELINE;
  const scale = Math.sqrt(Math.max(0.01, ratio)); // sqrt damped scale

  // base sizes are expected to be what you want at 360p
  const rawFontTop = styles.fontSizeTop || 40;
  const rawFontBottom = styles.fontSizeBottom || 52;

  // apply damped scale; clamp to reasonable min/max
  const fontSizeTop = Math.max(14, Math.min(380, Math.round(rawFontTop * scale)));
  const fontSizeBottom = Math.max(16, Math.min(420, Math.round(rawFontBottom * scale)));

  const fontTop = (styles.fontTop || 'Lexend').replace(/,/g,'');
  const fontBottom = (styles.fontBottom || 'Cormorant Garamond').replace(/,/g,'');

  const colorTop = cssToAssColor(styles.colorTop || '#FFFFFF');
  const colorBottom = cssToAssColor(styles.colorBottom || '#FFD100');
  const boldTop = (styles.fontWeightTop === '700' || styles.fontWeightTop === 700) ? '1' : '0';
  const boldBottom = (styles.fontWeightBottom === '700' || styles.fontWeightBottom === 700) ? '1' : '0';
  const italicTop = styles.isItalicTop ? '1' : '0';
  const italicBottom = styles.isItalicBottom ? '1' : '0';

  const basePad = styles.paddingBottom != null ? styles.paddingBottom : 120;
  // pad scales with the same damped scale so vertical placement remains consistent
  const padScaled = Math.round(basePad * scale);

  const baselineFactorBottom = 0.66;
  const baselineFactorTop = 0.28;
  const baseGap = Math.round(18 * scale);
  const extraGapFactor = 0.22;

  let Y_pos_Line2 = videoHeight - padScaled;
  const twoLinePresent = Array.isArray(frames) && frames.some(f => f.line1 && f.line1.trim() && f.line2 && f.line2.trim());
  if (twoLinePresent) Y_pos_Line2 += Math.round(fontSizeBottom * 0.28);

  const Y_pos_Line1 = Y_pos_Line2
    - (fontSizeBottom * baselineFactorBottom)
    - (fontSizeTop * baselineFactorTop)
    - (baseGap + fontSizeBottom * extraGapFactor);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 0
Title: Generated by AiVideoCaptioner

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: STYLE_BOTTOM,${fontBottom},${fontSizeBottom},${colorBottom},${colorBottom},&H00000000,&H80000000,${boldBottom},${italicBottom},0,0,100,100,0,0,1,0,2,2,${padScaled},20,0,1
Style: STYLE_TOP,${fontTop},${fontSizeTop},${colorTop},${colorTop},&H00000000,&H80000000,${boldTop},${italicTop},0,0,100,100,0,0,1,0,2,2,${padScaled},20,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const centerX = Math.round(videoWidth / 2);
  const events = (frames || []).flatMap(f => {
    const startMs = Number.isFinite(f.start) ? f.start : 0;
    const endMs = Number.isFinite(f.end) ? f.end : (startMs + 2000);
    const s = secToAss(startMs / 1000);
    const e = secToAss(endMs / 1000);
    const out = [];
    if (f.line1 && String(f.line1).trim()) {
      const t1 = escapeAssText(f.line1);
      out.push(`Dialogue: 0,${s},${e},STYLE_TOP,,0,0,0,,{\\an5\\pos(${centerX},${Math.round(Y_pos_Line1)})}${t1}`);
    }
    if (f.line2 && String(f.line2).trim()) {
      const t2 = escapeAssText(f.line2);
      out.push(`Dialogue: 0,${s},${e},STYLE_BOTTOM,,0,0,0,,{\\an5\\pos(${centerX},${Math.round(Y_pos_Line2)})}${t2}`);
    }
    return out;
  }).join('\n');

  console.log(`Scaling: videoH=${videoHeight} ratio=${ratio.toFixed(3)} scale=${scale.toFixed(3)} → top=${fontSizeTop}, bottom=${fontSizeBottom}, pad=${padScaled}`);
  return header + events;
}

// ---------------- GCS upload ----------------
async function uploadToGCS(localPath, destName) {
  if (!BUCKET) throw new Error('BUCKET_NAME not set in env');
  const bucket = storage.bucket(BUCKET);
  await bucket.upload(localPath, { destination: destName });
  const file = bucket.file(destName);
  const expiresDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [signedUrl] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: expiresDate });
  return signedUrl;
}

// ---------------- /render endpoint ----------------
app.post('/render', async (req, res) => {
  try {
    const headerSecret = req.header('X-Render-Secret');
    const bodySecret = req.body && req.body.render_secret;
    const provided = headerSecret || bodySecret || '';
    if (provided !== RENDER_SECRET) return res.status(401).json({ status: 'error', error: 'unauthorized' });

    console.log('--- /render request ---', 'X-Render-Secret?', !!headerSecret);
    let { job_id, video_url, frames, style, callback_url, watermark_url, plan_tier } = req.body || {};
    if (typeof style === 'string') { try { style = JSON.parse(style); } catch (e) {} }
    frames = Array.isArray(frames) ? frames : [];

    if (!video_url || !job_id) return res.status(400).json({ status: 'error', error: 'missing video_url or job_id' });

    const shouldAddWatermark = plan_tier === 'free';
    const inputPath = path.join(TMP_DIR, `in-${job_id}.mp4`);
    const assPath = path.join(TMP_DIR, `subs-${job_id}.ass`);
    const debugAssPath = path.join(TMP_DIR, `ass-debug-${job_id}.ass`);
    const watermarkPath = path.join(TMP_DIR, `watermark-${job_id}.png`);
    const outPath = path.join(TMP_DIR, `out-${job_id}.mp4`);

    // download video
    try {
      console.log('Downloading video:', video_url);
      const response = await axios({ url: video_url, method: 'GET', responseType: 'stream', timeout: 20000 });
      const writer = fsSync.createWriteStream(inputPath);
      await new Promise((resolve, reject) => { response.data.pipe(writer); writer.on('finish', resolve); writer.on('error', reject); });
      console.log('Saved input to', inputPath);
    } catch (e) {
      console.error('Video download failed:', e.message || e);
      return res.status(500).json({ status: 'error', error: `Video download failed: ${e.message || e}` });
    }

    // detect resolution
    const videoResolution = await getVideoResolution(inputPath);
    console.log('Detected resolution', videoResolution);

    // optional font-dir check (helpful)
    try {
      const fontFiles = fsSync.existsSync(SYSTEM_FONTS_DIR) ? fsSync.readdirSync(SYSTEM_FONTS_DIR) : [];
      console.log('FontDir:', SYSTEM_FONTS_DIR, 'files:', fontFiles.slice(0,30));
    } catch (e) { console.warn('Font dir check failed:', e.message || e); }

    // watermark download if needed
    let watermarkInput = null;
    if (shouldAddWatermark && watermark_url) {
      try {
        const r = await axios({ url: watermark_url, method: 'GET', responseType: 'stream', timeout: 15000 });
        const s = fsSync.createWriteStream(watermarkPath);
        await new Promise((resolve, reject) => { r.data.pipe(s); s.on('finish', resolve); s.on('error', reject); });
        watermarkInput = watermarkPath;
        console.log('Downloaded watermark to', watermarkPath);
      } catch (e) {
        console.warn('Failed to download watermark (fallback to text):', e.message || e);
      }
    }

    // build ASS + debug copy
    const ass = framesToAss(frames, style || {}, videoResolution.width, videoResolution.height);
    await fs.writeFile(assPath, ass, 'utf8');
    await fs.writeFile(debugAssPath, ass, 'utf8');
    console.log('Wrote ASS files:', assPath, debugAssPath);

    // prepare ffmpeg filter (quote paths)
    const quotedAss = assPath.replace(/'/g, "\\'");
    const quotedFonts = SYSTEM_FONTS_DIR.replace(/'/g, "\\'");
    const assFilter = `ass=filename='${quotedAss}':fontsdir='${quotedFonts}'`;

    const WATERMARK_TEXT = 'AiVideoCaptioner';
    const PADDING = 18;
    const WATERMARK_IMAGE_HEIGHT = 28;

    let ffArgs, filterComplex;

    if (shouldAddWatermark) {
      if (watermarkInput) {
        filterComplex = `[0:v]scale=-1:${WATERMARK_IMAGE_HEIGHT}[wm];[1:v][wm]overlay=x=main_w-overlay_w-${PADDING}:y=${PADDING}[v];[v]${assFilter}[outv]`;
        ffArgs = ['-y','-i', watermarkInput, '-i', inputPath, '-filter_complex', filterComplex, '-map', '[outv]', '-map', '1:a?', '-c:v', 'libx264','-preset','veryfast','-crf','23','-c:a','copy', outPath];
      } else {
        const drawtext = `drawtext=text='${WATERMARK_TEXT}':fontsize=16:fontcolor=white@0.7:x=main_w-tw-${PADDING}:y=${PADDING}`;
        filterComplex = `[0:v]${drawtext}[v_wm];[v_wm]${assFilter}[outv]`;
        ffArgs = ['-y','-i', inputPath, '-filter_complex', filterComplex, '-map', '[outv]', '-map', '0:a?', '-c:v', 'libx264','-preset','veryfast','-crf','23','-c:a','copy', outPath];
      }
    } else {
      filterComplex = `[0:v]${assFilter}[outv]`;
      ffArgs = ['-y','-i', inputPath, '-filter_complex', filterComplex, '-map', '[outv]', '-map', '0:a?', '-c:v', 'libx264','-preset','veryfast','-crf','23','-c:a','copy', outPath];
    }

    console.log('filterComplex:', filterComplex);

    // run ffmpeg
    try {
      const { stderr } = await runFFmpeg(ffArgs);
      console.log('ffmpeg stderr tail:', stderr.slice(-1500));
    } catch (ffErr) {
      console.error('ffmpeg failed:', ffErr.message || ffErr);
      console.error('ffmpeg stderr (truncated):', (ffErr.stderr || ffErr.message || '').slice(0,8000));
      return res.status(500).json({ status: 'error', error: 'ffmpeg failed', details: (ffErr.stderr || ffErr.message || '').slice(0,5000) });
    }

    // upload
    const destName = `renders/${job_id}-${Date.now()}.mp4`;
    let publicUrl;
    try { publicUrl = await uploadToGCS(outPath, destName); }
    catch (uerr) { console.error('upload failed:', uerr); return res.status(500).json({ status:'error', error: 'upload failed: '+(uerr.message||uerr)}); }

    // callback
    if (callback_url) {
      try { await axios.post(callback_url, { render_secret: RENDER_SECRET, job_id, status: 'success', video_url: publicUrl }, { timeout:10000 }); }
      catch (e) { console.warn('Callback failed:', e.message || e); }
    }

    return res.json({ status: 'success', job_id, video_url: publicUrl });

  } catch (err) {
    console.error('Catch-all error:', err);
    return res.status(500).json({ status: 'error', error: String(err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Listening on', port));

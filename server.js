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

  // Create a signed URL valid for 7 days (max allowed)
  const expiresDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: expiresDate
  });

  return signedUrl;
}


function secToAss(tSec) {
  const h = Math.floor(tSec / 3600);
  const m = Math.floor((tSec % 3600) / 60);
  const s = Math.floor(tSec % 60);
  const cs = Math.floor((tSec - Math.floor(tSec)) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

// --- HELPER FUNCTIONS ---

function findFontFile(startDir, fontName) {
  if (!fsSync.existsSync(startDir) || !fontName) {
    return null;
  }

  const files = fsSync.readdirSync(startDir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(startDir, file.name);
    if (file.isDirectory()) {
      const found = findFontFile(fullPath, fontName);
      if (found) return found;
    } else if (file.isFile()) {
      const ext = path.extname(file.name).toLowerCase();
      if (ext === '.ttf' || ext === '.otf') {
        const baseName = path.basename(file.name, ext);
        if (baseName.toLowerCase().replace(/[\s-_]/g, '').includes(fontName.toLowerCase().replace(/[\s-_]/g, ''))) {
          return fullPath;
        }
      }
    }
  }
  return null;
}

function findFirstFontFile(startDir) {
  if (!fsSync.existsSync(startDir)) {
    return null;
  }
  const files = fsSync.readdirSync(startDir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(startDir, file.name);
    if (file.isDirectory()) {
      const found = findFirstFontFile(fullPath);
      if (found) return found;
    } else if (file.isFile()) {
      const ext = path.extname(file.name).toLowerCase();
      if (ext === '.ttf' || ext === '.otf') {
        return fullPath;
      }
    }
  }
  return null;
}

// --- FIXED: cssToAssColor ---
// Uses a better, darker yellow (#F7B500)
function cssToAssColor(hex, alpha = '00') {
  if (hex === 'white') hex = '#FFFFFF';
  
  // --- THIS LINE IS CHANGED ---
  if (hex === 'yellow') hex = '#F7B500'; // Using a darker, video-safe yellow (was #FFFF00)
  
  if (hex === 'black') hex = '#000000';

  if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) {
    return '&H00FFFFFF'; // Default to Opaque White
  }
  
  let r, g, b;
  
  if (hex.length === 7) { // #RRGGBB
    r = hex.substring(1, 3);
    g = hex.substring(3, 5);
    b = hex.substring(5, 7);
  } else if (hex.length === 4) { // #RGB
    r = hex.substring(1, 2).repeat(2);
    g = hex.substring(2, 3).repeat(2);
    b = hex.substring(3, 4).repeat(2);
  } else {
    return '&H00FFFFFF'; // Default on invalid length
  }

  // ASS format is &H + Alpha + Blue + Green + Red
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}


// --- FIXED: framesToAss (Italics, Spacing, AND Animation) ---
function framesToAss(frames, styles, playResX = 1920, playResY = 1080) {
    
  // Style 1 (Top Line)
  const font1 = (styles && styles.fontTop) || 'Lexend';
  const size1 = (styles && styles.fontSizeTop) || 80;
  const color1 = cssToAssColor(styles && styles.colorTop);
  const weight1 = (styles && (styles.fontWeightTop === 'bold' || styles.fontWeightTop === '700')) ? '1' : '0';
  // --- NEW: Read Italic style ---
  const italic1 = (styles && styles.fontStyleTop === 'italic') ? '1' : '0';

  // Style 2 (Bottom Line)
  const font2 = (styles && styles.fontBottom) || 'Lexend';
  const size2 = (styles && styles.fontSizeBottom) || 80;
  const color2 = cssToAssColor(styles && styles.colorBottom);
  const weight2 = (styles && (styles.fontWeightBottom === 'bold' || styles.fontWeightBottom === '700')) ? '1' : '0';
  // --- NEW: Read Italic style ---
  const italic2 = (styles && styles.fontStyleBottom === 'italic') ? '1' : '0';
  
  const marginV_Line2 = (styles && styles.paddingBottom) || 100;
  
  // --- CHANGED: Spacing logic to match CSS 'line-height: 1.2' ---
  const marginV_Line1 = marginV_Line2 + Math.round(size2 * 1.2); 
  
  // Shadow style from your CSS
  const shadowColor = '&H80000000'; // 50% opaque black
  const outline = 0;
  const shadow = 2;
  
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: STYLE1,${font1},${size1},${color1},&H000000FF,&H00000000,${shadowColor},${weight1},${italic1},0,0,100,100,0,0,1,${outline},${shadow},2,20,20,${marginV_Line1},1
Style: STYLE2,${font2},${size2},${color2},&H000000FF,&H00000000,${shadowColor},${weight2},${italic2},0,0,100,100,0,0,1,${outline},${shadow},2,20,20,${marginV_Line2},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  
  const events = frames.flatMap(f => {
    const startSec = (f.start || 0) / 1000;
    const endSec = (f.end || (startSec + 2000)) / 1000;
    const startAss = secToAss(startSec);
    const endAss = secToAss(endSec);
    
    const lines = [];
    
    // --- NEW ANIMATION LOGIC ---
    // These values are taken directly from your Bubble CSS/JS
    const staggerMs = 50;   // 50ms stagger (index * 0.05)
    const animDurationMs = 500; // 500ms fade-in (animation: wordFadeUp 0.5s)

    if (f.line1 && f.line1.trim() !== '') {
        const words = f.line1.split(/\s+/).filter(w => w.length > 0);
        let animatedText = "";
        words.forEach((word, index) => {
            const startTime = index * staggerMs;
            const endTime = startTime + animDurationMs;
            // \alpha&HFF& = Start 100% transparent
            // \t(start, end, \alpha&H00&) = Animate to 0% transparent (opaque) over the time
            animatedText += `{\\alpha&HFF&\\t(${startTime}, ${endTime}, \\alpha&H00&)}${word.replace(/\n/g, '\\N')} `;
        });
        lines.push(`Dialogue: 0,${startAss},${endAss},STYLE1,,0,0,0,,${animatedText.trim()}`);
    }
    
    if (f.line2 && f.line2.trim() !== '') {
        const words = f.line2.split(/\s+/).filter(w => w.length > 0);
        let animatedText = "";
        words.forEach((word, index) => {
            const startTime = index * staggerMs;
            const endTime = startTime + animDurationMs;
            animatedText += `{\\alpha&HFF&\\t(${startTime}, ${endTime}, \\alpha&H00&)}${word.replace(/\n/g, '\\N')} `;
        });
        lines.push(`Dialogue: 0,${startAss},${endAss},STYLE2,,0,0,0,,${animatedText.trim()}`);
    }
    
    return lines;
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

    const { job_id, reservation_id, video_url, frames, style, callback_url, plan_tier } = req.body || {};

    if (!video_url || !frames) {
      return res.status(400).json({ status: 'error', error: 'missing fields - require video_url and frames' });
    }

    // file paths
    const tmpDir = '/tmp';
    const inputPath = path.join(tmpDir, `in-${job_id}.mp4`);
    const assPath = path.join(tmpDir, `subs-${job_id}.ass`);
    // --- REMOVED GRADIENT PATH ---
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

    // 3) --- REMOVED GRADIENT GENERATION ---

    // 4) Decide watermark via drawtext (ffmpeg)
    const addWatermark = (plan_tier === 'free' || plan_tier === 'trial');
    const watermarkText = (style && style.watermarkText) ? style.watermarkText : 'YourBrand';

    let fontFile = '';
    try {
        const preferredFontName = (style && style.fontTop) || 'Lexend';
        fontFile = findFontFile('/app/fonts', preferredFontName);
        
        if (!fontFile) {
            fontFile = findFirstFontFile('/app/fonts');
        }
    } catch (e) {
        console.warn("Error searching for fonts:", e.message);
        fontFile = ''; // Will default to 'Sans'
    }

    const escapedText = watermarkText.replace(/[:']/g, ""); 
    const drawtextSnippet = addWatermark
      ? (fontFile
          ? `drawtext=fontfile='${fontFile}':text='${escapedText}':fontsize=28:fontcolor=white@0.7:x=main_w-tw-10:y=main_h-th-10`
          : `drawtext=font='Sans':text='${escapedText}':fontsize=28:fontcolor=white@0.7:x=main_w-tw-10:y=main_h-th-10`)
      : '';

    // 5) Build ffmpeg filter_complex
    // --- MODIFIED: Simplified filter_complex, removed gradient overlay ---
    let ffArgs;
    const assFilter = `ass=filename=${assPath}:fontsdir=/app/fonts`;

    if (addWatermark) {
      ffArgs = [
        '-y', '-i', inputPath,
        // No gradient input
        '-filter_complex',
        `[0:v]${drawtextSnippet}[tmpv];[tmpv]${assFilter}[v]`, // Chain ass filter after drawtext
        '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
      ];
    } else {
      ffArgs = [
        '-y', '-i', inputPath,
        // No gradient input
        '-filter_complex',
        `[0:v]${assFilter}[v]`, // Just apply ass filter
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
          render__secret: RENDER_SECRET,
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

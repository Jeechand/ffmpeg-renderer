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

function cssToAssColor(hex) {
  if (hex === 'white') hex = '#FFFFFF';
  if (hex === 'yellow') hex = '#FFFF00';
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

  // ASS format is &H + Alpha (00) + Blue + Green + Red
  return `&H00${b}${g}${r}`.toUpperCase();
}


// ⭐ MODIFIED: Corrected Line Swap Logic in framesToAss
function framesToAss(frames, styles, playResX = 1920, playResY = 1080) {
  
  // Style 1 (TOP Line)
  const font1 = (styles && styles.fontTop) || 'Lexend';
  const size1 = (styles && styles.fontSizeTop) || 80;
  const color1Primary = cssToAssColor(styles && styles.colorTop);  
  const color1Secondary = cssToAssColor(styles && styles.colorBottom);
  const weight1 = (styles && (styles.fontWeightTop === '700')) ? '1' : '0';  
  const italic1 = (styles && styles.isItalicTop) ? '1' : '0';  

  // Style 2 (BOTTOM Line)
  const font2 = (styles && styles.fontBottom) || 'Lexend';
  const size2 = (styles && styles.fontSizeBottom) || 80;
  const color2Primary = cssToAssColor(styles && styles.colorBottom);  
  const color2Secondary = cssToAssColor(styles && styles.colorTop);
  const weight2 = (styles && (styles.fontWeightBottom === '700')) ? '1' : '0';
  const italic2 = (styles && styles.isItalicBottom) ? '1' : '0';
  
  // Padding from the bottom edge for the BOTTOM LINE (Line 2)
  const marginV_Line2 = (styles && styles.paddingBottom) || 200;
  
  // To place Line 1 (Top Line) correctly ABOVE Line 2 (Bottom Line), 
  // we calculate its MarginV based on Line 2's position and font size.
  // Using Alignment 2 (Bottom Center) and a lower MarginV means the line is higher up.
  
  // NEW LOGIC: Calculate Line 1 MarginV based on Line 2's size and desired overlap/gap.
  // MarginV_Line1 must be greater than MarginV_Line2 to appear lower on screen.
  // But wait, the previous logic was using alignment '2' which is bottom center.
  // Let's use Alignment '2' (Bottom Center) for both, and adjust MarginV:
  
  // Line 2 (BOTTOM): Uses the user-defined padding.
  // Line 1 (TOP): Needs to be positioned above Line 2. 
  // MarginV for Line 1 = MarginV_Line2 + size2 + (vertical gap)
  const VERTICAL_GAP = 5; // A small gap between the two lines
  const marginV_Line1 = marginV_Line2 + size2 + VERTICAL_GAP;  
  
  // Clean drop shadow settings (no outline)
  const shadowColor = '&H80000000'; // 50% opaque black shadow color
  const outline = 0;  
  const shadow = 2; // Shadow distance
  
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: STYLE2,${font2},${size2},${color2Primary},${color2Secondary},&H00000000,${shadowColor},${weight2},${italic2},0,0,100,100,0,0,1,${outline},${shadow},2,20,20,${marginV_Line2},1
Style: STYLE1,${font1},${size1},${color1Primary},${color1Secondary},&H00000000,${shadowColor},${weight1},${italic1},0,0,100,100,0,0,1,${outline},${shadow},2,20,20,${marginV_Line1},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  
  // Function to return plain text (NO ANIMATION)
  const getPlainText = (lineText) => {
    return lineText ? lineText.trim() : '';
  };
  
  const events = frames.flatMap(f => {
    const startSec = (f.start || 0) / 1000;
    const endSec = (f.end || (startSec + 2000)) / 1000;
    const startAss = secToAss(startSec);
    const endAss = secToAss(endSec);
    
    const lines = [];
    
    // Line 1: Expected TOP line in final video (higher marginV -> positioned lower)
    // The previous logic for marginV was backwards. 
    // MarginV = Distance from the BOTTOM edge. Higher MarginV = Line moves UP.
    // To fix the swap, we must assign the style with the LARGER MarginV (STYLE1) 
    // to the line that should appear on TOP (Line 1). 
    // And the style with the SMALLER MarginV (STYLE2) to the line that should appear on the BOTTOM (Line 2). 
    
    // Line 1 (TOP) -> Use STYLE1 (larger MarginV)
    if (f.line1 && f.line1.trim() !== '') {
      const text1 = getPlainText(f.line1);
      lines.push(`Dialogue: 0,${startAss},${endAss},STYLE1,,0,0,0,,${text1}`);
    }
    
    // Line 2 (BOTTOM) -> Use STYLE2 (smaller MarginV)
    if (f.line2 && f.line2.trim() !== '') {
      const text2 = getPlainText(f.line2);
      lines.push(`Dialogue: 0,${startAss},${endAss},STYLE2,,0,0,0,,${text2}`);
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
  // ... (Authorization and basic checks remain unchanged)
  try {
    // Auth check
    const headerSecret = req.header('X-Render-Secret');
    const bodySecret = req.body && req.body.render_secret;
    const provided = headerSecret || bodySecret || '';
    if (provided !== RENDER_SECRET) {
      return res.status(401).json({ status: 'error', error: 'unauthorized' });
    }

    const { job_id, video_url, frames, style, callback_url, watermark_url, plan_tier } = req.body || {};

    if (!video_url || !frames) {
      return res.status(400).json({ status: 'error', error: 'missing fields - require video_url and frames' });
    }

    const shouldAddWatermark = plan_tier === "free";

    // file paths
    const tmpDir = '/tmp';
    const inputPath = path.join(tmpDir, `in-${job_id}.mp4`);
    const assPath = path.join(tmpDir, `subs-${job_id}.ass`);
    const watermarkPath = path.join(tmpDir, `watermark-${job_id}.png`); 
    const outPath = path.join(tmpDir, `out-${job_id}.mp4`);

    // 1) Download the input video
    // ... (Video download logic remains unchanged)
    const writer = (await axios({ url: video_url, method: 'GET', responseType: 'stream' })).data;
    const outStream = fsSync.createWriteStream(inputPath);
    await new Promise((resolve, reject) => {
      writer.pipe(outStream);
      writer.on('end', resolve);
      writer.on('error', reject);
    });

    // 2) Download watermark image if needed
    let watermarkInput = null;
    if (shouldAddWatermark && watermark_url) {
        try {
            const logoWriter = (await axios({ url: watermark_url, method: 'GET', responseType: 'stream' })).data;
            const logoOutStream = fsSync.createWriteStream(watermarkPath);
            await new Promise((resolve, reject) => {
                logoWriter.pipe(logoOutStream);
                logoWriter.on('end', resolve);
                logoWriter.on('error', reject);
            });
            watermarkInput = watermarkPath;
        } catch (e) {
            console.error('Failed to download watermark image:', e.message);
            // Non-fatal: just continue without a logo
        }
    }

    // 3) Create ASS subtitles
    const ass = framesToAss(frames, style);
    await fs.writeFile(assPath, ass, 'utf8');

    // --- WATERMARK CONSTANTS (Only used if shouldAddWatermark is true) ---
    const WATERMARK_TEXT = "AiVideoCaptioner";
    const WATERMARK_IMAGE_HEIGHT = 48; // Set a fixed height for the watermark
    const WATERMARK_TEXT_SIZE = 18; 
    const PADDING = 24; 

    // 4) Build ffmpeg filter_complex
    let ffArgs;
    const assFilter = `ass=filename=${assPath}:fontsdir=/app/fonts`;
    let filterComplex;

    if (shouldAddWatermark) {
        // 4a. Watermark setup: Image or Text
        if (watermarkInput) {
            // ⭐ MODIFIED: Image Watermark setup with aspect ratio scaling
            // [0:v] is the watermark image input, [1:v] is the main video input
            // scale='-1:H' scales to the specified height (48px) and calculates width (-1) 
            // to maintain aspect ratio, preventing distortion.
            filterComplex = 
                `[0:v]scale=-1:${WATERMARK_IMAGE_HEIGHT}[wm_scaled];` + 
                `[1:v][wm_scaled]overlay=x=main_w-overlay_w-${PADDING}:y=${PADDING}[v_wm];`; 
            
            // Final Chain: [v_wm] -> ASS -> [v]
            filterComplex += `[v_wm]${assFilter}[v]`;

            ffArgs = [
                '-y', 
                '-i', watermarkInput, // Input 0: Watermark Image
                '-i', inputPath, // Input 1: Video
                '-filter_complex', filterComplex,
                '-map', '[v]', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
            ];

        } else {
            // Text Watermark setup 
            // ... (Text watermark logic remains unchanged)
            const watermarkDrawText = 
              `drawtext=` +
              `fontfile='Lexend-Regular.ttf':` + 
              `text='${WATERMARK_TEXT}':` +
              `fontsize=${WATERMARK_TEXT_SIZE}:` + 
              `fontcolor=white@0.7:` +
              `x=main_w-tw-${PADDING}:` + 
              `y=${PADDING}[v_wm]`; 

            // Final Chain: [0:v] -> Watermark Drawtext -> ASS -> [v]
            filterComplex = `[0:v]${watermarkDrawText};[v_wm]${assFilter}[v]`;
            
            ffArgs = [
                '-y', 
                '-i', inputPath, // Input 0: Video
                '-filter_complex', filterComplex,
                '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
            ];
        }
    } else {
        // NO Watermark (Paid Tier)
        // ... (No watermark logic remains unchanged)
        filterComplex = `[0:v]${assFilter}[v]`;

        ffArgs = [
            '-y', 
            '-i', inputPath, // Input 0: Video
            '-filter_complex', filterComplex,
            '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
        ];
    }


    // 5) Run ffmpeg
    // ... (FFmpeg execution, GCS upload, and callback remain unchanged)
    try {
      await runFFmpeg(ffArgs);
    } catch (ffErr) {
      console.error('ffmpeg failed:', ffErr);
      return res.status(500).json({ status: 'error', error: 'ffmpeg failed: ' + ffErr.message });
    }

    // 6) Upload result to GCS
    const destName = `renders/${job_id}-${Date.now()}.mp4`;
    let publicUrl;
    try {
      publicUrl = await uploadToGCS(outPath, destName);
    } catch (uerr) {
      console.error('upload failed:', uerr);
      return res.status(500).json({ status: 'error', error: 'upload failed: ' + uerr.message });
    }

    // 7) Optional callback to Bubble
    if (callback_url) {
      try {
        await axios.post(callback_url, {
          render_secret: RENDER_SECRET,
          job_id,
          status: 'success',
          video_url: publicUrl
        }, { timeout: 10000 });
      } catch (e) {
        console.warn('Callback failed (non-fatal):', e.message);
      }
    }

    // 8) Respond
    return res.json({ status: 'success', job_id, video_url: publicUrl });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ status: 'error', error: err.message || String(err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('listening on', port));

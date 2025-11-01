// server.js
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const { execSync, spawn } = require('child_process');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const app = express();
// Increased limit for larger JSON payloads
app.use(express.json({ limit: '200mb' })); 

const storage = new Storage();
const BUCKET = process.env.BUCKET_NAME || '';
const RENDER_SECRET = process.env.RENDER_SECRET || 'change_me';

// -------------------------
// Utility functions
// -------------------------
function runCommandSync(cmd) {
  // Utility for quick synchronous command execution (used for ffprobe)
  execSync(cmd, { stdio: 'inherit' });
}

function runFFmpeg(args) {
  // Promisified execution of ffmpeg command
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
  // Upload file
  await bucket.upload(localPath, { destination: destName });

  const file = bucket.file(destName);

  // Create a signed URL valid for 7 days (max allowed by GCS)
  const expiresDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); 
  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: expiresDate
  });

  return signedUrl;
}

function secToAss(tSec) {
  // Converts seconds (float) to ASS timestamp format H:MM:SS.cc
  const h = Math.floor(tSec / 3600);
  const m = Math.floor((tSec % 3600) / 60);
  const s = Math.floor(tSec % 60);
  const cs = Math.floor((tSec - Math.floor(tSec)) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function cssToAssColor(hex) {
  // Converts CSS hex color (#RRGGBB) to ASS color format (&HBBGGRR)
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) {
    return '&H00FFFFFF'; // Default to Opaque White
  }
  
  let r, g, b;
  
  if (hex.length === 7) { 
    r = hex.substring(1, 3);
    g = hex.substring(3, 5);
    b = hex.substring(5, 7);
  } else if (hex.length === 4) {
    r = hex.substring(1, 2).repeat(2);
    g = hex.substring(2, 3).repeat(2);
    b = hex.substring(3, 4).repeat(2);
  } else {
    return '&H00FFFFFF';
  }

  // ASS format is &H + Alpha (00 for Opaque) + Blue + Green + Red
  return `&H00${b}${g}${r}`.toUpperCase();
}


// ⭐ MAJOR CHANGE: Now accepts videoWidth and videoHeight from ffprobe
function framesToAss(frames, styles, videoWidth, videoHeight) {
  
  // Define default coordinate system based on actual video size
  const playResX = videoWidth;
  const playResY = videoHeight;
  
  // Use a sensible default for proportional calculations
  const defaultHeightForProportions = 1080; 

  // Style 1 (TOP Line in final video)
  const font1 = (styles && styles.fontTop) || 'Lexend';
  const size1 = (styles && styles.fontSizeTop) || 64;
  const color1Primary = cssToAssColor(styles && styles.colorTop);  
  const weight1 = (styles && (styles.fontWeightTop === '700')) ? '1' : '0';  
  const italic1 = (styles && styles.isItalicTop) ? '1' : '0';  

  // Style 2 (BOTTOM Line in final video)
  const font2 = (styles && styles.fontBottom) || 'Cormorant Garamond';
  const size2 = (styles && styles.fontSizeBottom) || 100;
  const color2Primary = cssToAssColor(styles && styles.colorBottom);  
  const weight2 = (styles && (styles.fontWeightBottom === '700')) ? '1' : '0';
  const italic2 = (styles && styles.isItalicBottom) ? '1' : '0';
  
  // Custom padding from the bottom edge for the BOTTOM LINE (Line 2)
  const paddingBottom = (styles && styles.paddingBottom) || 200;

  // --- CALCULATE FIXED Y-POSITIONS RELATIVE TO VIDEO HEIGHT ---
  
  // 1. Calculate the Y-coordinates based on the user's requested padding
  //    The padding value (e.g., 200px) is *proportional* to the 1080px reference height.
  const VERTICAL_GAP = 15; 
  
  // Scale factor: how much to scale the default 1080px proportions to the actual video height
  const scaleFactor = playResY / defaultHeightForProportions;

  // Y-position for Line 2 (BOTTOM LINE) - Scaled based on actual video height
  const proportionalPadding = paddingBottom * scaleFactor;
  // Position is measured from the top, so Y = Total Height - Scaled Padding
  const Y_pos_Line2 = playResY - proportionalPadding;
  
  // Y-position for Line 1 (TOP LINE) - Scale font size and gap for accurate placement
  const scaledSize2 = size2 * scaleFactor;
  const scaledGap = VERTICAL_GAP * scaleFactor;

  // Y_pos_Line1 is positioned above Line 2 by Line 2's scaled size + the scaled vertical gap.
  const Y_pos_Line1 = Y_pos_Line2 - scaledSize2 - scaledGap;

  // Setup for consistent shadows/outlines
  const shadowColor = '&H80000000'; 
  const outline = 0;  
  const shadow = 2; 
  
  // ALIGNMENT 2 (Bottom Center) is used for standard centering behavior.
  const CENTER_ALIGNMENT_MODE = 2; 

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0 
Title: Generated by AiVideoCaptioner

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: STYLE2,${font2},${size2},${color2Primary},${color2Primary},&H00000000,${shadowColor},${weight2},${italic2},0,0,100,100,0,0,1,${outline},${shadow},${CENTER_ALIGNMENT_MODE},20,20,0,1
Style: STYLE1,${font1},${size1},${color1Primary},${color1Primary},&H00000000,${shadowColor},${weight1},${italic1},0,0,100,100,0,0,1,${outline},${shadow},${CENTER_ALIGNMENT_MODE},20,20,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  
  const getPlainText = (lineText) => {
    // Allows manual line breaks \N for multi-line centering (if needed)
    return lineText ? lineText.trim().replace(/\n/g, '\\N') : '';
  };
  
  const events = frames.flatMap(f => {
    const frameStartSec = (f.start || 0) / 1000;
    const frameEndSec = (f.end || (frameStartSec + 2000)) / 1000;
    
    const assStart = secToAss(frameStartSec);
    const assEnd = secToAss(frameEndSec);
    
    const lines = [];
    
    // Line 1 (TOP) -> Uses STYLE1 and fixed Y position
    if (f.line1 && f.line1.trim() !== '') {
      const text1 = getPlainText(f.line1);
      // Use \pos to set the absolute center (X=videoWidth/2) and calculated Y position.
      lines.push(`Dialogue: 0,${assStart},${assEnd},STYLE1,,0,0,0,,{\\pos(${playResX / 2},${Y_pos_Line1})}${text1}`);
    }
    
    // Line 2 (BOTTOM) -> Uses STYLE2 and fixed Y position
    if (f.line2 && f.line2.trim() !== '') {
      const text2 = getPlainText(f.line2);
      lines.push(`Dialogue: 0,${assStart},${assEnd},STYLE2,,0,0,0,,{\\pos(${playResX / 2},${Y_pos_Line2})}${text2}`);
    }
    
    return lines;
  }).join('\n');
  
  return header + events;
}

// ⭐ NEW FUNCTION: Extracts video resolution using ffprobe
async function getVideoResolution(inputPath) {
  try {
    const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${inputPath}"`).toString().trim();
    const [w, h] = out.split(',');
    return { width: parseInt(w), height: parseInt(h) };
  } catch (e) {
    // Fallback to a safe default if ffprobe fails
    console.warn('ffprobe failed to get video resolution. Using 1920x1080 as fallback.');
    return { width: 1920, height: 1080 };
  }
}

// -------------------------
// Main /render endpoint
// -------------------------
app.post('/render', async (req, res) => {
  
  try {
    // 0) Authorization check
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
    try {
        console.log(`Attempting to download video from: ${video_url}`);
        const writer = (await axios({ url: video_url, method: 'GET', responseType: 'stream' })).data;
        const outStream = fsSync.createWriteStream(inputPath);
        await new Promise((resolve, reject) => {
          writer.pipe(outStream);
          writer.on('end', resolve);
          writer.on('error', reject);
        });
    } catch (e) {
        let errorMsg = 'Failed to download video. Please check the URL and access permissions.';
        if (e.response && e.response.status === 403) {
             errorMsg = `Video download failed with HTTP 403 Forbidden. Ensure the video URL (${video_url}) is publicly accessible.`;
        }
        console.error('Download error:', errorMsg, e.message);
        return res.status(500).json({ status: 'error', error: errorMsg });
    }
    
    // ⭐ NEW STEP: Get actual video resolution
    const videoResolution = await getVideoResolution(inputPath);
    console.log(`Video Resolution Detected: ${videoResolution.width}x${videoResolution.height}`);


    // 2) Download watermark image if needed
    let watermarkInput = null;
    if (shouldAddWatermark && watermark_url) {
        try {
            const logoWriter = (await axios({ url: watermark_url, method: 'GET', responseType: 'stream' })).data;
            const logoOutStream = fsSync.createWriteStream(watermarkPath);
            await new Promise((resolve, reject) => {
                logoWriter.pipe(logoOutStream);
                logoOutStream.on('close', resolve); 
                logoOutStream.on('error', reject);
            });
            watermarkInput = watermarkPath;
        } catch (e) {
            console.warn('Failed to download watermark image (Non-fatal, using text watermark):', e.message);
        }
    }

    // 3) Create ASS subtitles, passing actual resolution
    const ass = framesToAss(frames, style, videoResolution.width, videoResolution.height);
    await fs.writeFile(assPath, ass, 'utf8');

    // --- WATERMARK CONSTANTS ---
    const WATERMARK_TEXT = "AiVideoCaptioner";
    const WATERMARK_IMAGE_HEIGHT = 28; // Set to 28px
    const WATERMARK_TEXT_SIZE = 18; 
    const PADDING = 24; 

    // 4) Build ffmpeg filter_complex
    let ffArgs;
    const assFilter = `ass=filename=${assPath}:fontsdir=/app/fonts`;
    let filterComplex;

    if (shouldAddWatermark) {
        if (watermarkInput) {
            // Image Watermark setup (PNG input)
            
            // Filter 1: Scale watermark image, maintaining aspect ratio (-1)
            filterComplex = 
                `[0:v]scale=-1:${WATERMARK_IMAGE_HEIGHT}[wm_scaled];` + 
                // Filter 2: Overlay scaled watermark in the top-right corner
                `[1:v][wm_scaled]overlay=x=main_w-overlay_w-${PADDING}:y=${PADDING}[v_wm];`; 
            
            // Filter 3: Apply ASS subtitles to the watermarked video
            filterComplex += `[v_wm]${assFilter}[v]`;

            ffArgs = [
                '-y', 
                '-i', watermarkInput, // Input 0: Watermark Image
                '-i', inputPath, // Input 1: Video
                '-filter_complex', filterComplex,
                '-map', '[v]', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
            ];

        } else {
            // Text Watermark setup (Fallback if image download failed)
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
        filterComplex = `[0:v]${assFilter}[v]`;

        ffArgs = [
            '-y', 
            '-i', inputPath, // Input 0: Video
            '-filter_complex', filterComplex,
            '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', outPath
        ];
    }


    // 5) Run ffmpeg
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
    console.error('Server error (catch-all):', err);
    return res.status(500).json({ status: 'error', error: err.message || String(err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('listening on', port));

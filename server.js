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


// --- MODIFIED: framesToAss with Line-by-Line Fade Animation ---
function framesToAss(frames, styles, playResX = 1920, playResY = 1080) {
  
  // Style 1 (Top Line: Semibold/Default)
  const font1 = (styles && styles.fontTop) || 'Lexend';
  const size1 = (styles && styles.fontSizeTop) || 80;
  const color1Primary = cssToAssColor(styles && styles.colorTop); 
  const color1Secondary = cssToAssColor(styles && styles.colorBottom);
  
  const weight1 = (styles && (styles.fontWeightTop === '700')) ? '1' : '0'; 
  const italic1 = (styles && styles.isItalicTop) ? '1' : '0'; 

  // Style 2 (Bottom Line: Bold Italic 700)
  const font2 = (styles && styles.fontBottom) || 'Lexend';
  const size2 = (styles && styles.fontSizeBottom) || 80;
  const color2Primary = cssToAssColor(styles && styles.colorBottom); 
  const color2Secondary = cssToAssColor(styles && styles.colorTop);
  
  const weight2 = (styles && (styles.fontWeightBottom === '700')) ? '1' : '0';
  const italic2 = (styles && styles.isItalicBottom) ? '1' : '0';
  
  // --- Line Height & Padding Setup (FIXED) ---
  const marginV_Line2 = (styles && styles.paddingBottom) || 200;
  const LINE_OVERLAP = 10;
  const marginV_Line1 = marginV_Line2 + size2 - LINE_OVERLAP; 
  
  // --- Shadow Setup ---
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
Style: STYLE1,${font1},${size1},${color1Primary},${color1Secondary},&H00000000,${shadowColor},${weight1},${italic1},0,0,100,100,0,0,1,${outline},${shadow},2,20,20,${marginV_Line1},1
Style: STYLE2,${font2},${size2},${color2Primary},${color2Secondary},&H00000000,${shadowColor},${weight2},${italic2},0,0,100,100,0,0,1,${outline},${shadow},2,20,20,${marginV_Line2},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  
  // --- MODIFIED: Animation & Event Generation ---
  
  // Simple fade-in/out tag
  const FADE_TAG = '{\\fad(150,150)}';
  // Delay for the second line to appear
  const LINE_DELAY_MS = 100; 

  const events = frames.flatMap(f => {
    const startMs = f.start || 0;
    const endMs = f.end || (startMs + 2000); // default 2s duration
    
    // Line 1 starts normally
    const startAss_L1 = secToAss(startMs / 1000);
    // Both lines end at the same time
    const endAss = secToAss(endMs / 1000);
    
    // Line 2 starts with a delay
    // Ensure the delayed start time is not after the end time
    let startMs_L2 = startMs + LINE_DELAY_MS;
    if (startMs_L2 >= endMs) {
        startMs_L2 = startMs; // If delay is too long for a short clip, start them together
    }
    const startAss_L2 = secToAss(startMs_L2 / 1000);

    const lines = [];
    
    // Line 1: Fades in at the start time
    if (f.line1 && f.line1.trim() !== '') {
      // Handle \n for hard line breaks
      const text1 = `${FADE_TAG}${f.line1.trim().replace(/\n/g, '\\N')}`;
      lines.push(`Dialogue: 0,${startAss_L1},${endAss},STYLE1,,0,0,0,,${text1}`);
    }
    
    // Line 2: Fades in at the *delayed* start time
    if (f.line2 && f.line2.trim() !== '') {
      const text2 = `${FADE_TAG}${f.line2.trim().replace(/\n/g, '\\N')}`;
      lines.push(`Dialogue: 0,${startAss_L2},${endAss},STYLE2,,0,0,0,,${text2}`);
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

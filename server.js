import express from "express";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json({ limit: "50mb" }));

const storage = new Storage();
const bucketName = process.env.BUCKET_NAME;
const RENDER_SECRET = process.env.RENDER_SECRET;

const TMP_DIR = "/tmp";

// Utility: run command safely
function runCommandSync(cmd) {
  console.log("Running:", cmd);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    console.error("Command failed:", cmd, err.message);
    throw new Error(`Command failed: ${cmd}`);
  }
}

// Utility: convert ms → ASS timestamp (hh:mm:ss.ms)
function secToAss(sec) {
  const h = Math.floor(sec / 3600)
    .toString()
    .padStart(1, "0");
  const m = Math.floor((sec % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Convert frames data to two-style ASS subtitles.
 * - Top: Lexend, white
 * - Bottom: Cormorant Garamond, gold italic
 */
function framesToAss(frames, styles, playResX = 1920, playResY = 1080) {
  const topFont = (styles && (styles.fontTop || styles.font)) || "Lexend";
  const bottomFont =
    (styles && (styles.fontBottom || styles.font)) || "Cormorant Garamond";

  const topSize = (styles && styles.fontSizeTop) || 64;
  const bottomSize = (styles && styles.fontSizeBottom) || 56;

  const topColor = (styles && styles.colorTop) || "&H00FFFFFF"; // white
  const bottomColor = (styles && styles.colorBottom) || "&H00FFD100"; // gold

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CAP_TOP,${topFont},${topSize},${topColor},&H00000000,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,2,10,10,120,1
Style: CAP_BOTTOM,${bottomFont},${bottomSize},${bottomColor},&H00000000,&H00000000,&H00000000,0,1,0,0,100,100,0,0,1,3,0,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = frames
    .map((f) => {
      const startSec = (f.start || 0) / 1000;
      const endSec = (f.end || (startSec + 2000)) / 1000;
      const topText = (f.line1 || "")
        .replace(/\n/g, "\\N")
        .replace(/,/g, "\\,");
      const bottomText = (f.line2 || "")
        .replace(/\n/g, "\\N")
        .replace(/,/g, "\\,");
      return [
        `Dialogue: 0,${secToAss(startSec)},${secToAss(
          endSec
        )},CAP_TOP,,0,0,0,,${topText}`,
        `Dialogue: 0,${secToAss(startSec)},${secToAss(
          endSec
        )},CAP_BOTTOM,,0,0,0,,${bottomText}`,
      ].join("\n");
    })
    .join("\n");

  return header + events;
}

// =============== MAIN RENDER ROUTE ===============
app.post("/render", async (req, res) => {
  try {
    const {
      job_id,
      reservation_id,
      video_url,
      frames,
      style,
      plan_tier,
    } = req.body;

    const renderSecret = req.headers["x-render-secret"];
    if (renderSecret !== RENDER_SECRET) {
      return res
        .status(401)
        .json({ status: "error", error: "unauthorized" });
    }

    if (!video_url || !frames) {
      return res
        .status(400)
        .json({ status: "error", error: "Missing input video or frames" });
    }

    // File paths
    const baseName = `${job_id || "render"}-${Date.now()}`;
    const videoPath = path.join(TMP_DIR, `${baseName}.mp4`);
    const gradientPath = path.join(TMP_DIR, `${baseName}-grad.png`);
    const assPath = path.join(TMP_DIR, `${baseName}.ass`);
    const outputPath = path.join(TMP_DIR, `${baseName}-out.mp4`);

    // Download input video
    console.log("Downloading input video...");
    runCommandSync(`curl -L "${video_url}" -o "${videoPath}"`);

    // Create gradient overlay (bottom -> transparent)
    const gradH = 350;
    runCommandSync(
      `convert -size 1080x${gradH} gradient:"rgba(36,34,41,1)-rgba(36,34,41,0)" "${gradientPath}"`
    );

    // Create ASS subtitles
    const assContent = framesToAss(frames, style);
    fs.writeFileSync(assPath, assContent, "utf8");

    // Render final video
    const cmd = `ffmpeg -y -i "${videoPath}" -i "${gradientPath}" -filter_complex "[0:v][1:v]overlay=0:main_h-overlay_h[tmp];[tmp]ass='${assPath}'" -c:v libx264 -preset veryfast -crf 18 -c:a copy "${outputPath}"`;
    runCommandSync(cmd);

    // Upload result
    const bucket = storage.bucket(bucketName);
    await bucket.upload(outputPath, {
      destination: `renders/${path.basename(outputPath)}`,
    });

    const file = bucket.file(`renders/${path.basename(outputPath)}`);
    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      status: "success",
      job_id,
      reservation_id,
      video_url: signedUrl,
    });
  } catch (err) {
    console.error("Render failed:", err);
    res.status(500).json({ status: "error", error: err.message });
  }
});

// Root route
app.get("/", (req, res) => {
  res.send("FFmpeg renderer is running!");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

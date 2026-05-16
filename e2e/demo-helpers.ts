/**
 * Demo helpers for Playwright video recording.
 * Ported from ray_repub/e2e/demo/demo-helpers.ts
 *
 * Provides cursor overlay, captions, click animations, frame capture,
 * and ffmpeg-based video assembly.
 */

import { Page, Locator } from "@playwright/test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "../..");
export const FPS = 3;
export const FRAME_DIR = resolve(ROOT, "test-results/demo-frames");
export const CLIPS_DIR = resolve(ROOT, "test-results/demo-clips");
export const OUTPUT_DIR = ROOT;

/** Per-page frame counter, reset in initDemoPage */
let frameNum = 0;

/** Reset frame counter — call when not using initDemoPage */
export function resetFrameNum() { frameNum = 0; }

/** Full setup: set viewport, inject cursor/caption overlays. */
export async function initDemoPage(
  page: Page,
  url: string,
  opts: { injectExtension?: boolean; cursorColor?: string } = {}
) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Inject CSS animations for click ripples
  await page.addStyleTag({
    content: `
      @keyframes clickRipple1 {
        0% { transform: translate(-50%, -50%) scale(0.3); opacity: 1; }
        100% { transform: translate(-50%, -50%) scale(4); opacity: 0; }
      }
      @keyframes clickRipple2 {
        0% { transform: translate(-50%, -50%) scale(0.3); opacity: 0.8; }
        100% { transform: translate(-50%, -50%) scale(2.5); opacity: 0; }
      }
      @keyframes clickDot {
        0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        50% { transform: translate(-50%, -50%) scale(1.3); opacity: 0.9; }
        100% { transform: translate(-50%, -50%) scale(0); opacity: 0; }
      }
    `,
  });

  const cursorColor = opts.cursorColor || "#DC2626";
  // Inject cursor, ripples, and caption bar into the page
  await page.evaluate((color) => {
    // Pointer cursor SVG with custom color
    const cursor = document.createElement("div");
    cursor.id = "__demo-cursor";
    cursor.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 2L5 20L9.5 15.5L14.5 22L17.5 20.5L12.5 13.5L18 13L5 2Z" fill="${color}" stroke="white" stroke-width="1"/>
    </svg>`;
    cursor.style.cssText =
      "position:fixed;z-index:999999;pointer-events:none;top:0;left:0;" +
      "filter:drop-shadow(2px 3px 3px rgba(0,0,0,0.6));";
    document.body.appendChild(cursor);

    // Container for click ripple effects
    const rippleContainer = document.createElement("div");
    rippleContainer.id = "__demo-ripples";
    rippleContainer.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;z-index:999998;pointer-events:none;";
    document.body.appendChild(rippleContainer);

    // Caption bar at bottom of screen
    const caption = document.createElement("div");
    caption.id = "__demo-caption";
    caption.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:999999;pointer-events:none;" +
      "background:linear-gradient(transparent,rgba(0,0,0,0.9));padding:16px 32px 24px;" +
      "color:white;font-family:system-ui,-apple-system,sans-serif;font-size:20px;font-weight:600;" +
      "text-align:center;text-shadow:0 1px 3px rgba(0,0,0,0.5);min-height:64px;";
    caption.textContent = "";
    document.body.appendChild(caption);

    // Track real mouse position for cursor overlay
    document.addEventListener("mousemove", (e) => {
      cursor.style.left = e.clientX + "px";
      cursor.style.top = e.clientY + "px";
    });
  }, cursorColor);

  // Place cursor in center initially
  await page.mouse.move(640, 360);
  frameNum = 0;
}

/** Prepare frame directory for a specific page/act. */
export function initFrameDir(pageName: string) {
  const dir = resolve(FRAME_DIR, pageName);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(CLIPS_DIR, { recursive: true });
  return dir;
}

/** Update caption text shown at bottom of screen. */
export async function setCaption(page: Page, text: string) {
  await page.evaluate((t) => {
    const el = document.getElementById("__demo-caption");
    if (el) el.textContent = t;
  }, text);
}

/** Take a single screenshot (one frame). */
export async function snap(page: Page, frameDir: string) {
  frameNum++;
  await page.screenshot({
    path: resolve(frameDir, `frame-${String(frameNum).padStart(5, "0")}.png`),
  });
}

/** Record frames for a given duration at the configured FPS. */
export async function recordFrames(
  page: Page,
  frameDir: string,
  durationMs: number
) {
  const interval = 1000 / FPS;
  const frames = Math.max(1, Math.round(durationMs / interval));
  for (let i = 0; i < frames; i++) {
    await snap(page, frameDir);
    if (i < frames - 1) await page.waitForTimeout(interval);
  }
}

/** Smoothly move cursor along a bezier curve to (x, y). */
export async function moveCursorTo(
  page: Page,
  frameDir: string,
  x: number,
  y: number,
  durationMs = 600
) {
  const current = await page.evaluate(() => {
    const c = document.getElementById("__demo-cursor");
    return {
      x: parseFloat(c?.style.left || "0"),
      y: parseFloat(c?.style.top || "0"),
    };
  });

  const startX = current.x;
  const startY = current.y;
  const midX = (startX + x) / 2;
  const midY = (startY + y) / 2;
  // Add perpendicular offset for natural-looking curve
  const perpX = -(y - startY) * 0.12;
  const perpY = (x - startX) * 0.12;
  const ctrlX = midX + perpX;
  const ctrlY = midY + perpY;

  const waypoints = [0.25, 0.5, 0.75, 1.0];
  for (const t of waypoints) {
    const bx = (1 - t) ** 2 * startX + 2 * (1 - t) * t * ctrlX + t ** 2 * x;
    const by = (1 - t) ** 2 * startY + 2 * (1 - t) * t * ctrlY + t ** 2 * y;
    await page.mouse.move(bx, by);
    await snap(page, frameDir);
    await page.waitForTimeout(durationMs / waypoints.length);
  }
}

/** Show click ripple animation at (x, y). */
export async function showClickEffect(page: Page, x: number, y: number) {
  await page.evaluate(
    (coords) => {
      const container = document.getElementById("__demo-ripples");
      if (!container) return;

      const ring = document.createElement("div");
      ring.style.cssText = `
        position:absolute;left:${coords.x}px;top:${coords.y}px;
        width:40px;height:40px;border-radius:50%;
        border:4px solid rgba(220,38,38,0.9);background:transparent;
        animation:clickRipple1 0.7s ease-out forwards;pointer-events:none;
      `;
      container.appendChild(ring);

      const dot = document.createElement("div");
      dot.style.cssText = `
        position:absolute;left:${coords.x}px;top:${coords.y}px;
        width:20px;height:20px;border-radius:50%;
        background:rgba(220,38,38,0.8);
        animation:clickDot 0.5s ease-out forwards;pointer-events:none;
      `;
      container.appendChild(dot);

      setTimeout(() => {
        const ring2 = document.createElement("div");
        ring2.style.cssText = `
          position:absolute;left:${coords.x}px;top:${coords.y}px;
          width:30px;height:30px;border-radius:50%;
          border:3px solid rgba(255,255,255,0.7);background:transparent;
          animation:clickRipple2 0.5s ease-out forwards;pointer-events:none;
        `;
        container.appendChild(ring2);
      }, 100);

      setTimeout(() => {
        ring.remove();
        dot.remove();
      }, 800);
    },
    { x, y }
  );
}

/** Human-like move to element, click with animation. */
export async function humanClick(
  page: Page,
  frameDir: string,
  locator: Locator,
  opts: { click?: boolean; hoverDuration?: number } = {}
) {
  const doClick = opts.click !== false;
  const hoverMs = opts.hoverDuration ?? 400;

  const box = await locator.boundingBox();
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await moveCursorTo(page, frameDir, x, y);
  await recordFrames(page, frameDir, hoverMs);

  if (doClick) {
    await showClickEffect(page, x, y);
    await snap(page, frameDir);
    await page.waitForTimeout(100);
    await locator.click();
    await page.waitForTimeout(200);
  }
}

/** Convert a frame directory to a .webm video clip via ffmpeg. */
export function framesToVideo(frameDir: string, outputPath: string) {
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${frameDir}/frame-%05d.png" ` +
      `-c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 2M ` +
      `"${outputPath}"`,
    { stdio: "pipe" }
  );
  // Clean up raw frames
  if (existsSync(frameDir)) rmSync(frameDir, { recursive: true });
}

/** Generate a transition slide (text on dark background) as a short .webm clip. */
export function generateTransitionSlide(
  text: string,
  outputPath: string,
  durationSec = 2
) {
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  // Write text to a temp file to avoid shell escaping issues with drawtext
  const tmpTextFile = resolve(outputPath, "../transition-text.txt");
  writeFileSync(tmpTextFile, text);
  execSync(
    `ffmpeg -y -f lavfi -i color=c=0x1a1a1a:s=1280x720:d=${durationSec} ` +
      `-vf "drawtext=textfile='${tmpTextFile}':` +
      `fontsize=36:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:` +
      `shadowcolor=black:shadowx=2:shadowy=2" ` +
      `-c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 1M ` +
      `"${outputPath}"`,
    { stdio: "pipe" }
  );
}

/** Stitch ordered clips into final video using ffmpeg concat demuxer. */
export function stitchClips(clips: string[], outputPath: string) {
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  const listFile = resolve(outputPath, "../concat-list.txt");
  const content = clips
    .filter((c) => existsSync(c))
    .map((c) => `file '${c}'`)
    .join("\n");
  writeFileSync(listFile, content);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`,
    { stdio: "pipe" }
  );
}

/**
 * Blossom Explorer — Full Demo Walkthrough
 *
 * 5-act Playwright test that records a demo video showing:
 *   Act 1: Owner uploads files to Blossom via nsite paths
 *   Act 2: Auditor views shared files without login
 *   Act 3: Auditor creates baseline audit snapshot
 *   Act 4: Owner modifies a file (same path, different hash)
 *   Act 5: Second audit detects the tampering
 *
 * Each act records a video clip. Transitions stitched between acts.
 * Final video: blossom-explorer-demo.webm (in repo root)
 */

import { test, expect, Page } from "@playwright/test";
import {
  initDemoPage,
  initFrameDir,
  setCaption,
  recordFrames,
  humanClick,
  moveCursorTo,
  snap,
  showClickEffect,
  framesToVideo,
  generateTransitionSlide,
  stitchClips,
  resetFrameNum,
  CLIPS_DIR,
  OUTPUT_DIR,
} from "./demo-helpers";
import { PRODUCER, AUDITOR, injectNostrExtension, signEvent } from "./helpers";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const TEST_DATA = path.resolve(ROOT, "test_data");

// Use hardcoded demo keypairs (profiles pre-published to relays)
const owner = PRODUCER;
const auditor = AUDITOR;

const BLOSSOM_SERVER = "https://blossom.primal.net";
const PROXY = "http://localhost:3131/api/proxy";

// Track frame dirs and clip paths per act
let act1Dir: string;
let act2Dir: string;
let act3Dir: string;
let act4Dir: string;
let act5Dir: string;

const RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.wine"];

/** Discover all relays for a pubkey via NIP-65 (kind 10002) */
async function discoverRelays(pool: any, pubkey: string): Promise<string[]> {
  try {
    const events = await pool.querySync(RELAYS, { kinds: [10002], authors: [pubkey], limit: 1 }, {});
    if (events.length > 0) {
      const extra = events[0].tags.filter((t: string[]) => t[0] === 'r' && t[1]).map((t: string[]) => t[1]);
      return [...new Set([...RELAYS, ...extra])];
    }
  } catch {}
  return RELAYS;
}

/** Create a Blossom auth token (kind 24242) for API operations */
function createBlossomAuth(keypair: typeof owner, action: string, sha256?: string) {
  const tags = [["t", action], ["expiration", String(Math.floor(Date.now() / 1000) + 300)]];
  if (sha256) tags.push(["x", sha256]);
  const evt = signEvent(keypair, {
    kind: 24242,
    content: `Demo cleanup - ${action} - ${Date.now()}`,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  });
  return btoa(JSON.stringify(evt));
}

/** Proxy fetch through the explorer server */
async function proxyFetch(targetUrl: string, opts: RequestInit = {}) {
  return fetch(`${PROXY}?target=${encodeURIComponent(targetUrl)}`, opts);
}

/**
 * Full cleanup: delete all owner's Blossom blobs + nsite manifests + old audit snapshots.
 * Ensures a clean slate for each demo run.
 */
async function cleanDemoState() {
  console.log("Cleaning demo state...");

  // 1. Delete Blossom blobs
  try {
    const token = createBlossomAuth(owner, "list");
    const listResp = await proxyFetch(`${BLOSSOM_SERVER}/list/${owner.pubkeyHex}`, {
      headers: { "Authorization": `Nostr ${token}` },
    });
    if (listResp.ok) {
      const blobs = await listResp.json() as any[];
      console.log(`Found ${blobs.length} Blossom blobs to delete`);
      const delResults = await Promise.allSettled(blobs.map(async (blob: any) => {
        const delToken = createBlossomAuth(owner, "delete", blob.sha256);
        try {
          const r = await proxyFetch(`${BLOSSOM_SERVER}/${blob.sha256}`, {
            method: "DELETE",
            headers: { "Authorization": `Nostr ${delToken}` },
          });
          return { sha: blob.sha256?.slice(0, 12), status: r.status };
        } catch (e: any) {
          return { sha: blob.sha256?.slice(0, 12), error: e.message };
        }
      }));
      for (const r of delResults) {
        if (r.status === 'fulfilled') console.log(`  DELETE ${r.value.sha}... -> ${r.value.status || r.value.error}`);
      }
      // Verify deletion
      const verifyResp = await proxyFetch(`${BLOSSOM_SERVER}/list/${owner.pubkeyHex}`, {
        headers: { "Authorization": `Nostr ${createBlossomAuth(owner, "list")}` },
      });
      if (verifyResp.ok) {
        const remaining = await verifyResp.json() as any[];
        console.log(`Blobs remaining after deletion: ${remaining.length}`);
      }
    }
  } catch (e) {
    console.log("Blob cleanup failed (non-fatal):", (e as Error).message);
  }

  // 2. Delete nsite manifests (kind 15128, 35128)
  const { SimplePool } = await import("nostr-tools");
  const pool = new SimplePool();
  try {
    const manifests = await pool.querySync(RELAYS, {
      kinds: [15128, 35128],
      authors: [owner.pubkeyHex],
      limit: 50,
    }, {});
    if (manifests.length > 0) {
      console.log(`Deleting ${manifests.length} manifest(s)...`);
      for (const m of manifests) {
        const delEvent = signEvent(owner, {
          kind: 5,
          content: "Demo cleanup — deleting old manifest",
          tags: [["e", m.id], ["k", String(m.kind)]],
          created_at: Math.floor(Date.now() / 1000),
        });
        try { await Promise.allSettled(pool.publish(RELAYS, delEvent)); } catch {}
      }
    }
  } catch (e) {
    console.log("Manifest cleanup failed (non-fatal):", (e as Error).message);
  }

  // 3. Note: Snapshot cleanup (kind 5128) is handled in Act 3 via subprocess,
  //    since Playwright test worker can't reach Nostr relays via WebSocket.

  pool.close(RELAYS);
  console.log("Demo state cleaned.");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(300000); // 5 min for cleanup
  console.log(`Owner:  ${owner.npub}`);
  console.log(`Auditor: ${auditor.npub}`);

  // Full cleanup for clean demo
  await cleanDemoState();

  // Wait for relay deletion events to propagate
  await new Promise(r => setTimeout(r, 3000));

  act1Dir = initFrameDir("act1-owner-upload");
  act2Dir = initFrameDir("act2-auditor-shared");
  act3Dir = initFrameDir("act3-first-snapshot");
  act4Dir = initFrameDir("act4-owner-modify");
  act5Dir = initFrameDir("act5-second-audit");

  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

// ============================================================
// ACT 1: Owner uploads files
// ============================================================
test("act1 - owner uploads files", async ({ page }) => {
  test.setTimeout(60000);
  await injectNostrExtension(page, owner);
  // Clear localStorage on every page load to prevent auto-login
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await initDemoPage(page, "/", { cursorColor: "#22c55e" });

  await setCaption(page, "Blossom Explorer — File Upload Demo");
  await recordFrames(page, act1Dir, 2500);

  // Wait for extension detection + login button to enable
  await page.waitForFunction(() => {
    const btn = document.getElementById("loginBtn") as HTMLButtonElement;
    return btn && !btn.disabled;
  });

  // Set server URL
  await humanClick(page, act1Dir, page.locator("#serverInput"));
  await page.locator("#serverInput").fill(BLOSSOM_SERVER);
  await recordFrames(page, act1Dir, 500);

  // Click Connect
  await setCaption(page, "Logging in with Nostr identity...");
  await humanClick(page, act1Dir, page.locator("#loginBtn"));
  await page.waitForSelector("#app[style*='block'], #app:not([style*='none'])", {
    timeout: 15000,
  });
  await recordFrames(page, act1Dir, 3000);

  // Wait for blobs to load (should be empty after cleanup)
  await page.waitForFunction(() => {
    const content = document.getElementById("content");
    return content && !content.querySelector(".loading");
  }, { timeout: 30000 }).catch(() => {});

  await setCaption(page, "Owner connected — empty workspace, ready to upload");
  await recordFrames(page, act1Dir, 2000);

  // Move cursor to "Upload Files" button, show click, then set files
  const uploadBtn = page.locator("#uploadFilesBtn");
  await setCaption(page, "Clicking Upload Files...");
  // Move to the button
  const uploadBox = await uploadBtn.boundingBox();
  if (uploadBox) {
    const ux = uploadBox.x + uploadBox.width / 2;
    const uy = uploadBox.y + uploadBox.height / 2;
    await moveCursorTo(page, act1Dir, ux, uy);
    await recordFrames(page, act1Dir, 400);
    await showClickEffect(page, ux, uy);
    await snap(page, act1Dir);
    await page.waitForTimeout(200);
  }

  // Set files on the hidden input (simulates file picker selection)
  const testFiles = [
    "readme.md",
    "sales-data.csv",
    "config.json",
    "document.pdf",
    "notes.txt",
  ].map((f) => path.join(TEST_DATA, f));

  await page.locator("#fileInput").setInputFiles(testFiles);

  await setCaption(page, `Uploading files to ${BLOSSOM_SERVER.replace("https://", "")}...`);
  await recordFrames(page, act1Dir, 2000);

  // Wait for uploads to finish — poll upload progress until done or timeout
  await page.waitForFunction(() => {
    const el = document.getElementById("uploadProgress");
    if (!el) return true;
    // Check if all items show "done" or "error"
    const items = el.querySelectorAll(".upload-item");
    if (items.length === 0) return false;
    return Array.from(items).every(item => {
      const status = item.querySelector(".upload-status")?.textContent || "";
      return status.includes("done") || status.includes("error") || status.includes("failed");
    });
  }, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1000);

  await setCaption(page, "Files uploaded successfully!");
  await recordFrames(page, act1Dir, 3000);

  // Click readme.md in the tree to show text preview
  const readmeTreeItem = page.locator(".tree-item .name").filter({ hasText: "readme.md" }).locator("..");
  if (await readmeTreeItem.count() > 0) {
    await setCaption(page, "Previewing readme.md content...");
    await humanClick(page, act1Dir, readmeTreeItem.first());
    // Wait for text preview content to load via proxyFetch
    await page.waitForFunction(() => {
      const pre = document.getElementById("text-preview-content");
      return pre && pre.textContent !== "Loading...";
    }, { timeout: 10000 }).catch(() => {});
    await recordFrames(page, act1Dir, 4000);
    // Close modal
    await page.locator("#detailModal .btn-sm").last().click().catch(() => {});
    await page.waitForTimeout(500);
  }

  // Convert frames to video
  const act1Clip = `${CLIPS_DIR}/act1.webm`;
  console.log(`[act1] Encoding ${act1Dir} -> ${act1Clip}`);
  const { existsSync } = await import("fs");
  const frames = existsSync(act1Dir) ? fs.readdirSync(act1Dir).length : 0;
  console.log(`[act1] Frames: ${frames}`);
  if (frames > 0) {
    framesToVideo(act1Dir, act1Clip);
    console.log(`[act1] Clip created: ${act1Clip} (${existsSync(act1Clip) ? "exists" : "MISSING"})`);
  } else {
    console.log(`[act1] No frames captured!`);
  }
});

// ============================================================
// ACT 2: Auditor views shared files
// ============================================================
test("act2 - auditor views shared files", async ({ page }) => {
  test.setTimeout(120000);
  const act2Start = Date.now();
  resetFrameNum();

  // Manual setup — initDemoPage hangs on shared view due to relay queries blocking evaluate
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/${owner.npub}`, { waitUntil: "commit" });

  // Wait for page to settle, then inject overlays
  await page.waitForTimeout(3000);

  // Inject cursor and caption manually
  await page.evaluate((color) => {
    const cursor = document.createElement("div");
    cursor.id = "__demo-cursor";
    cursor.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 2L5 20L9.5 15.5L14.5 22L17.5 20.5L12.5 13.5L18 13L5 2Z" fill="${color}" stroke="white" stroke-width="1"/>
    </svg>`;
    cursor.style.cssText = "position:fixed;z-index:999999;pointer-events:none;top:0;left:0;filter:drop-shadow(2px 3px 3px rgba(0,0,0,0.6));";
    document.body.appendChild(cursor);
    const rippleContainer = document.createElement("div");
    rippleContainer.id = "__demo-ripples";
    rippleContainer.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:999998;pointer-events:none;";
    document.body.appendChild(rippleContainer);
    const caption = document.createElement("div");
    caption.id = "__demo-caption";
    caption.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:999999;pointer-events:none;background:linear-gradient(transparent,rgba(0,0,0,0.9));padding:16px 32px 24px;color:white;font-family:system-ui,-apple-system,sans-serif;font-size:20px;font-weight:600;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,0.5);min-height:64px;";
    caption.textContent = "";
    document.body.appendChild(caption);
    document.addEventListener("mousemove", (e) => { cursor.style.left = e.clientX + "px"; cursor.style.top = e.clientY + "px"; });
  }, "#ef4444");
  await page.mouse.move(640, 360);

  await setCaption(page, "Shared View — No login required");
  await recordFrames(page, act2Dir, 2000);

  // Wait for shared view to load (manifests from relays) — give 15s max
  await page.waitForFunction(() => {
    const el = document.getElementById("content");
    return el && !el.querySelector(".loading");
  }, { timeout: 15000 }).catch(() => {});

  await setCaption(page, `Viewing ${owner.npub.slice(0, 20)}... via nsite manifests`);
  await recordFrames(page, act2Dir, 2000);

  // The tree is built from manifest path tags fetched from relays
  const treeItems = page.locator(".tree-item");
  const treeCount = await treeItems.count();
  await setCaption(page, treeCount > 0
    ? `Found ${treeCount} items in file tree — manifest-based listing`
    : "Shared view loaded — manifest may still be publishing"
  );
  await recordFrames(page, act2Dir, 2000);

  // Click readme.md specifically to show file details
  const readmeTreeItem = page.locator(".tree-item .name").filter({ hasText: "readme.md" }).locator("..");
  const readmeCount = await readmeTreeItem.count();
  console.log(`[act2] readme.md found: ${readmeCount}, elapsed: ${Date.now() - act2Start}ms`);
  if (readmeCount > 0) {
    await setCaption(page, "Viewing readme.md in shared view");
    await humanClick(page, act2Dir, readmeTreeItem.first());
    console.log(`[act2] after humanClick, elapsed: ${Date.now() - act2Start}ms`);
    await page.waitForTimeout(2000);
    await recordFrames(page, act2Dir, 3000);
    // Close modal
    await page.locator("#detailModal .btn-sm").last().click().catch(() => {});
    await page.waitForTimeout(500);
  }

  framesToVideo(act2Dir, `${CLIPS_DIR}/act2.webm`);
});

// ============================================================
// ACT 3: First audit snapshot
// ============================================================
test("act3 - first audit snapshot", async ({ page }) => {
  test.setTimeout(120000);

  // Delete old audit snapshots via subprocess (Playwright worker can't reach relays via WebSocket)
  const fs = await import('fs');
  const path = await import('path');
  const projectRoot = path.resolve(__dirname, '../..');
  const tmpScript = path.join(projectRoot, '_delete_snapshots.mjs');
  fs.writeFileSync(tmpScript, `
import { SimplePool, finalizeEvent } from 'nostr-tools';
const pool = new SimplePool();
const RELAYS = ${JSON.stringify(RELAYS)};
const ownerPubkey = '${owner.pubkeyHex}';
const auditorSec = new Uint8Array([${Array.from(auditor.secretKey).join(',')}]);
const ownerSec = new Uint8Array([${Array.from(owner.secretKey).join(',')}]);

const events = await pool.querySync(RELAYS, { kinds: [5128], '#p': [ownerPubkey], limit: 100 });
console.log('Found ' + events.length + ' snapshots');
for (const evt of events) {
  for (const sec of [auditorSec, ownerSec]) {
    const del = finalizeEvent({
      kind: 5,
      content: 'demo cleanup',
      tags: [['e', evt.id], ['k', '5128']],
      created_at: Math.floor(Date.now() / 1000),
    }, sec);
    await Promise.allSettled(pool.publish(RELAYS, del));
  }
}
console.log('Deleted ' + events.length + ' snapshots');
pool.close(RELAYS);
`);
  const { execSync } = await import('child_process');
  try {
    const result = execSync(`bun run ${tmpScript}`, { timeout: 30000 }).toString();
    console.log(`[act3] Snapshot cleanup: ${result.trim()}`);
  } catch (e: any) {
    console.log(`[act3] Snapshot cleanup error: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }

  // Wait for deletion propagation
  await new Promise(r => setTimeout(r, 5000));

  // Inject auditor's NIP-07 mock so audit page auto-detects extension
  await injectNostrExtension(page, auditor);
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await initDemoPage(page, "/audit/", { cursorColor: "#ef4444" });

  await setCaption(page, "Blossom Audit — Baseline Snapshot");
  await recordFrames(page, act3Dir, 2500);

  // Wait for audit page init() to finish (polls for window.nostr ~2s)
  await page.waitForTimeout(3000);
  await page.waitForSelector("#nsecInput");

  // Enter owner's npub as target
  await humanClick(page, act3Dir, page.locator("#targetInput"));
  await page.locator("#targetInput").clear();
  await page.locator("#targetInput").fill(owner.npub);
  await recordFrames(page, act3Dir, 800);

  // Click Connect & Audit
  await setCaption(page, "Logging in as auditor...");
  await humanClick(page, act3Dir, page.locator("#loginBtn"));

  // Wait for login screen to hide (showApp() sets this sync, then loads data async)
  await page.waitForFunction(() => {
    const ls = document.getElementById("loginScreen");
    return ls && ls.style.display === "none";
  }, { timeout: 30000 });

  // Wait for showApp() to finish loading (renderStatus shows snapshot count)
  await page.waitForFunction(() => {
    const main = document.getElementById('main');
    if (!main || main.innerHTML.length < 50) return false;
    return main.querySelector('.snapshot-item') !== null || main.textContent?.includes('No snapshots yet') || main.textContent?.includes('file paths');
  }, { timeout: 45000 });
  await recordFrames(page, act3Dir, 2000);

  // Create snapshot
  await setCaption(page, "Creating baseline snapshot...");
  await humanClick(page, act3Dir, page.locator("#snapshotBtn"));
  // Wait for snapshot to finish (button text resets from "Loading..." or button hides)
  await page.waitForFunction(() => {
    const btn = document.getElementById('snapshotBtn');
    // Either button hides (success) or text resets (error)
    return (btn && btn.style.display === 'none') || (btn && btn.textContent !== 'Loading...' && !btn.disabled);
  }, { timeout: 30000 });

  await recordFrames(page, act3Dir, 2000);

  // Publish snapshot
  const publishBtn = page.locator("#publishBtn");
  if (await publishBtn.isVisible()) {
    await setCaption(page, "Publishing snapshot to Nostr relays (kind 5128)");
    await humanClick(page, act3Dir, publishBtn);
    await page.waitForTimeout(5000);
    await recordFrames(page, act3Dir, 3000);
  } else {
    console.log("publishBtn NOT visible — snapshot creation may have failed");
  }

  await setCaption(page, "Baseline snapshot recorded!");
  await recordFrames(page, act3Dir, 2000);

  framesToVideo(act3Dir, `${CLIPS_DIR}/act3.webm`);
});

// ============================================================
// ACT 4: Owner modifies a file
// ============================================================
test("act4 - owner modifies a file", async ({ page }) => {
  test.setTimeout(60000);
  await injectNostrExtension(page, owner);
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await initDemoPage(page, "/", { cursorColor: "#22c55e" });

  // Login
  await page.waitForFunction(() => {
    const btn = document.getElementById("loginBtn") as HTMLButtonElement;
    return btn && !btn.disabled;
  });

  await page.locator("#serverInput").fill(BLOSSOM_SERVER);
  await setCaption(page, "Owner reconnects to modify a file...");
  await humanClick(page, act4Dir, page.locator("#loginBtn"));
  await page.waitForSelector("#app:not([style*='none'])", { timeout: 15000 });
  await recordFrames(page, act4Dir, 3000);

  // Wait for content to load
  await page.waitForTimeout(5000);

  // Show original readme.md before modifying (text preview)
  const readmeTreeItem = page.locator(".tree-item .name").filter({ hasText: "readme.md" }).locator("..");
  if (await readmeTreeItem.count() > 0) {
    await setCaption(page, "Original readme.md — about to replace this file...");
    await humanClick(page, act4Dir, readmeTreeItem.first());
    await page.waitForFunction(() => {
      const pre = document.getElementById("text-preview-content");
      return pre && pre.textContent !== "Loading...";
    }, { timeout: 10000 }).catch(() => {});
    await recordFrames(page, act4Dir, 3000);
    await page.locator("#detailModal .btn-sm").last().click().catch(() => {});
    await page.waitForTimeout(500);
  }

  // Create a modified version of readme.md — MUST keep same filename to replace the path in manifest
  const modifiedContent = `# Modified Readme\n\nThis file has been TAMPERED with!\nChanged at: ${new Date().toISOString()}\n`;
  const modifiedPath = path.join(TEST_DATA, "..", "..", "test-results", "readme.md");
  fs.mkdirSync(path.dirname(modifiedPath), { recursive: true });
  fs.writeFileSync(modifiedPath, modifiedContent);

  // Show what the modified content looks like
  await setCaption(page, `Modified: "${modifiedContent.split("\n")[0]}" — same filename, different content!`);
  await recordFrames(page, act4Dir, 3000);

  // Upload modified file (same name = replaces path in manifest)
  await setCaption(page, "Uploading modified readme.md — SHA-256 hash will change!");

  // Move cursor to Upload Files button and click it visually
  const uploadBtn = page.locator("#uploadFilesBtn");
  const uploadBox = await uploadBtn.boundingBox();
  if (uploadBox) {
    const ux = uploadBox.x + uploadBox.width / 2;
    const uy = uploadBox.y + uploadBox.height / 2;
    await moveCursorTo(page, act4Dir, ux, uy);
    await recordFrames(page, act4Dir, 400);
    await showClickEffect(page, ux, uy);
    await snap(page, act4Dir);
    await page.waitForTimeout(200);
  }

  await page.locator("#fileInput").setInputFiles([modifiedPath]);

  // Wait for upload to complete
  await page.waitForFunction(() => {
    const el = document.getElementById("uploadProgress");
    if (!el) return true;
    const items = el.querySelectorAll(".upload-item");
    if (items.length === 0) return false;
    return Array.from(items).every(item => {
      const status = item.querySelector(".upload-status")?.textContent || "";
      return status.includes("done") || status.includes("error") || status.includes("failed");
    });
  }, { timeout: 60000 }).catch(() => {});
  await recordFrames(page, act4Dir, 3000);

  // Show the file after modification (text preview with new content)
  if (await readmeTreeItem.count() > 0) {
    await setCaption(page, "Viewing replaced readme.md — new content, new hash!");
    await humanClick(page, act4Dir, readmeTreeItem.first());
    await page.waitForFunction(() => {
      const pre = document.getElementById("text-preview-content");
      return pre && pre.textContent !== "Loading...";
    }, { timeout: 10000 }).catch(() => {});
    await recordFrames(page, act4Dir, 4000);
    await page.locator("#detailModal .btn-sm").last().click().catch(() => {});
    await page.waitForTimeout(500);
  }

  await setCaption(page, "File replaced — the SHA-256 hash is now different");
  await recordFrames(page, act4Dir, 3000);

  // Clean up temp file
  fs.unlinkSync(modifiedPath);

  framesToVideo(act4Dir, `${CLIPS_DIR}/act4.webm`);
});

// ============================================================
// ACT 5: Second audit detects change
// ============================================================
test("act5 - second audit detects change", async ({ page }) => {
  test.setTimeout(120000);

  // Inject auditor's NIP-07 mock
  await injectNostrExtension(page, auditor);
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await initDemoPage(page, "/audit/", { cursorColor: "#ef4444" });

  await setCaption(page, "Blossom Audit — Detecting File Changes");
  await recordFrames(page, act5Dir, 2500);

  // Wait for audit page init() to finish
  await page.waitForTimeout(3000);

  // Login as auditor — enter owner's npub as target
  await page.waitForSelector("#targetInput");
  await page.locator("#targetInput").clear();
  await page.locator("#targetInput").fill(owner.npub);
  await setCaption(page, `Logging in to audit ${owner.npub.slice(0, 20)}...`);
  await humanClick(page, act5Dir, page.locator("#loginBtn"));
  await page.waitForFunction(() => {
    const ls = document.getElementById("loginScreen");
    return ls && ls.style.display === "none";
  }, { timeout: 30000 });

  // Wait for showApp() to finish — renderStatus called (snapshot history visible)
  await page.waitForFunction(() => {
    const main = document.getElementById('main');
    return main && main.innerHTML.length > 50;
  }, { timeout: 45000 });
  await recordFrames(page, act5Dir, 2000);

  // Wait for snapshots to appear from relays
  await setCaption(page, "Waiting for previous snapshots to load...");
  await page.waitForFunction(() => {
    const main = document.getElementById('main');
    return main && (main.textContent?.includes('Snapshot History') || main.textContent?.includes('Snapshots'));
  }, { timeout: 30000 });
  await recordFrames(page, act5Dir, 2000);

  // Show the snapshot history timeline
  await setCaption(page, "Previous baseline snapshot loaded from Nostr relays");
  await recordFrames(page, act5Dir, 3000);

  // Run audit — compares baseline snapshot against current manifest
  await setCaption(page, "Running audit — comparing current state against baseline...");
  await humanClick(page, act5Dir, page.locator("#auditBtn"));

  // Wait for audit results to render (summary cards with Changed/New counts)
  await page.waitForFunction(() => {
    const main = document.getElementById('main');
    return main && (main.textContent?.includes('Changed') || main.textContent?.includes('No changes'));
  }, { timeout: 30000 });
  await recordFrames(page, act5Dir, 3000);

  // Check audit results
  const changedCount = await page.locator(".summary-card.changed .number").textContent();
  const newCount = await page.locator(".summary-card.new .number").textContent();
  const hasChanges = changedCount !== "0" || newCount !== "0";

  if (hasChanges) {
    await setCaption(page, `AUDIT RESULT: ${changedCount} changed, ${newCount} new files detected!`);
  } else {
    await setCaption(page, "Audit complete — no changes detected");
  }
  await recordFrames(page, act5Dir, 4000);

  // Click "history" on the changed file row to see hash timeline
  const historyBtn = page.locator(".history-toggle").first();
  if (await historyBtn.isVisible()) {
    await setCaption(page, "Viewing file hash history...");
    await humanClick(page, act5Dir, historyBtn);
    await page.waitForTimeout(2000);
    await recordFrames(page, act5Dir, 3000);
  }

  // Click the "diff" button on the changed file to show side-by-side diff
  const diffBtn = page.locator("button").filter({ hasText: "diff" }).first();
  if (await diffBtn.isVisible()) {
    await setCaption(page, "Side-by-side diff — comparing file versions...");
    await humanClick(page, act5Dir, diffBtn);
    // Wait for diff modal content to load
    await page.waitForFunction(() => {
      const body = document.getElementById("diffModalBody");
      return body && !body.textContent?.includes("Loading");
    }, { timeout: 15000 }).catch(() => {});
    await recordFrames(page, act5Dir, 5000);
    // Close diff modal
    const diffModal = page.locator("#diffModal");
    if (await diffModal.isVisible()) {
      await diffModal.locator("button").first().click();
      await page.waitForTimeout(500);
    }
  }

  // Finale
  await setCaption(page, hasChanges
    ? "Blossom Audit — integrity change detected through Nostr snapshots!"
    : "Blossom Audit — integrity verification complete"
  );
  await recordFrames(page, act5Dir, 15000);

  framesToVideo(act5Dir, `${CLIPS_DIR}/act5.webm`);
});

// ============================================================
// Stitch all clips into final video (runs after all tests)
// ============================================================
test.afterAll(() => {
  const clips = [
    `${CLIPS_DIR}/act1.webm`,
    `${CLIPS_DIR}/act2.webm`,
    `${CLIPS_DIR}/act3.webm`,
    `${CLIPS_DIR}/act4.webm`,
    `${CLIPS_DIR}/act5.webm`,
  ];

  // Generate transition slides between acts
  const transitions = [
    { text: "Act 1: Owner Uploads Files", file: `${CLIPS_DIR}/trans1.webm` },
    { text: "Act 2: Auditor Views Shared Files", file: `${CLIPS_DIR}/trans2.webm` },
    { text: "Act 3: Creating Baseline Snapshot", file: `${CLIPS_DIR}/trans3.webm` },
    { text: "Act 4: Owner Modifies a File", file: `${CLIPS_DIR}/trans4.webm` },
    { text: "Act 5: Second Audit Detects Changes", file: `${CLIPS_DIR}/trans5.webm` },
  ];

  for (const t of transitions) {
    if (!fs.existsSync(t.file)) {
      generateTransitionSlide(t.text, t.file, 2);
    }
  }

  // Interleave transitions and clips
  const allClips: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    allClips.push(transitions[i].file);
    if (fs.existsSync(clips[i])) {
      allClips.push(clips[i]);
    }
  }

  const finalOutput = `${OUTPUT_DIR}/blossom-explorer-demo.webm`;
  stitchClips(allClips, finalOutput);

  console.log(`\nDemo video: ${finalOutput}`);
  console.log(`Owner npub: ${owner.npub}`);
  console.log(`Auditor npub: ${auditor.npub}`);
});

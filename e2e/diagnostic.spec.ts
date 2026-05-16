/**
 * Diagnostic test — verify cursor movement and clean workspace.
 * Runs only Act 1 with debug screenshots and DOM checks.
 */

import { test, expect } from "@playwright/test";
import {
  initDemoPage,
  initFrameDir,
  setCaption,
  recordFrames,
  humanClick,
  moveCursorTo,
  snap,
  CLIPS_DIR,
} from "./demo-helpers";
import { PRODUCER, injectNostrExtension, signEvent } from "./helpers";
import * as fs from "fs";
import * as path from "path";

const BLOSSOM_SERVER = "https://blossom.primal.net";
const PROXY = "http://localhost:3131/api/proxy";
const RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.wine"];

const owner = PRODUCER;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // Clean workspace
  console.log("=== DIAGNOSTIC CLEANUP ===");

  // Delete Blossom blobs
  const { SimplePool } = await import("nostr-tools");
  const pool = new SimplePool();

  try {
    const tags = [["t", "list"], ["expiration", String(Math.floor(Date.now() / 1000) + 300)]];
    const listEvt = signEvent(owner, { kind: 24242, content: "diag list", tags, created_at: Math.floor(Date.now() / 1000) });
    const token = btoa(JSON.stringify(listEvt));
    const resp = await fetch(`${PROXY}?target=${encodeURIComponent(`${BLOSSOM_SERVER}/list/${owner.pubkeyHex}`)}`, {
      headers: { "Authorization": `Nostr ${token}` },
    });
    if (resp.ok) {
      const blobs = await resp.json() as any[];
      console.log(`Blobs on server: ${blobs.length}`);
      for (const b of blobs) {
        const delTags = [["t", "delete"], ["expiration", String(Math.floor(Date.now() / 1000) + 300)], ["x", b.sha256]];
        const delEvt = signEvent(owner, { kind: 24242, content: "diag delete", tags: delTags, created_at: Math.floor(Date.now() / 1000) });
        const delToken = btoa(JSON.stringify(delEvt));
        const dr = await fetch(`${PROXY}?target=${encodeURIComponent(`${BLOSSOM_SERVER}/${b.sha256}`)}`, {
          method: "DELETE",
          headers: { "Authorization": `Nostr ${delToken}` },
        });
        console.log(`  DELETE ${b.sha256?.slice(0, 12)} -> ${dr.status}`);
      }
    }
  } catch (e) {
    console.log("Blob cleanup error:", (e as Error).message);
  }

  // Delete manifests
  try {
    const manifests = await pool.querySync(RELAYS, {
      kinds: [15128, 35128],
      authors: [owner.pubkeyHex],
      limit: 50,
    }, {});
    console.log(`Manifests on relays: ${manifests.length}`);
    for (const m of manifests) {
      const del = signEvent(owner, {
        kind: 5,
        content: "diag cleanup manifest",
        tags: [["e", m.id], ["k", String(m.kind)]],
        created_at: Math.floor(Date.now() / 1000),
      });
      await Promise.allSettled(pool.publish(RELAYS, del));
    }
  } catch (e) {
    console.log("Manifest cleanup error:", (e as Error).message);
  }

  pool.close(RELAYS);

  // Wait for relay propagation
  console.log("Waiting 5s for relay propagation...");
  await new Promise(r => setTimeout(r, 5000));

  // Verify manifests are gone
  const pool2 = new SimplePool();
  const verify = await pool2.querySync(RELAYS, {
    kinds: [15128, 35128],
    authors: [owner.pubkeyHex],
    limit: 50,
  }, {});
  console.log(`Manifests after cleanup: ${verify.length}`);
  pool2.close(RELAYS);
});

test("diag - cursor movement check", async ({ page }) => {
  test.setTimeout(30000);

  await injectNostrExtension(page, owner);
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });

  // Use initDemoPage like Act 1 does
  await initDemoPage(page, "/", { cursorColor: "#22c55e" });

  // CHECK 1: Does the cursor overlay exist?
  const cursorExists = await page.evaluate(() => !!document.getElementById("__demo-cursor"));
  console.log(`CHECK 1 - Cursor overlay exists: ${cursorExists}`);
  expect(cursorExists).toBe(true);

  // CHECK 2: Check cursor initial position
  const cursorPos = await page.evaluate(() => {
    const c = document.getElementById("__demo-cursor");
    return { left: c?.style.left, top: c?.style.top };
  });
  console.log(`CHECK 2 - Cursor initial pos: left=${cursorPos.left}, top=${cursorPos.top}`);

  // CHECK 3: Move mouse and check if cursor follows
  await page.mouse.move(100, 100);
  await page.waitForTimeout(100);
  const posAfterMove1 = await page.evaluate(() => {
    const c = document.getElementById("__demo-cursor");
    return { left: c?.style.left, top: c?.style.top };
  });
  console.log(`CHECK 3 - After mouse.move(100,100): left=${posAfterMove1.left}, top=${posAfterMove1.top}`);

  await page.mouse.move(500, 300);
  await page.waitForTimeout(100);
  const posAfterMove2 = await page.evaluate(() => {
    const c = document.getElementById("__demo-cursor");
    return { left: c?.style.left, top: c?.style.top };
  });
  console.log(`CHECK 3b - After mouse.move(500,300): left=${posAfterMove2.left}, top=${posAfterMove2.top}`);

  // CHECK 4: Does moveCursorTo (bezier) update cursor position?
  const frameDir = initFrameDir("diag-cursor");
  await moveCursorTo(page, frameDir, 800, 500, 400);
  const posAfterBezier = await page.evaluate(() => {
    const c = document.getElementById("__demo-cursor");
    return { left: c?.style.left, top: c?.style.top };
  });
  console.log(`CHECK 4 - After moveCursorTo(800,500): left=${posAfterBezier.left}, top=${posAfterBezier.top}`);

  // Screenshot for visual verification
  await page.screenshot({ path: "test-results/diag-cursor-check.png" });
  console.log("Screenshot saved: test-results/diag-cursor-check.png");
});

test("diag - workspace clean check", async ({ page }) => {
  test.setTimeout(60000);

  await injectNostrExtension(page, owner);
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await initDemoPage(page, "/", { cursorColor: "#22c55e" });

  // Wait for login button to enable
  await page.waitForFunction(() => {
    const btn = document.getElementById("loginBtn") as HTMLButtonElement;
    return btn && !btn.disabled;
  }, { timeout: 10000 });

  // Set server and login
  await page.locator("#serverInput").fill(BLOSSOM_SERVER);
  await page.locator("#loginBtn").click();
  await page.waitForSelector("#app:not([style*='none'])", { timeout: 15000 });

  // Wait for showApp to finish loading
  await page.waitForFunction(() => {
    const content = document.getElementById("content");
    return content && !content.querySelector(".loading");
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // CHECK 5: How many tree items are visible?
  const treeItemCount = await page.evaluate(() => {
    return document.querySelectorAll(".tree-item").length;
  });
  console.log(`CHECK 5 - Tree items visible after login: ${treeItemCount}`);

  // CHECK 6: What's in the blobs array?
  const blobInfo = await page.evaluate(() => {
    // Access global state from the page
    const el = document.getElementById("content");
    const text = el?.textContent || "";
    return {
      contentText: text.slice(0, 200),
      treeItems: document.querySelectorAll(".tree-item .name").length,
      treeNames: Array.from(document.querySelectorAll(".tree-item .name")).map(e => e.textContent),
    };
  });
  console.log(`CHECK 6 - Page content: treeNames=${JSON.stringify(blobInfo.treeNames)}`);

  // CHECK 7: What does the manifest look like?
  const manifestInfo = await page.evaluate(() => {
    const statusEl = document.getElementById("relayStatus");
    return {
      relayStatusText: statusEl?.textContent,
    };
  });
  console.log(`CHECK 7 - Relay status: ${manifestInfo.relayStatusText}`);

  // Screenshot for visual verification
  await page.screenshot({ path: "test-results/diag-workspace-check.png" });
  console.log("Screenshot saved: test-results/diag-workspace-check.png");

  // The key assertion: workspace should be empty after cleanup
  expect(treeItemCount).toBe(0);
});

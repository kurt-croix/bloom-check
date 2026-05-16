/**
 * Blossom File Explorer — Bun dev server
 *
 * Serves the static UI and proxies API requests to avoid CORS issues.
 * All Nostr auth happens client-side via NIP-07 extension (window.nostr).
 *
 * For production (GitHub Pages), only static files are needed.
 * The proxy is a dev convenience — Blossom servers may support CORS directly.
 */

import { extname } from "path";

const PORT = Number(process.env.EXPLORER_PORT) || 3000;
const DEBUG = !!process.env.DEBUG;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // API proxy
    if (url.pathname === "/api/proxy") {
      return handleProxy(req, url);
    }

    // SPA routes: serve index.html
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveStatic("/index.html");
    }
    if (url.pathname === "/audit" || url.pathname === "/audit/") {
      return serveStatic("/audit/index.html");
    }
    if (url.pathname === "/glossary" || url.pathname === "/glossary/") {
      return serveStatic("/glossary.html");
    }
    // Shared view: /npub1...
    if (url.pathname.match(/^\/(npub1[a-z0-9]+)$/)) {
      return serveStatic("/index.html");
    }

    // Static files: CSS, JS, images, etc.
    const staticResp = await serveStatic(url.pathname);
    if (staticResp.status !== 404) return staticResp;

    // Demo video (outside explorer dir)
    if (url.pathname === "/demo-video") {
      const file = Bun.file(import.meta.dir + "/../blossom-explorer-demo-narrated.mp4");
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "video/mp4" } });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

/** Serve a static file from the explorer directory */
async function serveStatic(pathname: string): Promise<Response> {
  const filePath = import.meta.dir + pathname;
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  const ext = extname(filePath).toLowerCase();
  const ct = MIME_TYPES[ext] || "application/octet-stream";
  return new Response(file, { headers: { "Content-Type": ct } });
}

/** Proxy requests to Blossom servers */
async function handleProxy(req: Request, url: URL): Promise<Response> {
  const targetUrl = url.searchParams.get("target");
  if (!targetUrl) {
    return Response.json({ error: "Missing target URL" }, { status: 400 });
  }

  try {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (!["host", "origin", "referer", "connection", "accept-encoding"].includes(k)) {
        headers[k] = v;
      }
    });

    const init: RequestInit = { method: req.method, headers };

    if (req.method !== "GET" && req.method !== "HEAD") {
      const bodyBuf = await req.arrayBuffer();
      if (bodyBuf.byteLength > 0) {
        init.body = bodyBuf;
        headers["content-length"] = String(bodyBuf.byteLength);
      }
    }

    if (DEBUG) {
      console.log(`[proxy] ${req.method} -> ${targetUrl}`);
    }

    const resp = await fetch(targetUrl, init);

    const respHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
    };
    const ct = resp.headers.get("Content-Type");
    if (ct) respHeaders["Content-Type"] = ct;

    return new Response(resp.body, {
      status: resp.status,
      headers: respHeaders,
    });
  } catch (err: any) {
    console.error(`[proxy] Error: ${err.message}`);
    return Response.json({ error: err.message }, { status: 502 });
  }
}

console.log(`Blossom Explorer running at http://localhost:${PORT}`);

/**
 * Blossom Audit — Standalone dev server
 *
 * Serves the Audit page independently. No explorer dependency.
 * Run: EXPLORER_PORT=3132 bun audit/server.ts
 */

import { extname } from "path";

const PORT = Number(process.env.AUDIT_PORT) || 3132;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
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

    // SPA routes
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveStatic("audit/index.html");
    }

    // audit/ local files (audit.css, audit.js)
    const localResp = await serveStatic("audit" + url.pathname);
    if (localResp.status !== 404) return localResp;

    // shared/ files (theme.css, dom.js, etc.)
    const sharedResp = await serveStatic(url.pathname);
    if (sharedResp.status !== 404) return sharedResp;

    return new Response("Not found", { status: 404 });
  },
});

/** Serve a static file relative to the explorer root */
async function serveStatic(pathname: string): Promise<Response> {
  // Resolve from explorer root (one dir up from audit/)
  const basePath = import.meta.dir + "/../";
  const filePath = basePath + pathname.replace(/^\//, "");
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

console.log(`Blossom Audit running at http://localhost:${PORT}`);

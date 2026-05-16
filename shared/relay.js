/**
 * relay.js — WebSocket relay helpers for Nostr
 *
 * Provides subscribe, query (parallel + dedup), publish, and relay filtering.
 * All functions return Promes and use raw WebSocket (no dependencies).
 */

/**
 * Open a WebSocket to a single relay, send a REQ with the given filter,
 * collect events until EOSE or timeout, then resolve with the event array.
 */
export function relaySubscribe(relayUrl, filter, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const events = [];
    const subId = 'sub_' + Math.random().toString(36).slice(2, 8);
    let settled = false;
    let ws;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
      setTimeout(() => { try { ws.close(); } catch {} }, 100);
      resolve(events);
    };

    try {
      ws = new WebSocket(relayUrl);
    } catch {
      resolve(events);
      return;
    }

    const timer = setTimeout(finish, timeoutMs);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(['REQ', subId, filter]));
      } catch {
        clearTimeout(timer);
        finish();
      }
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
          events.push(data[2]);
        }
        if (data[0] === 'EOSE' && data[1] === subId) {
          clearTimeout(timer);
          finish();
        }
      } catch {}
    };

    ws.onerror = () => { clearTimeout(timer); finish(); };
    ws.onclose = () => { clearTimeout(timer); finish(); };
  });
}

/**
 * Query multiple relays in parallel, merge results, and deduplicate by event id.
 */
export async function queryRelays(relayUrls, filter, timeoutMs = 8000) {
  const urls = filterRelays(relayUrls);
  const results = await Promise.all(
    urls.map(url => relaySubscribe(url, filter, timeoutMs))
  );

  // Deduplicate by event id
  const seen = new Set();
  const all = [];
  for (const evts of results) {
    for (const e of evts) {
      if (e.id && !seen.has(e.id)) {
        seen.add(e.id);
        all.push(e);
      }
    }
  }
  return all;
}

/**
 * Publish a signed event to multiple relays.
 * Returns an object mapping relay URL → status string ('pending', 'ok', 'error', etc.).
 * Each connection auto-closes after 3 seconds.
 */
export function publishToRelays(relayUrls, event) {
  const urls = filterRelays(relayUrls);
  const results = {};

  for (const url of urls) {
    results[url] = 'pending';
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        ws.send(JSON.stringify(['EVENT', event]));
      };
      ws.onmessage = (msg) => {
        try {
          const d = JSON.parse(msg.data);
          if (d[0] === 'OK') results[url] = d[2] ? 'ok' : `rejected: ${d[3] || 'unknown'}`;
          if (d[0] === 'NOTICE') results[url] = `notice: ${d[1]}`;
        } catch {}
      };
      ws.onerror = () => { results[url] = 'error'; };
      setTimeout(() => { try { ws.close(); } catch {} }, 3000);
    } catch {
      results[url] = 'error';
    }
  }

  return results;
}

/**
 * Filter out unreachable relay URLs (.onion, .i2p, malformed).
 */
export function filterRelays(urls) {
  return urls.filter(u => {
    try {
      const h = new URL(u).hostname;
      return !h.endsWith('.onion') && !h.endsWith('.i2p');
    } catch {
      return false;
    }
  });
}

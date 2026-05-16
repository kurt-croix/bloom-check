/**
 * audit.js — Blossom Audit page logic
 *
 * Handles snapshot creation, auditing, diffing, and relay interactions
 * for detecting file tampering on Blossom sites.
 */

import { decodeNpub, decodeNsec, encodeNsec } from '../shared/bech32.js';
import { relaySubscribe, queryRelays, publishToRelays, filterRelays } from '../shared/relay.js';
import { esc, fmtBytes, fmtDate, isImg, isVid, isAud, isText, fname, openModal, closeModal } from '../shared/dom.js';

// =============================================
// Crypto utilities — loaded dynamically from esm.sh
// =============================================
let schnorrLib = null;
let hexUtils = null;

/** Lazy-load the @noble/curves library for Schnorr signing */
async function loadCrypto() {
  if (schnorrLib) return;
  const mod = await import('https://esm.sh/@noble/curves@1.4.0/secp256k1');
  schnorrLib = mod.schnorr;
  const utilMod = await import('https://esm.sh/@noble/curves@1.4.0/utils');
  hexUtils = { bytesToHex: utilMod.bytesToHex, hexToBytes: utilMod.hexToBytes };
}

function bytesToHex(b) {
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(h) {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) a[i / 2] = parseInt(h.substr(i, 2), 16);
  return a;
}

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// =============================================
// Application state
// =============================================
let nostrExt;
let myPubkey = '';       // Your pubkey (NIP-07 signer, snapshot author)
let targetPubkey = '';   // Who you're auditing (p tag in snapshot events)
let manifest = null;
let targetRelays = [];   // Target's NIP-65 relays
let myRelays = [];       // Your NIP-65 relays (for publishing snapshots)
let currentEntries = {}; // path -> sha256 from current manifest
let blossomBlobs = [];   // ALL blobs from Blossom server
let blossomServer = 'https://blossom.primal.net'; // default

const BOOTSTRAP_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.wine'];

// =============================================
// Pubkey resolution
// =============================================

/** Resolve input string to hex pubkey (npub or hex) */
function resolvePubkey(input) {
  input = input.trim();
  if (input.startsWith('npub1')) return decodeNpub(input);
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();
  return null;
}

// =============================================
// Virtual NIP-07 signer from private key
// =============================================

/** Create a virtual NIP-07 signer from a private key (hex) */
function createSigner(privKeyHex) {
  const pubKeyHex = bytesToHex(schnorrLib.getPublicKey(privKeyHex));

  return {
    getPublicKey: async () => pubKeyHex,
    signEvent: async (template) => {
      const event = {
        pubkey: pubKeyHex,
        created_at: template.created_at || Math.floor(Date.now() / 1000),
        kind: template.kind,
        tags: template.tags || [],
        content: template.content || '',
      };
      // Serialize: [0,pubkey,created_at,kind,tags,content]
      const serialized = JSON.stringify([
        0, event.pubkey, event.created_at, event.kind, event.tags, event.content
      ]);
      const eventId = bytesToHex(await sha256(new TextEncoder().encode(serialized)));
      const sig = bytesToHex(schnorrLib.sign(eventId, privKeyHex));
      return { ...event, id: eventId, sig };
    },
  };
}

/** Generate a new random keypair */
function generateKeypair() {
  const privBytes = crypto.getRandomValues(new Uint8Array(32));
  const privHex = bytesToHex(privBytes);
  const pubHex = bytesToHex(schnorrLib.getPublicKey(privBytes));
  return { privkey: privHex, pubkey: pubHex };
}

// =============================================
// Profile fetching
// =============================================

/** Fetch kind 0 profile for a pubkey — returns {name, display_name, picture} or null */
async function fetchProfile(hex, relays) {
  try {
    const events = await queryRelays(relays, { kinds: [0], authors: [hex], limit: 1 }, 5000);
    if (events.length > 0) return JSON.parse(events[0].content || '{}');
  } catch (e) {
    console.warn('[audit] fetchProfile failed:', e.message);
  }
  return null;
}

/** Update header with profile avatars + names */
async function updateHeaderWithProfiles() {
  const relays = targetRelays.length > 0 ? targetRelays : BOOTSTRAP_RELAYS;
  const [myProfile, targetProfile] = await Promise.all([
    fetchProfile(myPubkey, relays),
    fetchProfile(targetPubkey, relays),
  ]);

  const myName = myProfile?.display_name || myProfile?.name || myPubkey.slice(0, 8);
  const tgtName = targetProfile?.display_name || targetProfile?.name || targetPubkey.slice(0, 8);
  const myImg = myProfile?.picture
    ? `<img src="${esc(myProfile.picture)}" style="width:18px;height:18px;border-radius:50%;vertical-align:middle;margin-right:4px" onerror="this.style.display='none'">`
    : '';
  const tgtImg = targetProfile?.picture
    ? `<img src="${esc(targetProfile.picture)}" style="width:18px;height:18px;border-radius:50%;vertical-align:middle;margin-right:4px" onerror="this.style.display='none'">`
    : '';

  document.getElementById('headerInfo').innerHTML =
    `${myImg}<span style="color:#58a6ff">${esc(myName)}</span> <span style="color:#8b949e">→</span> ${tgtImg}<span style="color:#d29922">${esc(tgtName)}</span>`;
}

// =============================================
// Blossom server API
// =============================================

/** Proxy fetch through Bun server to avoid CORS.
 *  On static deployments (no proxy), make direct requests. */
async function proxyFetch(targetUrl, opts = {}) {
  if (location.port) {
    const proxyUrl = `/api/proxy?target=${encodeURIComponent(targetUrl)}`;
    return fetch(proxyUrl, opts);
  }
  return fetch(targetUrl, opts);
}

/** Fetch ALL blobs for the target pubkey from multiple sources */
async function fetchBlossomBlobs() {
  blossomBlobs = [];
  blossomServer = document.getElementById('blossomServerInput').value.trim().replace(/\/+$/, '') || blossomServer;

  // Source 1: Blossom server /list endpoint
  try {
    let resp = await proxyFetch(`${blossomServer}/list/${targetPubkey}?limit=500`);
    if (resp.status === 401 || resp.status === 400) {
      try {
        await loadCrypto();
        const token = await createBlossomAuthToken('list');
        resp = await proxyFetch(`${blossomServer}/list/${targetPubkey}?limit=500`, {
          headers: { 'Authorization': `Nostr ${token}` },
        });
        if (!resp.ok) console.warn('[audit] Auth response:', await resp.text());
      } catch (e) { console.warn('[audit] Auth attempt failed:', e.message); }
    }
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data)) blossomBlobs = data;
    }
  } catch (e) {
    console.warn('Blossom /list failed:', e.message);
  }

  // Source 2: NIP-94 file metadata (kind 1063) from relays
  try {
    const relays = targetRelays.length > 0 ? targetRelays : BOOTSTRAP_RELAYS;
    const nip94Events = await queryRelays(relays, {
      kinds: [1063],
      authors: [targetPubkey],
      limit: 200,
    }, 8000);

    const seen = new Set(blossomBlobs.map(b => b.sha256));
    for (const evt of nip94Events) {
      const sha = evt.tags.find(t => t[0] === 'x')?.[1];
      const url = evt.tags.find(t => t[0] === 'url')?.[1];
      const type = evt.tags.find(t => t[0] === 'm')?.[1];
      const size = evt.tags.find(t => t[0] === 'size')?.[1];
      if (sha && !seen.has(sha)) {
        seen.add(sha);
        blossomBlobs.push({
          sha256: sha,
          url: url || `${blossomServer}/${sha}`,
          type: type || '',
          size: size ? parseInt(size) : 0,
          uploaded: evt.created_at,
        });
      }
    }
  } catch (e) {
    console.warn('NIP-94 query failed:', e.message);
  }

  // Source 3: Scan kind 1 notes for x tags (media references)
  try {
    const relays = targetRelays.length > 0 ? targetRelays : BOOTSTRAP_RELAYS;
    const noteEvents = await queryRelays(relays, {
      kinds: [1],
      authors: [targetPubkey],
      limit: 100,
    }, 6000);

    const seen = new Set(blossomBlobs.map(b => b.sha256));
    for (const evt of noteEvents) {
      for (const tag of evt.tags) {
        if (tag[0] === 'x' && tag[1] && !seen.has(tag[1])) {
          seen.add(tag[1]);
          blossomBlobs.push({
            sha256: tag[1],
            url: `${blossomServer}/${tag[1]}`,
            type: '',
            size: 0,
            uploaded: evt.created_at,
          });
        }
      }
    }
  } catch (e) {
    console.warn('Note scan failed:', e.message);
  }

  // Source 4: Scan long-form content (kinds 30023, 30024) for imeta/x tags
  try {
    const relays = targetRelays.length > 0 ? targetRelays : BOOTSTRAP_RELAYS;
    const longForm = await queryRelays(relays, {
      kinds: [30023, 30024],
      authors: [targetPubkey],
      limit: 50,
    }, 6000);

    const seen = new Set(blossomBlobs.map(b => b.sha256));
    for (const evt of longForm) {
      for (const tag of evt.tags) {
        if (tag[0] === 'x' && tag[1] && /^[0-9a-f]{64}$/i.test(tag[1]) && !seen.has(tag[1])) {
          seen.add(tag[1]);
          blossomBlobs.push({
            sha256: tag[1],
            url: `${blossomServer}/${tag[1]}`,
            type: '',
            size: 0,
            uploaded: evt.created_at,
          });
        }
        if (tag[0] === 'url' && tag[1] && tag[1].includes(blossomServer)) {
          const match = tag[1].match(/([0-9a-f]{64})/);
          if (match && !seen.has(match[1])) {
            seen.add(match[1]);
            blossomBlobs.push({
              sha256: match[1],
              url: tag[1],
              type: '',
              size: 0,
              uploaded: evt.created_at,
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('Long-form scan failed:', e.message);
  }

  // Source 5: Scan profile metadata (kind 0) for picture/banner URLs with hashes
  try {
    const relays = targetRelays.length > 0 ? targetRelays : BOOTSTRAP_RELAYS;
    const profileEvents = await queryRelays(relays, {
      kinds: [0],
      authors: [targetPubkey],
      limit: 5,
    }, 4000);

    const seen = new Set(blossomBlobs.map(b => b.sha256));
    for (const evt of profileEvents) {
      try {
        const meta = JSON.parse(evt.content);
        for (const field of ['picture', 'banner', 'image']) {
          if (meta[field]) {
            const match = meta[field].match(/([0-9a-f]{64})/);
            if (match && !seen.has(match[1])) {
              seen.add(match[1]);
              blossomBlobs.push({
                sha256: match[1],
                url: meta[field],
                type: 'image/' + (meta[field].split('.').pop() || 'png'),
                size: 0,
                uploaded: evt.created_at,
              });
            }
          }
        }
      } catch (e) {
        console.warn('[audit] Failed to parse profile metadata:', e.message);
      }
    }
  } catch (e) {
    console.warn('Profile scan failed:', e.message);
  }

  // Source 6: Broad scan for events with #x tags
  try {
    const relays = targetRelays.length > 0 ? targetRelays : BOOTSTRAP_RELAYS;
    const mediaEvents = await queryRelays(relays, {
      kinds: [1, 6, 7, 16, 1063, 30023],
      authors: [targetPubkey],
      limit: 300,
    }, 8000);

    const seen = new Set(blossomBlobs.map(b => b.sha256));
    let found = 0;
    for (const evt of mediaEvents) {
      for (const tag of evt.tags) {
        if (tag[0] === 'x' && tag[1] && /^[0-9a-f]{64}$/i.test(tag[1]) && !seen.has(tag[1])) {
          seen.add(tag[1]);
          found++;
          blossomBlobs.push({
            sha256: tag[1],
            url: `${blossomServer}/${tag[1]}`,
            type: '',
            size: 0,
            uploaded: evt.created_at,
          });
        }
        // Check imeta tags for x values
        if (tag[0] === 'imeta' && Array.isArray(tag)) {
          for (const part of tag) {
            const xMatch = String(part).match(/^x ([0-9a-f]{64})$/);
            if (xMatch && !seen.has(xMatch[1])) {
              seen.add(xMatch[1]);
              found++;
              blossomBlobs.push({
                sha256: xMatch[1],
                url: `${blossomServer}/${xMatch[1]}`,
                type: '',
                size: 0,
                uploaded: evt.created_at,
              });
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('Broad scan failed:', e.message);
  }

  return blossomBlobs;
}

/** Create a Blossom auth token (kind 24242) */
async function createBlossomAuthToken(action) {
  if (!nostrExt) throw new Error('No signer');
  const template = {
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', action],
      ['expiration', String(Math.floor(Date.now() / 1000) + 300)],
    ],
    content: `Blossom audit: ${action}`,
  };
  const signed = await nostrExt.signEvent(template);
  return btoa(JSON.stringify(signed));
}

// =============================================
// Snapshot storage — relay-only (kind 5128 events)
// =============================================
let cachedSnapshots = [];  // In-memory cache of parsed snapshots
let cachedRawEvents = [];  // Raw event JSON for modal viewing

async function fetchSnapshots() {
  if (!targetPubkey) return [];
  const relays = targetRelays.length > 0 ? targetRelays : BOOTSTRAP_RELAYS;
  const events = await queryRelays(relays, {
    kinds: [5128],
    '#p': [targetPubkey],
    limit: 100,
  }, 10000);
  events.sort((a, b) => a.created_at - b.created_at);
  cachedRawEvents = events;
  cachedSnapshots = events.map(snapshotEventToEntry);
  return cachedSnapshots;
}

function getLastSnapshot() {
  return cachedSnapshots.length > 0 ? cachedSnapshots[cachedSnapshots.length - 1] : null;
}

// =============================================
// Target relay & manifest loading
// =============================================

/** Fetch target's NIP-65 relay list */
async function fetchTargetRelays() {
  const events = await queryRelays(BOOTSTRAP_RELAYS, { kinds: [10002], authors: [targetPubkey], limit: 1 }, 6000);
  if (events.length > 0 && events[0].tags) {
    targetRelays = events[0].tags.filter(t => t[0] === 'r' && t[1]).map(t => t[1]);
  }
  if (targetRelays.length === 0) targetRelays = [...BOOTSTRAP_RELAYS];
}

/** Fetch your NIP-65 relays (for publishing snapshots) */
async function fetchMyRelays() {
  const events = await queryRelays(BOOTSTRAP_RELAYS, { kinds: [10002], authors: [myPubkey], limit: 1 }, 6000);
  if (events.length > 0 && events[0].tags) {
    myRelays = events[0].tags.filter(t => t[0] === 'r' && t[1]).map(t => t[1]);
  }
  if (myRelays.length === 0) myRelays = [...BOOTSTRAP_RELAYS];
}

async function fetchManifest() {
  const relays = targetRelays.length > 0 ? targetRelays : BOOTSTRAP_RELAYS;
  const [root, named] = await Promise.all([
    queryRelays(relays, { kinds: [15128], authors: [targetPubkey], limit: 5 }, 6000),
    queryRelays(relays, { kinds: [35128], authors: [targetPubkey], limit: 20 }, 6000),
  ]);
  const all = [...root, ...named];
  if (all.length > 0) {
    all.sort((a, b) => b.created_at - a.created_at);
    manifest = all[0];
  } else {
    manifest = null;
  }

  // Extract path->sha map
  currentEntries = {};
  if (manifest && manifest.tags) {
    for (const tag of manifest.tags) {
      if (tag[0] === 'path' && tag[1] && tag[2]) {
        currentEntries[tag[1]] = tag[2];
      }
    }
  }
}

// =============================================
// Login / Init
// =============================================
async function init() {
  // Wait briefly for NIP-07 extension to inject window.nostr
  for (let i = 0; i < 10; i++) {
    if (typeof window.nostr !== 'undefined') break;
    await new Promise(r => setTimeout(r, 200));
  }
  if (typeof window.nostr !== 'undefined') {
    nostrExt = window.nostr;
    try {
      myPubkey = await nostrExt.getPublicKey();
    } catch (e) {
      console.warn('[audit] NIP-07 getPublicKey failed:', e.message);
    }
  }

  // Check for saved target or URL parameter
  const savedTarget = localStorage.getItem('blossom_audit_target') || '';
  const urlTarget = new URL(location.href).searchParams.get('target') || '';

  if (myPubkey && (urlTarget || savedTarget)) {
    const hex = resolvePubkey(urlTarget || savedTarget);
    if (hex) {
      targetPubkey = hex;
      document.getElementById('targetInput').value = urlTarget || savedTarget;
      await showApp();
      return;
    }
  }
  showLogin();
}

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  if (nostrExt) {
    document.getElementById('extStatus').textContent = 'Nostr extension detected — you can skip the secret key field';
    document.getElementById('extStatus').classList.add('ok');
  } else {
    document.getElementById('extStatus').textContent = 'No Nostr extension found — paste your secret key (nsec) or generate a new one below';
    document.getElementById('extStatus').classList.remove('ok');
  }
}

async function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('headerInfo').textContent = `you: ${myPubkey.slice(0, 8)}... → target: ${targetPubkey.slice(0, 8)}...`;
  document.getElementById('targetPubkeyInput').value = targetPubkey;

  // Auto-fill Blossom server from localStorage
  const saved = localStorage.getItem('blossom_audit_server');
  if (saved) {
    document.getElementById('blossomServerInput').value = saved;
  }

  // Fetch your relays (for publishing), target's relays (for reading their manifests)
  await Promise.all([fetchMyRelays(), fetchTargetRelays()]);

  // Show profile names + avatars in header (non-blocking)
  updateHeaderWithProfiles();
  await fetchManifest();
  // Auto-fill Blossom server from manifest if not already set
  const serverTag = manifest?.tags?.find(t => t[0] === 'server');
  if (serverTag && !saved) {
    document.getElementById('blossomServerInput').value = serverTag[1];
  }
  await fetchBlossomBlobs();
  await fetchSnapshots();
  renderStatus();
}

// =============================================
// Actions — Event Listeners
// =============================================

// Login button
document.getElementById('loginBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    // Check for nsec input — creates a virtual signer
    const nsecVal = document.getElementById('nsecInput').value.trim();
    if (nsecVal && !nostrExt) {
      await loadCrypto(); // load crypto lib before first use
      const privHex = nsecVal.startsWith('nsec1') ? decodeNsec(nsecVal) : nsecVal;
      if (!privHex || !/^[0-9a-f]{64}$/i.test(privHex)) throw new Error('Invalid nsec or private key');
      nostrExt = createSigner(privHex);
    }

    if (!nostrExt) throw new Error('Nostr extension or nsec key required');

    const input = document.getElementById('targetInput').value.trim();
    const hex = resolvePubkey(input);
    if (!hex) throw new Error('Invalid target pubkey or npub');

    myPubkey = await nostrExt.getPublicKey();
    targetPubkey = hex;
    localStorage.setItem('blossom_audit_target', input);
    await showApp();
  } catch (e) {
    errEl.textContent = e.message;
  }
});

// Generate new keypair
document.getElementById('genKeyBtn').addEventListener('click', async () => {
  try {
    await loadCrypto();
    const kp = generateKeypair();
    const nsec = encodeNsec(kp.privkey);

    document.getElementById('nsecInput').value = nsec;
    document.getElementById('genKeyInfo').textContent = `Generated! pubkey: ${kp.pubkey.slice(0, 16)}...`;
    document.getElementById('genKeyInfo').style.color = '#3fb950';
  } catch (e) {
    document.getElementById('genKeyInfo').textContent = 'Error: ' + e.message;
    document.getElementById('genKeyInfo').style.color = '#f85149';
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  targetPubkey = '';
  cachedSnapshots = [];
  showLogin();
});

// Load button — change target at runtime
document.getElementById('loadTargetBtn').addEventListener('click', async () => {
  const input = document.getElementById('targetPubkeyInput').value.trim();
  const hex = resolvePubkey(input);
  if (!hex) { alert('Invalid pubkey or npub'); return; }
  targetPubkey = hex;
  localStorage.setItem('blossom_audit_target', input);
  localStorage.setItem('blossom_audit_server', document.getElementById('blossomServerInput').value.trim());
  document.getElementById('headerInfo').textContent = `you: ${myPubkey.slice(0, 8)}... → target: ${targetPubkey.slice(0, 8)}...`;
  document.getElementById('main').innerHTML = '<div class="empty">Loading target...</div>';
  await fetchTargetRelays();
  await fetchManifest();
  await fetchBlossomBlobs();
  await fetchSnapshots();
  updateHeaderWithProfiles();
  renderStatus();
});

// =============================================
// Snapshot publish logic
// =============================================

/** Compute aggregate hash from path tags (NIP-5A) */
async function computeAggregateHash(pathTags) {
  const lines = pathTags
    .filter(t => t[1] && t[2])
    .map(t => `${t[2]} ${t[1]}\n`)
    .sort();
  const data = new TextEncoder().encode(lines.join(''));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Publish a kind 5128 snapshot event to relays */
async function publishSnapshotEvent(entries) {
  if (!nostrExt) throw new Error('No signer');
  if (!entries || entries.length === 0) throw new Error('No entries to snapshot');

  const pathTags = entries.map(e => ['path', e.path, e.sha256]);
  const aggregateHash = await computeAggregateHash(pathTags);

  const tags = [
    ['x', aggregateHash, 'aggregate'],
    ['p', targetPubkey],
    ['alt', 'Blossom manifest snapshot for audit'],
    ['server', blossomServer],
  ];

  // Reference source manifest via a-tag
  if (manifest) {
    const dTag = manifest.tags?.find(t => t[0] === 'd')?.[1] || '';
    const aTagValue = `${manifest.kind}:${manifest.pubkey}:${dTag}`;
    const relayHint = targetRelays[0] || '';
    tags.splice(0, 0, ['a', aTagValue, relayHint]);
    const aSource = manifest.tags?.find(t => t[0] === 'A');
    if (aSource) tags.push(['A', aSource[1]]);
  }

  for (const pt of pathTags) tags.push(pt);

  const template = {
    kind: 5128,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };

  const signed = await nostrExt.signEvent(template);
  // Publish to both your relays and target's relays for discoverability
  const allRelays = [...new Set([...myRelays, ...targetRelays])];
  const relayResults = publishToRelays(allRelays, signed);
  return { event: signed, relayResults };
}

/** Convert a kind 5128 event to snapshot format */
function snapshotEventToEntry(evt) {
  const entries = {};
  for (const tag of evt.tags) {
    if (tag[0] === 'path' && tag[1] && tag[2]) {
      entries[tag[1]] = tag[2];
    }
  }
  return {
    id: evt.id,
    timestamp: evt.created_at * 1000,
    entries,
    entryCount: Object.keys(entries).length,
    snapshotter: evt.pubkey,
    manifestRef: evt.tags.find(t => t[0] === 'a')?.[1] || '',
    aggregateHash: evt.tags.find(t => t[0] === 'x' && t[2] === 'aggregate')?.[1] || '',
  };
}

// =============================================
// Snapshot preview — file tree before publishing
// =============================================
let pendingSnapshotEntries = []; // {path, sha256, source: 'manifest'|'blossom', size}

/** Build combined entries from manifest paths + Blossom blobs */
function buildSnapshotEntries() {
  const entries = [];
  const seenPaths = new Set();

  // Manifest paths
  if (manifest?.tags) {
    for (const tag of manifest.tags) {
      if (tag[0] === 'path' && tag[1] && tag[2] && !seenPaths.has(tag[1])) {
        seenPaths.add(tag[1]);
        entries.push({ path: tag[1], sha256: tag[2], source: 'manifest', size: 0 });
      }
    }
  }

  // Blossom blobs — update size on matching entries, or add as new
  const manifestShas = new Set(entries.map(e => e.sha256));
  for (const blob of blossomBlobs) {
    if (manifestShas.has(blob.sha256)) {
      for (const e of entries) {
        if (e.sha256 === blob.sha256 && !e.size) e.size = blob.size || 0;
      }
      continue;
    }
    const blobPath = blob.sha256;
    if (!seenPaths.has(blobPath)) {
      seenPaths.add(blobPath);
      manifestShas.add(blob.sha256);
      entries.push({
        path: blobPath,
        sha256: blob.sha256,
        source: 'blossom',
        size: blob.size || 0,
      });
    }
  }

  return entries;
}

/** Render file preview tree */
let previewEntries = []; // stored for click handlers

function renderPreview(entries) {
  previewEntries = entries;
  const main = document.getElementById('main');

  // Build tree structure
  const tree = {};
  for (const e of entries) {
    const parts = e.path.startsWith('/') ? e.path.slice(1).split('/') : e.path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] || '(root)';
      if (!node[part]) node[part] = {};
      if (i === parts.length - 1) {
        node[part]._entry = e;
      }
      node = node[part];
    }
  }

  const manifestCount = entries.filter(e => e.source === 'manifest').length;
  const blossomCount = entries.filter(e => e.source === 'blossom').length;
  const totalSize = entries.reduce((sum, e) => sum + (e.size || 0), 0);
  const blossomServerFailed = blossomBlobs.length === 0;

  let html = `
    <div class="preview-header">
      <h3>Snapshot Preview</h3>
      <div class="preview-stats">
        <span><strong>${entries.length}</strong> files</span>
        <span><strong>${manifestCount}</strong> manifest paths</span>
        <span><strong>${blossomCount}</strong> relay-discovered</span>
        <span><strong>${fmtBytes(totalSize)}</strong> total</span>
      </div>
    </div>
    ${blossomServerFailed ? `<div style="padding:10px 16px;background:var(--amber-tint);border:1px solid var(--amber-border);border-radius:6px;margin-bottom:12px;font-size:12px;color:var(--amber)">
      <strong>Note:</strong> Blossom server <code>${esc(blossomServer)}</code> requires authentication to list files. Only files discoverable via Nostr relays are shown. Files that exist only on the Blossom server but aren't referenced in any Nostr event won't appear here.
    </div>` : ''}
    <div class="file-tree">`;

  html += renderTreeRows(tree, 0);
  html += '</div>';

  main.innerHTML = html;
}

function renderTreeRows(node, depth) {
  let html = '';
  const indent = depth * 20;
  const entries = Object.entries(node).filter(([k]) => !k.startsWith('_'));

  // Separate folders and files
  const folders = [];
  const files = [];
  for (const [name, child] of entries) {
    if (child._entry) files.push({ name, entry: child._entry });
    else {
      const childKeys = Object.keys(child).filter(k => !k.startsWith('_'));
      if (childKeys.length > 0) folders.push({ name, child });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  for (const f of folders) {
    html += `<div class="tree-row folder" style="padding-left:${12 + indent}px">
      <span class="icon">&#128193;</span>
      <span>${esc(f.name)}/</span>
    </div>`;
    html += renderTreeRows(f.child, depth + 1);
  }

  for (const f of files) {
    const e = f.entry;
    const idx = previewEntries.indexOf(e);
    const icon = e.path.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i) ? '&#128444;'
      : e.path.match(/\.(mp4|webm|mov)$/i) ? '&#127909;'
      : e.path.match(/\.(mp3|ogg|wav)$/i) ? '&#127925;'
      : '&#128196;';
    html += `<div class="tree-row file" style="padding-left:${12 + indent + 20}px;cursor:pointer" onclick="window._audit_previewFile(${idx})">
      <span class="icon">${icon}</span>
      <span>${esc(f.name)}</span>
      <span class="source ${e.source}">${e.source}</span>
      ${e.size ? `<span class="size">${fmtBytes(e.size)}</span>` : ''}
      <span class="sha">${esc(e.sha256.slice(0, 16))}...</span>
    </div>`;
  }

  return html;
}

// Snapshot button
document.getElementById('snapshotBtn').addEventListener('click', async () => {
  try {
    document.getElementById('snapshotBtn').textContent = 'Loading...';
    document.getElementById('snapshotBtn').disabled = true;

    await fetchManifest();
    await fetchBlossomBlobs();

    pendingSnapshotEntries = buildSnapshotEntries();
    if (pendingSnapshotEntries.length === 0) {
      alert('No files found. Check Blossom server URL and target pubkey.');
      return;
    }

    renderPreview(pendingSnapshotEntries);

    document.getElementById('snapshotBtn').style.display = 'none';
    document.getElementById('publishBtn').style.display = 'inline-block';
    document.getElementById('cancelPreviewBtn').style.display = 'inline-block';
  } catch (e) {
    alert('Failed to load files: ' + e.message);
  } finally {
    document.getElementById('snapshotBtn').textContent = 'Create Snapshot';
    document.getElementById('snapshotBtn').disabled = false;
  }
});

// Publish button
document.getElementById('publishBtn').addEventListener('click', async () => {
  try {
    document.getElementById('publishBtn').textContent = 'Signing...';
    document.getElementById('publishBtn').disabled = true;

    const result = await publishSnapshotEvent(pendingSnapshotEntries);

    await fetchSnapshots();
    renderStatus();
    showSnapshotModal(result.event, result.relayResults);
  } catch (e) {
    alert('Publish failed: ' + e.message);
  } finally {
    document.getElementById('publishBtn').textContent = 'Publish Snapshot';
    document.getElementById('publishBtn').disabled = false;
    document.getElementById('publishBtn').style.display = 'none';
    document.getElementById('cancelPreviewBtn').style.display = 'none';
    document.getElementById('snapshotBtn').style.display = 'inline-block';
  }
});

// Cancel preview
document.getElementById('cancelPreviewBtn').addEventListener('click', () => {
  pendingSnapshotEntries = [];
  document.getElementById('publishBtn').style.display = 'none';
  document.getElementById('cancelPreviewBtn').style.display = 'none';
  document.getElementById('snapshotBtn').style.display = 'inline-block';
  renderStatus();
});

// Run audit
document.getElementById('auditBtn').addEventListener('click', async () => {
  document.getElementById('auditBtn').textContent = 'Fetching...';
  document.getElementById('auditBtn').disabled = true;
  try {
    await fetchSnapshots();
  } catch (e) {
    console.error('Failed to fetch relay snapshots:', e);
  } finally {
    document.getElementById('auditBtn').textContent = 'Run Audit';
    document.getElementById('auditBtn').disabled = false;
  }

  const last = getLastSnapshot();
  if (!last) {
    alert('Take a snapshot first');
    return;
  }
  await fetchManifest();
  renderAudit(last.entries, currentEntries);
});

// Clear history
document.getElementById('clearBtn')?.addEventListener('click', async () => {
  cachedSnapshots = [];
  await fetchSnapshots();
  renderStatus();
});

// =============================================
// Render helpers
// =============================================

/** Format a timestamp (ms) for display */
function fmtDateMs(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtShortHash(h) { return h ? h.slice(0, 12) + '...' : '—'; }

function renderStatus() {
  const main = document.getElementById('main');
  const snaps = cachedSnapshots;
  const entryCount = Object.keys(currentEntries).length;

  if (snaps.length === 0) {
    main.innerHTML = `<div class="empty">
      <p>No snapshots yet.</p>
      <p style="margin-top:8px;font-size:13px">Current site has <strong>${entryCount}</strong> file paths.</p>
      <p style="margin-top:12px;font-size:13px;color:var(--amber)">Take a snapshot to establish a baseline, then run audit after changes.</p>
    </div>`;
    return;
  }

  // Snapshot timeline
  let html = '<div class="summary-cards">';
  html += `<div class="summary-card total"><div class="number">${snaps.length}</div><div class="label">Snapshots</div></div>`;
  html += `<div class="summary-card unchanged"><div class="number">${blossomBlobs.length}</div><div class="label">Blossom Blobs</div></div>`;
  html += `<div class="summary-card unchanged"><div class="number">${entryCount}</div><div class="label">Manifest Paths</div></div>`;
  html += `<div class="summary-card"><div class="number">${fmtShortHash(manifest?.id)}</div><div class="label">Manifest ID</div></div>`;
  const serverTag = manifest?.tags?.find(t => t[0] === 'server');
  if (serverTag) {
    html += `<div class="summary-card"><div class="number" style="font-size:11px">${esc(serverTag[1])}</div><div class="label">Blossom Server</div></div>`;
  }
  html += '</div>';

  html += '<h3 style="font-size:14px;color:var(--text-secondary);margin-bottom:12px">Snapshot History</h3>';
  html += '<div class="snapshot-list">';
  for (let i = snaps.length - 1; i >= 0; i--) {
    const s = snaps[i];
    const isActive = i === snaps.length - 1;
    html += `<div class="snapshot-item${isActive ? ' active' : ''}" style="cursor:pointer" onclick="window._audit_showSnapshotModal(window._audit_cachedRawEvents[${i}])">
      <span class="snap-date">${fmtDateMs(s.timestamp)}</span>
      <span class="snap-count">${s.entryCount} paths</span>
      <span style="font-size:10px;color:var(--accent-blue)">view</span>
    </div>`;
  }
  html += '</div>';

  html += '<div class="empty" style="padding:20px"><p style="font-size:13px;color:var(--amber)">Ready to audit. Make changes to the site, then click "Run Audit" to compare against the latest snapshot.</p></div>';
  main.innerHTML = html;
}

function renderAudit(oldEntries, newEntries) {
  const main = document.getElementById('main');
  const allPaths = new Set([...Object.keys(oldEntries), ...Object.keys(newEntries)]);

  const changed = [];
  const unchanged = [];
  const newFiles = [];
  const removed = [];

  for (const path of allPaths) {
    const oldSha = oldEntries[path];
    const newSha = newEntries[path];
    if (oldSha && newSha) {
      if (oldSha === newSha) unchanged.push(path);
      else changed.push({ path, oldSha, newSha });
    } else if (newSha && !oldSha) {
      newFiles.push({ path, sha: newSha });
    } else if (oldSha && !newSha) {
      removed.push({ path, sha: oldSha });
    }
  }

  changed.sort((a, b) => a.path.localeCompare(b.path));
  unchanged.sort();
  newFiles.sort((a, b) => a.path.localeCompare(b.path));
  removed.sort((a, b) => a.path.localeCompare(b.path));

  // Summary cards
  let html = '<div class="summary-cards">';
  html += `<div class="summary-card changed"><div class="number">${changed.length}</div><div class="label">Changed</div></div>`;
  html += `<div class="summary-card new"><div class="number">${newFiles.length}</div><div class="label">New Files</div></div>`;
  html += `<div class="summary-card removed"><div class="number">${removed.length}</div><div class="label">Removed</div></div>`;
  html += `<div class="summary-card unchanged"><div class="number">${unchanged.length}</div><div class="label">Unchanged</div></div>`;
  html += '</div>';

  if (changed.length === 0 && newFiles.length === 0 && removed.length === 0) {
    html += '<div style="text-align:center;padding:30px"><p style="font-size:16px;color:var(--green)">No changes detected.</p><p style="font-size:13px;color:var(--text-secondary);margin-top:8px">All files match the last snapshot.</p></div>';
  }

  // Detail table
  html += '<table class="audit-table"><thead><tr><th>Path</th><th>Status</th><th>Previous Hash</th><th>Current Hash</th><th>History</th></tr></thead><tbody>';

  // Changed files
  for (const f of changed) {
    const histId = 'hist_' + f.path.replace(/[^a-z0-9]/gi, '_');
    html += `<tr class="changed">
      <td><strong>${esc(f.path)}</strong></td>
      <td><span class="badge changed">CHANGED</span></td>
      <td><span class="hash old">${esc(f.oldSha)}</span></td>
      <td><span class="hash current">${esc(f.newSha)}</span></td>
      <td>
        <button class="btn-sm" style="color:var(--accent-blue);border-color:var(--accent-blue);font-size:10px;padding:2px 8px" onclick="window._audit_showDiffModal('${esc(f.path)}','${esc(f.oldSha)}','${esc(f.newSha)}')">diff</button>
        <button class="history-toggle" onclick="window._audit_toggleHistory('${esc(histId)}')">history</button>
      </td>
    </tr>`;
    html += buildHistoryRow(histId, f.path);
  }

  // New files
  for (const f of newFiles) {
    html += `<tr class="new-file">
      <td>${esc(f.path)}</td>
      <td><span class="badge new-file">NEW</span></td>
      <td><span class="hash">—</span></td>
      <td><span class="hash current">${esc(f.sha)}</span></td>
      <td></td>
    </tr>`;
  }

  // Removed files
  for (const f of removed) {
    html += `<tr class="removed-file">
      <td>${esc(f.path)}</td>
      <td><span class="badge removed-file">REMOVED</span></td>
      <td><span class="hash old">${esc(f.sha)}</span></td>
      <td><span class="hash">—</span></td>
      <td></td>
    </tr>`;
  }

  // Unchanged (collapsible)
  if (unchanged.length > 0) {
    html += `<tr><td colspan="5" style="padding:12px 14px"><button class="history-toggle" onclick="window._audit_toggleHistory('unchanged_section')" style="font-size:13px">${unchanged.length} unchanged files (click to expand)</button></td></tr>`;
    html += `<tr id="unchanged_section" class="history-panel"><td colspan="5" style="padding:8px 14px 8px 28px">`;
    for (const p of unchanged) {
      html += `<div style="font-size:12px;padding:2px 0;color:var(--text-secondary)">${esc(p)} <span class="hash" style="color:var(--green)">${esc(newEntries[p].slice(0, 16))}...</span></div>`;
    }
    html += '</td></tr>';
  }

  html += '</tbody></table>';
  main.innerHTML = html;
}

function buildHistoryRow(histId, path) {
  const snaps = cachedSnapshots;
  const currentSha = manifest?.tags?.find(t => t[0] === 'path' && t[1] === path)?.[2] || '';
  let html = `<tr id="${esc(histId)}" class="history-panel"><td colspan="5" style="padding:8px 14px">`;
  html += `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">Hash history for <strong>${esc(path)}</strong>:</div>`;

  for (const snap of snaps) {
    const sha = snap.entries?.[path];
    if (sha) {
      const isCurrent = sha === currentSha;
      html += `<div class="history-entry">
        <span class="timestamp">${fmtDateMs(snap.timestamp)}</span>
        <span class="hash ${isCurrent ? 'current' : ''}" style="cursor:pointer;text-decoration:underline" onclick="window._audit_showDiffModal('${esc(path)}','${esc(sha)}','${esc(currentSha)}')">${esc(sha)}</span>
        ${isCurrent ? '<span style="color:var(--green);font-size:10px">current</span>' : ''}
        ${!isCurrent && currentSha ? `<button class="btn-sm" style="font-size:10px;padding:2px 8px;margin-left:6px;color:var(--accent-blue);border-color:var(--accent-blue)" onclick="window._audit_showDiffModal('${esc(path)}','${esc(sha)}','${esc(currentSha)}')">diff</button>` : ''}
        ${snap.id ? `<span style="font-size:10px;color:var(--text-dim);margin-left:6px">nevent:${esc(snap.id.slice(0, 12))}...</span>` : ''}
      </div>`;
    }
  }
  html += '</td></tr>';
  return html;
}

/** Toggle a history panel open/closed */
function toggleHistory(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('show');
}

// =============================================
// Diff view — compare two blob versions side-by-side
// =============================================

/** Check if content type is text-based (can show diff) */
function isTextType(contentType) {
  if (!contentType) return false;
  return contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/xml' ||
    contentType === 'application/javascript';
}

/** Simple line-level diff: returns array of {type, line} entries */
function simpleDiff(oldLines, newLines) {
  const result = [];
  let oi = 0, ni = 0;

  const oldSet = new Map();
  oldLines.forEach((line, i) => {
    if (!oldSet.has(line)) oldSet.set(line, []);
    oldSet.get(line).push(i);
  });

  while (oi < oldLines.length && ni < newLines.length) {
    if (oldLines[oi] === newLines[ni]) {
      result.push({ type: 'same', oldLine: oldLines[oi], newLine: newLines[ni] });
      oi++; ni++;
    } else {
      const newIdx = newLines.slice(ni + 1).indexOf(oldLines[oi]);
      const oldIdx = oldLines.slice(oi + 1).indexOf(newLines[ni]);

      if (newIdx >= 0 && (oldIdx < 0 || newIdx <= oldIdx)) {
        for (let k = 0; k <= newIdx; k++) {
          result.push({ type: 'added', newLine: newLines[ni] });
          ni++;
        }
      } else if (oldIdx >= 0) {
        for (let k = 0; k <= oldIdx; k++) {
          result.push({ type: 'removed', oldLine: oldLines[oi] });
          oi++;
        }
      } else {
        result.push({ type: 'removed', oldLine: oldLines[oi] });
        result.push({ type: 'added', newLine: newLines[ni] });
        oi++; ni++;
      }
    }
  }
  while (oi < oldLines.length) {
    result.push({ type: 'removed', oldLine: oldLines[oi] });
    oi++;
  }
  while (ni < newLines.length) {
    result.push({ type: 'added', newLine: newLines[ni] });
    ni++;
  }
  return result;
}

/** Show diff modal comparing two blob versions by sha256 */
function showDiffModal(path, oldSha, newSha) {
  let modal = document.getElementById('diffModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'diffModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:var(--overlay);z-index:1000;justify-content:center;align-items:center';
    modal.innerHTML = `
      <div style="background:var(--bg-dark);border:1px solid var(--border);border-radius:12px;width:90vw;max-width:1100px;max-height:85vh;overflow:hidden;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid var(--border)">
          <h3 id="diffModalTitle" style="margin:0;color:var(--text-primary);font-size:15px">Diff</h3>
          <button onclick="document.getElementById('diffModal').style.display='none'" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div id="diffModalBody" style="padding:16px 20px;overflow-y:auto;font-size:13px;color:var(--text-primary)"></div>
      </div>`;
    document.body.appendChild(modal);
  }

  document.getElementById('diffModalTitle').textContent = `Diff: ${path}`;
  document.getElementById('diffModalBody').innerHTML = '<div style="color:var(--text-secondary)">Loading...</div>';
  modal.style.display = 'flex';

  (async () => {
    try {
      const server = blossomServer || 'https://blossom.primal.net';
      const [oldRes, newRes] = await Promise.all([
        proxyFetch(`${server}/${oldSha}`).catch(() => null),
        proxyFetch(`${server}/${newSha}`).catch(() => null),
      ]);

      if (!oldRes || !newRes) {
        document.getElementById('diffModalBody').innerHTML = '<div style="color:var(--red)">Could not fetch blob contents</div>';
        return;
      }

      const oldType = oldRes.headers.get('content-type') || '';
      const newType = newRes.headers.get('content-type') || '';

      if (!isTextType(oldType) && !isTextType(newType)) {
        document.getElementById('diffModalBody').innerHTML = `
          <div style="text-align:center;padding:30px;color:var(--text-secondary)">
            <p>Binary file — cannot show text diff</p>
            <div style="margin-top:12px;display:flex;justify-content:center;gap:24px">
              <a href="${server}/${oldSha}" target="_blank" style="color:var(--red)">Download old version</a>
              <a href="${server}/${newSha}" target="_blank" style="color:var(--green)">Download new version</a>
            </div>
          </div>`;
        return;
      }

      const [oldText, newText] = await Promise.all([oldRes.text(), newRes.text()]);
      const oldLines = oldText.split('\n');
      const newLines = newText.split('\n');
      const diff = simpleDiff(oldLines, newLines);

      let leftHtml = '';
      let rightHtml = '';
      let leftLineNum = 0;
      let rightLineNum = 0;

      for (const entry of diff) {
        const escaped = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (entry.type === 'same') {
          leftLineNum++; rightLineNum++;
          leftHtml += `<div class="diff-line same"><span class="diff-num">${leftLineNum}</span><span class="diff-text">${escaped(entry.oldLine)}</span></div>`;
          rightHtml += `<div class="diff-line same"><span class="diff-num">${rightLineNum}</span><span class="diff-text">${escaped(entry.newLine)}</span></div>`;
        } else if (entry.type === 'removed') {
          leftLineNum++;
          leftHtml += `<div class="diff-line removed"><span class="diff-num">${leftLineNum}</span><span class="diff-text">${escaped(entry.oldLine)}</span></div>`;
          rightHtml += `<div class="diff-line removed-empty"></div>`;
        } else if (entry.type === 'added') {
          rightLineNum++;
          leftHtml += `<div class="diff-line added-empty"></div>`;
          rightHtml += `<div class="diff-line added"><span class="diff-num">${rightLineNum}</span><span class="diff-text">${escaped(entry.newLine)}</span></div>`;
        }
      }

      document.getElementById('diffModalBody').innerHTML = `
        <div style="display:flex;gap:0;margin-bottom:8px">
          <div style="flex:1;text-align:center;font-size:11px;color:var(--red);padding:4px;border-bottom:2px solid var(--red)">Previous (${esc(oldSha.slice(0, 12))}...)</div>
          <div style="flex:1;text-align:center;font-size:11px;color:var(--green);padding:4px;border-bottom:2px solid var(--green)">Current (${esc(newSha.slice(0, 12))}...)</div>
        </div>
        <div style="display:flex;gap:0;overflow:auto;max-height:60vh">
          <div style="flex:1;overflow:auto;font-family:monospace;font-size:12px;line-height:1.6;border-right:1px solid var(--border)">${leftHtml}</div>
          <div style="flex:1;overflow:auto;font-family:monospace;font-size:12px;line-height:1.6">${rightHtml}</div>
        </div>`;
    } catch (e) {
      document.getElementById('diffModalBody').innerHTML = `<div style="color:var(--red)">Error: ${esc(e.message)}</div>`;
    }
  })();
}

// =============================================
// Snapshot detail modal
// =============================================
function showSnapshotModal(event, relayResults) {
  if (!event) return;
  let modal = document.getElementById('snapshotModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'snapshotModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:var(--overlay);z-index:1000;justify-content:center;align-items:center';
    modal.innerHTML = `
      <div style="background:var(--bg-dark);border:1px solid var(--border);border-radius:12px;width:680px;max-height:85vh;overflow:hidden;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border)">
          <h3 style="margin:0;color:var(--text-primary);font-size:16px">Snapshot Published</h3>
          <button onclick="document.getElementById('snapshotModal').style.display='none'" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div id="snapshotModalBody" style="padding:16px 20px;overflow-y:auto;font-size:13px;color:var(--text-primary)"></div>
      </div>`;
    document.body.appendChild(modal);
  }

  const body = document.getElementById('snapshotModalBody');
  const aggregateHash = event.tags.find(t => t[0] === 'x' && t[2] === 'aggregate')?.[1] || '';
  const manifestRef = event.tags.find(t => t[0] === 'a')?.[1] || '';
  const relayHtml = Object.entries(relayResults || {}).map(([url, status]) => {
    const color = status === 'ok' ? 'var(--green)' : status === 'pending' ? 'var(--amber)' : 'var(--red)';
    return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border-subtle)">
      <span style="font-family:monospace;font-size:11px;color:var(--text-secondary)">${esc(url)}</span>
      <span style="color:${color}">${esc(status)}</span>
    </div>`;
  }).join('');

  body.innerHTML = `
    <dl class="detail">
      <dt>Event ID:</dt>
      <dd style="font-family:monospace;font-size:11px;word-break:break-all;color:var(--accent-blue)">${esc(event.id)}</dd><br>
      <dt>Kind:</dt><dd>${event.kind}</dd><br>
      <dt>Created:</dt><dd>${esc(new Date(event.created_at * 1000).toISOString())}</dd><br>
      <dt>Pubkey:</dt><dd style="font-family:monospace;font-size:11px">${esc(event.pubkey)}</dd><br>
      ${manifestRef ? `<dt>Manifest Ref:</dt><dd style="font-family:monospace;font-size:11px;color:var(--accent-blue)">${esc(manifestRef)}</dd><br>` : ''}
      ${aggregateHash ? `<dt>Aggregate Hash:</dt><dd style="font-family:monospace;font-size:11px;color:var(--amber)">${esc(aggregateHash)}</dd><br>` : ''}
      ${relayHtml ? `<dt>Relay Results:</dt></dl><div style="margin-top:8px">${relayHtml}</div>` : '</dl>'}
    <div style="margin-top:16px">
      <dt style="margin-bottom:6px;display:block">Raw Event:</dt>
      <pre style="background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:var(--text-primary)">${esc(JSON.stringify(event, null, 2))}</pre>
    </div>`;

  modal.style.display = 'flex';
}

// =============================================
// File preview modal — click a file in snapshot preview
// =============================================
function previewFile(idx) {
  const entry = previewEntries[idx];
  if (!entry) return;

  const url = `${blossomServer}/${entry.sha256}`;

  let modal = document.getElementById('filePreviewModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'filePreviewModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:1001;justify-content:center;align-items:center';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
    document.body.appendChild(modal);
  }

  // Build preview content based on file type
  let preview = '';
  if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(entry.path)) {
    preview = `<img src="${esc(url)}" style="max-width:100%;max-height:60vh;border-radius:6px" onerror="this.outerHTML='<div style=\\'color:var(--red);padding:20px\\'>Failed to load image</div>'">`;
  } else if (/\.(mp4|webm|mov|ogg)$/i.test(entry.path)) {
    preview = `<video src="${esc(url)}" controls style="max-width:100%;max-height:60vh;border-radius:6px"></video>`;
  } else if (/\.(mp3|wav|flac|aac)$/i.test(entry.path)) {
    preview = `<audio src="${esc(url)}" controls style="width:100%"></audio>`;
  } else if (/\.(txt|md|json|js|ts|css|html|xml|yaml|yml|toml|sh|py|rs|go)$/i.test(entry.path)) {
    preview = `<iframe src="${esc(url)}" style="width:100%;height:50vh;border:1px solid var(--border);border-radius:6px;background:var(--bg-dark);color:var(--text-primary)"></iframe>`;
  } else {
    preview = `<div style="padding:40px;text-align:center;color:var(--text-secondary)">
      <div style="font-size:48px;margin-bottom:12px">&#128196;</div>
      <div>No preview available for this file type</div>
    </div>`;
  }

  modal.innerHTML = `
    <div style="background:var(--bg-dark);border:1px solid var(--border);border-radius:12px;width:720px;max-height:90vh;overflow:hidden;display:flex;flex-direction:column" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:14px;color:var(--text-primary);font-weight:600">${esc(entry.path.split('/').pop())}</span>
          <span class="source ${entry.source}" style="font-size:10px;padding:1px 6px;border-radius:3px">${entry.source}</span>
        </div>
        <button onclick="document.getElementById('filePreviewModal').style.display='none'" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer">&times;</button>
      </div>
      <div style="padding:16px;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:12px">
        ${preview}
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);display:flex;flex-wrap:wrap;gap:16px">
        <span><strong>Path:</strong> ${esc(entry.path)}</span>
        <span><strong>SHA256:</strong> <span style="font-family:monospace">${esc(entry.sha256.slice(0, 24))}...</span></span>
        ${entry.size ? `<span><strong>Size:</strong> ${fmtBytes(entry.size)}</span>` : ''}
        <a href="${esc(url)}" target="_blank" style="color:var(--accent-blue)">Open in new tab</a>
      </div>
    </div>`;

  modal.style.display = 'flex';
}

// =============================================
// Expose functions called from HTML onclick attributes
// =============================================
window._audit_toggleHistory = toggleHistory;
window._audit_showDiffModal = showDiffModal;
window._audit_showSnapshotModal = showSnapshotModal;
window._audit_previewFile = previewFile;

// Use a getter so onclick handlers always read the latest cachedRawEvents array
// (the module-level variable is reassigned in fetchSnapshots)
Object.defineProperty(window, '_audit_cachedRawEvents', {
  get() { return cachedRawEvents; },
  configurable: true,
});

// =============================================
// Start the app
// =============================================
init();

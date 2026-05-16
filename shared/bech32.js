/**
 * bech32.js — Bech32 encoding/decoding for Nostr (npub, nsec)
 *
 * Minimal implementation for converting between hex pubkeys/secrets
 * and their bech32-encoded forms. No dependencies.
 */

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

/**
 * Decode a bech32 string into { hrp, data } or null on failure.
 * Strips the 6-char checksum and verifies it.
 */
export function bech32Decode(str) {
  str = str.toLowerCase();
  const pos = str.lastIndexOf('1');
  if (pos < 1) return null;

  const hrp = str.slice(0, pos);
  const dataChars = str.slice(pos + 1);
  const data = [];
  for (const c of dataChars) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx === -1) return null;
    data.push(idx);
  }

  // Verify checksum
  const all = bech32HrpExpand(hrp).concat(data);
  if (bech32Polymod(all) !== 1) return null;

  return { hrp, data: data.slice(0, -6) };
}

/**
 * General bit conversion for bech32 (5-bit <-> 8-bit).
 */
export function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

/**
 * Decode an npub (or nprofile) string to a 64-char hex pubkey.
 * Returns null on invalid input.
 */
export function decodeNpub(npub) {
  const decoded = bech32Decode(npub);
  if (!decoded) return null;
  if (decoded.hrp !== 'npub') return null;
  const bytes = convertBits(decoded.data, 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Encode a 64-char hex pubkey as an npub string.
 */
export function encodeNpub(hex) {
  return encodeBech32('npub', hex);
}

/**
 * Encode a 64-char hex private key as an nsec string.
 */
export function encodeNsec(hex) {
  return encodeBech32('nsec', hex);
}

// Internal: generic bech32 encoder for 32-byte hex values
function encodeBech32(hrp, hex) {
  const bytes = [];
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const fiveBit = convertBits(bytes, 8, 5, true);
  const hrpExpand = bech32HrpExpand(hrp);
  const polymod = bech32Polymod(hrpExpand.concat(fiveBit).concat([0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);
  return hrp + '1' + fiveBit.concat(checksum).map(b => BECH32_CHARSET[b]).join('');
}

/**
 * Decode an nsec string to a 64-char hex private key.
 * Returns null on invalid input.
 */
export function decodeNsec(s) {
  const d = bech32Decode(s);
  if (!d || d.hrp !== 'nsec') return null;
  const b = convertBits(d.data, 5, 8, false);
  if (!b || b.length !== 32) return null;
  return b.map(x => x.toString(16).padStart(2, '0')).join('');
}

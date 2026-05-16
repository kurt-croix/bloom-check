/**
 * Nostr helpers for Playwright E2E tests.
 *
 * Hardcoded demo keypairs with profiles pre-published to relays.
 * Injects window.nostr mock into browser for NIP-07 compatibility.
 */

import { Page } from "@playwright/test";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { npubEncode, nsecEncode, decode } from "nostr-tools/nip19";

export interface Keypair {
  secretKey: Uint8Array;
  pubkeyHex: string;
  npub: string;
  nsec: string;
}

// Hardcoded demo keypairs — profiles already published to relays (kind 0)
// Producer: green "P" avatar, Auditor: red "A" avatar
const PRODUCER_NSEC = "nsec1l7ru3myyytnc6fc6wg3t7q3cf0jfj3m4umq7qpfragxe3jlajgesmujnt2";
const AUDITOR_NSEC = "nsec1cxtpwe6tszpasn2w8e8yan00gguhfc6f3pryz84vch6xmsne03nqq9tlqd";

function nsecToKeypair(nsec: string): Keypair {
  const d = decode(nsec);
  const secretKey = new Uint8Array(d.data as Uint8Array);
  const pubkeyHex = getPublicKey(secretKey);
  return {
    secretKey,
    pubkeyHex,
    npub: npubEncode(pubkeyHex),
    nsec,
  };
}

/** Producer keypair — green avatar, used for file uploads */
export const PRODUCER = nsecToKeypair(PRODUCER_NSEC);
/** Auditor keypair — red avatar, used for audit snapshots */
export const AUDITOR = nsecToKeypair(AUDITOR_NSEC);

/** Generate a fresh random keypair (for non-demo tests) */
export function generateKeypair(): Keypair {
  const secretKey = generateSecretKey();
  const pubkeyHex = getPublicKey(secretKey);
  return { secretKey, pubkeyHex, npub: npubEncode(pubkeyHex), nsec: nsecEncode(secretKey) };
}

/** Sign a Nostr event template using the keypair's secret key */
export function signEvent(
  keypair: Keypair,
  template: { kind: number; content: string; tags: string[][]; created_at: number }
) {
  return finalizeEvent(template, keypair.secretKey);
}

/**
 * Inject a NIP-07 compatible window.nostr mock into the browser.
 * Must be called before page.goto().
 */
export async function injectNostrExtension(page: Page, keypair: Keypair) {
  await page.exposeFunction("__nostrSign", (evt: any) =>
    signEvent(keypair, {
      kind: evt.kind,
      content: evt.content,
      tags: evt.tags,
      created_at: evt.created_at,
    })
  );

  await page.addInitScript((pubkey: string) => {
    (window as any).nostr = {
      async getPublicKey() { return pubkey; },
      async signEvent(event: any) {
        return (window as any).__nostrSign({
          kind: event.kind,
          content: event.content,
          tags: event.tags,
          created_at: event.created_at,
          pubkey: event.pubkey,
        });
      },
    };
  }, keypair.pubkeyHex);
}

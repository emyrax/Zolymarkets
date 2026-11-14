/**
 * Zolymarket — ZIP-321 Zcash Payment Request URI Utilities
 *
 * Implements URI construction according to the Zcash ZIP-321 specification:
 * `zcash:<recipient_address>?amount=<decimal_zec>&memo=<base64url_memo>`
 *
 * Designed to run identically in browser and Node.js runtimes without
 * relying on Node-only `Buffer` globals.
 */

import { OutcomeSide } from '../types/database.ts';

export interface Zip321RequestParams {
  address: string;
  amountZec: number;
  marketId: string;
  side: OutcomeSide;
  commitment: string;
}

/**
 * Encodes UTF-8 string into RFC 4648 unpadded Base64url format required by ZIP-321 `memo`.
 */
export function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Builds the structured Zolymarket shielded memo string embedded in the ZEC transaction.
 * Maximum shielded memo size in Zcash is 512 bytes.
 */
export function buildZolymarketMemo(
  marketId: string,
  side: OutcomeSide,
  commitment: string
): string {
  return `zolymarket:v1|m=${marketId}|s=${side}|c=${commitment}`;
}

/**
 * Formats a ZEC decimal amount up to 8 fractional digits without trailing zeros.
 */
export function formatZip321Amount(amountZec: number): string {
  if (!Number.isFinite(amountZec) || amountZec <= 0) {
    throw new Error('ZIP-321 amount must be a positive finite number.');
  }
  return amountZec.toFixed(8).replace(/\.?0+$/, '');
}

function isValidShieldedRecipient(address: string): boolean {
  const trimmed = address.trim();
  return (
    trimmed.startsWith('u1') ||
    trimmed.startsWith('utest1') ||
    trimmed.startsWith('uregtest1') ||
    trimmed.startsWith('zs1')
  );
}

/**
 * Generates a compliant ZIP-321 payment request URI and its plain-text memo payload.
 */
export function buildZip321Uri(params: Zip321RequestParams): {
  uri: string;
  memoPayload: string;
} {
  const address = params.address.trim();
  if (!isValidShieldedRecipient(address)) {
    throw new Error(
      'Recipient address must be a shielded Zcash Unified (u1.../utest1...) or Sapling (zs1...) address.'
    );
  }

  const memoPayload = buildZolymarketMemo(params.marketId, params.side, params.commitment);
  const encodedMemo = encodeBase64Url(memoPayload);
  const formattedAmount = formatZip321Amount(params.amountZec);

  const uri = `zcash:${address}?amount=${formattedAmount}&memo=${encodedMemo}`;
  return { uri, memoPayload };
}

/**
 * Generates the Phase 5 player betting ZIP-321 URI embedding JSON memo:
 * `{"q": marketId, "pick": side, "payout_to": returnAddr}` encoded as unpadded Base64URL.
 */
export function buildPlayerBetZip321Uri(params: {
  marketAddress: string;
  amountZec: number;
  marketId: string;
  side: OutcomeSide;
  returnAddr: string;
}): {
  uri: string;
  memoJson: string;
  base64UrlMemo: string;
  formattedAmount: string;
} {
  const marketAddress = params.marketAddress.trim();
  if (!isValidShieldedRecipient(marketAddress)) {
    throw new Error('Market shielded pool address is invalid.');
  }

  const returnAddr = params.returnAddr.trim();
  if (!isValidShieldedRecipient(returnAddr) || returnAddr.length < 20) {
    throw new Error('Return address must be a valid Zcash shielded address (u1..., utest1..., or zs1...).');
  }

  const memoObj = {
    q: params.marketId,
    pick: params.side,
    payout_to: returnAddr,
  };
  const memoJson = JSON.stringify(memoObj);
  const base64UrlMemo = encodeBase64Url(memoJson);
  const formattedAmount = formatZip321Amount(params.amountZec);
  const uri = `zcash:${marketAddress}?amount=${formattedAmount}&memo=${base64UrlMemo}`;

  return {
    uri,
    memoJson,
    base64UrlMemo,
    formattedAmount,
  };
}

/**
 * Decodes an RFC 4648 unpadded Base64url UTF-8 string (used by ZIP-321 `memo`).
 */
export function decodeBase64Url(input: string): string {
  const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export interface ParsedZip321Scan {
  kind: 'zip321' | 'zcash_address' | 'room_url';
  raw: string;
  address?: string;
  amountZec?: number;
  marketId?: string;
  pick?: OutcomeSide;
  returnAddr?: string;
  memoDecoded?: string;
}

/**
 * Parses a scanned QR string or pasted ZIP-321 URI, raw shielded Zcash address,
 * or Zolymarket room link so the UI can resolve and open the target market room.
 */
export function parseZip321Input(rawInput: string): ParsedZip321Scan | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // 1. Direct Zolymarket room URL or deep link (?market=... or /room/...)
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/room/')) {
    try {
      const url = new URL(trimmed, 'https://zolymarket.local');
      const roomMatch = url.pathname.match(/^\/room\/([^/]+)\/?$/i);
      if (roomMatch) {
        return {
          kind: 'room_url',
          raw: trimmed,
          marketId: decodeURIComponent(roomMatch[1]),
        };
      }
      const marketQuery = url.searchParams.get('market');
      if (marketQuery) {
        return {
          kind: 'room_url',
          raw: trimmed,
          marketId: marketQuery,
        };
      }
    } catch {
      // Ignore malformed URL and continue checking ZIP-321 / Zcash formats
    }
  }

  // 2. ZIP-321 payment URI: zcash:<address>?amount=<zec>&memo=<base64url>
  if (/^zcash:/i.test(trimmed)) {
    const withoutScheme = trimmed.slice(6).replace(/^\/\//, '');
    const qMarkIdx = withoutScheme.indexOf('?');
    const address = (qMarkIdx >= 0 ? withoutScheme.slice(0, qMarkIdx) : withoutScheme).trim();
    const queryStr = qMarkIdx >= 0 ? withoutScheme.slice(qMarkIdx + 1) : '';
    const params = new URLSearchParams(queryStr);

    const amountRaw = params.get('amount');
    const amountParsed = amountRaw ? Number.parseFloat(amountRaw) : undefined;
    const amountZec =
      amountParsed !== undefined && Number.isFinite(amountParsed) && amountParsed > 0
        ? amountParsed
        : undefined;

    let marketId: string | undefined;
    let pick: OutcomeSide | undefined;
    let returnAddr: string | undefined;
    let memoDecoded: string | undefined;

    const memoB64 = params.get('memo');
    if (memoB64) {
      try {
        memoDecoded = decodeBase64Url(memoB64);
        // Check Phase 5 JSON format: {"q": marketId, "pick": "YES"|"NO", "payout_to": "u1..."}
        if (memoDecoded.trim().startsWith('{')) {
          const parsedJson = JSON.parse(memoDecoded) as {
            q?: unknown;
            pick?: unknown;
            payout_to?: unknown;
          };
          if (typeof parsedJson.q === 'string' && parsedJson.q.trim()) {
            marketId = parsedJson.q.trim();
          }
          if (parsedJson.pick === OutcomeSide.Yes || parsedJson.pick === OutcomeSide.No) {
            pick = parsedJson.pick;
          }
          if (typeof parsedJson.payout_to === 'string' && parsedJson.payout_to.trim()) {
            returnAddr = parsedJson.payout_to.trim();
          }
        } else if (memoDecoded.startsWith('zolymarket:v1|')) {
          // Check Phase 1/2 pipe format: zolymarket:v1|m=<id>|s=<YES|NO>|c=<commitment>
          for (const part of memoDecoded.split('|')) {
            if (part.startsWith('m=')) marketId = part.slice(2).trim();
            if (part.startsWith('s=')) {
              const sVal = part.slice(2).trim().toUpperCase();
              if (sVal === OutcomeSide.Yes) pick = OutcomeSide.Yes;
              if (sVal === OutcomeSide.No) pick = OutcomeSide.No;
            }
          }
        }
      } catch {
        // Non-JSON / custom ZIP-321 memo still keeps the parsed recipient address
      }
    }

    if (address || marketId) {
      return {
        kind: 'zip321',
        raw: trimmed,
        address: address || undefined,
        amountZec,
        marketId,
        pick,
        returnAddr,
        memoDecoded,
      };
    }
  }

  // 3. Bare shielded Zcash address (u1..., utest1..., uregtest1..., zs1...)
  if (isValidShieldedRecipient(trimmed) && trimmed.length >= 20) {
    return {
      kind: 'zcash_address',
      raw: trimmed,
      address: trimmed,
    };
  }

  return null;
}


/**
 * Zolymarket — Zcash ZIP-321 Multi-Recipient Batch Payout Utilities
 *
 * Implements Zcash ZIP-321 URI construction for single or multi-recipient
 * shielded/transparent transactions so the host can sign batch payouts in
 * Zashi with a single QR scan.
 *
 * Format (ZIP-321):
 * `zcash:?address=<addr0>&amount=<amt0>[&memo=<b64url0>]&address.1=<addr1>&amount.1=<amt1>[&memo.1=<b64url1>]...`
 *
 * Isomorphic: runs identically in browser (Vite/React) and Node.js (`tsx`)
 * without relying on Node-only globals such as `Buffer`.
 */

export interface BatchPayoutRecipientInput {
  address: string;
  amount: number;
  memo?: string;
}

const MAX_ZEC_SUPPLY = 21_000_000;
const ZATOSHIS_PER_ZEC = 100_000_000;
const MAX_ZCASH_MEMO_BYTES = 512;

const ZCASH_ADDRESS_PREFIXES = [
  'u1',
  'utest1',
  'uregtest1',
  'zs1',
  'ztestsapling1',
  'zregtestsapling1',
  't1',
  't3',
  'tm',
] as const;

/**
 * Validates that a string looks like a well-formed Zcash Unified, Sapling, or Transparent address.
 */
export function isValidZcashAddress(address: string): boolean {
  if (typeof address !== 'string') return false;
  const trimmed = address.trim();
  if (trimmed.length < 20 || /\s|[?&#=]/.test(trimmed)) {
    return false;
  }
  return ZCASH_ADDRESS_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Encodes a UTF-8 memo string into RFC 4648 unpadded Base64URL (`-` / `_`, no `=`)
 * as specified by ZIP-321, validating the 512-byte Zcash memo limit.
 */
export function encodeZip321Memo(memo: string): string {
  const bytes = new TextEncoder().encode(memo);
  if (bytes.length > MAX_ZCASH_MEMO_BYTES) {
    throw new Error(
      `ZIP-321 memo exceeds Zcash's ${MAX_ZCASH_MEMO_BYTES}-byte limit (got ${bytes.length} bytes).`
    );
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Formats a ZEC decimal amount up to 8 fractional digits (1 zatoshi precision)
 * with no trailing zeros, rejecting non-positive or sub-zatoshi values.
 */
export function formatZip321ZecAmount(amount: number): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('ZIP-321 payout amount must be a positive finite number.');
  }
  if (amount > MAX_ZEC_SUPPLY) {
    throw new Error(`ZIP-321 payout amount exceeds maximum ZEC supply (${MAX_ZEC_SUPPLY}).`);
  }

  const zatoshis = Math.round(amount * ZATOSHIS_PER_ZEC);
  if (zatoshis <= 0) {
    throw new Error('ZIP-321 payout amount must be at least 1 zatoshi (0.00000001 ZEC).');
  }

  return (zatoshis / ZATOSHIS_PER_ZEC).toFixed(8).replace(/\.?0+$/, '');
}

/**
 * Generates a valid Zcash ZIP-321 multi-recipient URI string from an array of
 * `{ address, amount, memo? }` payout entries for one-tap Zashi signing.
 *
 * Param indexing follows ZIP-321:
 * - Recipient 0: `address`, `amount`, optional `memo`
 * - Recipient N (N >= 1): `address.N`, `amount.N`, optional `memo.N`
 */
export function generateBatchPayoutUri(
  recipients: readonly BatchPayoutRecipientInput[]
): string {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('At least one payout recipient is required to generate a ZIP-321 URI.');
  }

  const queryParams: string[] = [];

  recipients.forEach((recipient, index) => {
    if (!recipient || typeof recipient !== 'object') {
      throw new Error(`Invalid payout recipient entry at index ${index}.`);
    }

    const address = typeof recipient.address === 'string' ? recipient.address.trim() : '';
    if (!isValidZcashAddress(address)) {
      throw new Error(
        `Invalid Zcash recipient address at index ${index}: expected Unified (u1.../utest1...), Sapling (zs1...), or Transparent (t1.../t3.../tm...) address.`
      );
    }

    const formattedAmount = formatZip321ZecAmount(recipient.amount);
    const suffix = index === 0 ? '' : `.${index}`;

    queryParams.push(`address${suffix}=${address}`);
    queryParams.push(`amount${suffix}=${formattedAmount}`);

    if (typeof recipient.memo === 'string') {
      const trimmedMemo = recipient.memo.trim();
      if (trimmedMemo.length > 0) {
        queryParams.push(`memo${suffix}=${encodeZip321Memo(trimmedMemo)}`);
      }
    }
  });

  return `zcash:?${queryParams.join('&')}`;
}

/**
 * Zolymarket — On-Chain Zcash Testnet Explorer & Market Anchor Utilities
 *
 * Supports Zingo Wallet Testnet (`utest1...`) first-state workflows:
 * - Detects Zcash Testnet vs Mainnet from address prefixes (defaulting to testnet)
 * - Generates clickable Zcash Testnet / Mainnet block explorer links for `txid`s
 * - Validates 64-character hex Zcash transaction hashes
 * - Builds ZIP-321 anchor URIs so creators can anchor market creation on-chain
 */

import { encodeBase64Url } from './zip321.ts';

export type ZcashNetwork = 'testnet' | 'mainnet';

export interface ZcashExplorerLinks {
  txid: string;
  network: ZcashNetwork;
  primaryUrl: string;
  secondaryUrl: string;
  primaryLabel: string;
  secondaryLabel: string;
}

const TXID_64_HEX_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;
const ZCASH_ADDR_REGEX = /^(u1|uregtest1|utest1|zs1)[0-9a-zA-Z]{16,252}$/;

export function normalizeOnChainTxid(txid: string): string {
  return txid.trim().replace(/^0x/i, '').toLowerCase();
}

export function isValidOnChainTxid(txid: string): boolean {
  return TXID_64_HEX_REGEX.test(txid.trim());
}

export function getZcashNetworkFromAddress(address?: string | null): ZcashNetwork {
  const trimmed = (address ?? '').trim().toLowerCase();
  if (trimmed.startsWith('u1') || trimmed.startsWith('zs1')) {
    return 'mainnet';
  }
  return 'testnet';
}

export function getZcashTxExplorerUrls(
  txid: string,
  addressOrNetwork?: string | null
): ZcashExplorerLinks {
  const cleanTxid = normalizeOnChainTxid(txid);
  const network: ZcashNetwork =
    addressOrNetwork === 'mainnet'
      ? 'mainnet'
      : addressOrNetwork === 'testnet'
      ? 'testnet'
      : getZcashNetworkFromAddress(addressOrNetwork);

  if (network === 'mainnet') {
    return {
      txid: cleanTxid,
      network,
      primaryUrl: `https://mainnet.zcashexplorer.app/transactions/${encodeURIComponent(cleanTxid)}`,
      secondaryUrl: `https://blockchair.com/zcash/transaction/${encodeURIComponent(cleanTxid)}`,
      primaryLabel: 'Zcash Explorer',
      secondaryLabel: 'Blockchair',
    };
  }

  return {
    txid: cleanTxid,
    network,
    primaryUrl: `https://testnet.cipherscan.app/tx/${encodeURIComponent(cleanTxid)}`,
    secondaryUrl: `https://testnet.zcashblockexplorer.com/transactions/${encodeURIComponent(cleanTxid)}`,
    primaryLabel: 'CipherScan Testnet',
    secondaryLabel: 'Zcash Testnet Explorer',
  };
}

export function formatShortTxid(txid: string, head = 10, tail = 8): string {
  const clean = normalizeOnChainTxid(txid);
  if (clean.length <= head + tail + 3) return clean;
  return `${clean.slice(0, head)}...${clean.slice(-tail)}`;
}

export function generateSampleTestnetUnifiedAddress(tag = 'zingo'): string {
  const seed = tag.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let suffix = '';
  for (let i = 0; i < 48; i += 1) {
    suffix += charset[Math.floor(Math.random() * charset.length)];
  }
  return `utest1${seed}${suffix}`.slice(0, 72);
}

/**
 * Generates a ZIP-321 payment URI of 0.0001 ZEC (TAZ) carrying a structured
 * `create_market` memo so the creator can anchor market creation on Zingo Testnet
 * and obtain a verifiable `creationTxid`.
 */
export function buildMarketAnchorZip321Uri(params: {
  marketId: string;
  poolAddress: string;
  creatorAddress?: string;
  question?: string;
}): {
  uri: string;
  memoJson: string;
  base64UrlMemo: string;
  amountZec: number;
} {
  const poolAddress = params.poolAddress.trim();
  if (!ZCASH_ADDR_REGEX.test(poolAddress)) {
    throw new Error('Market shielded pool address must be a valid utest1... or u1... address.');
  }

  const memoObj = {
    v: 1,
    act: 'create_market',
    q: params.marketId.trim(),
    pool: poolAddress.slice(0, 28),
    ...(params.creatorAddress?.trim() ? { creator: params.creatorAddress.trim().slice(0, 28) } : {}),
    ...(params.question?.trim() ? { title: params.question.trim().slice(0, 72) } : {}),
  };

  const memoJson = JSON.stringify(memoObj);
  const base64UrlMemo = encodeBase64Url(memoJson);
  const amountZec = 0.0001;
  const uri = `zcash:${poolAddress}?amount=${amountZec}&memo=${base64UrlMemo}`;

  return {
    uri,
    memoJson,
    base64UrlMemo,
    amountZec,
  };
}

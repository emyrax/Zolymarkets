/**
 * Zolymarket — Shared TypeScript Types & Firebase Schema Contracts
 *
 * Mirrors the Cloud Firestore entities defined in `firebase-blueprint.json`.
 * All monetary amounts use integer zatoshis (1 ZEC = 100,000,000 zatoshis)
 * to avoid IEEE-754 floating-point rounding discrepancies.
 */

export enum MarketCategory {
  ZcashProtocol = 'Zcash Protocol',
  PrivacyCrypto = 'Privacy & Crypto',
  Governance = 'Governance',
  Ecosystem = 'Ecosystem',
  CreatorBets = 'Creator Bets',
}

export enum MarketStatus {
  Open = 'open',
  Locked = 'locked',
  Resolved = 'resolved',
  Cancelled = 'cancelled',
}

export enum OutcomeSide {
  Yes = 'YES',
  No = 'NO',
}

export enum ShieldedTxStatus {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Settled = 'settled',
  Refunded = 'refunded',
}

export interface Creator {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  zcashUnifiedAddress: string;
  verified: boolean;
  marketsCreatedCount: number;
  totalVolumeZatoshis: number;
  createdAt: string;
}

export interface Outcome {
  id: string;
  marketId: string;
  side: OutcomeSide;
  poolZatoshis: number;
  sharesOutstanding: number;
  updatedAt: string;
}

export interface Market {
  id: string;
  slug: string;
  creatorId: string;
  ownerUid?: string;
  question: string;
  description: string;
  resolutionCriteria: string;
  category: MarketCategory;
  status: MarketStatus;
  shieldedPoolAddress: string;
  creationTxid?: string | null;
  creatorFeeBps: number;
  totalVolumeZatoshis: number;
  liquidityZatoshis: number;
  yesProbability24hAgo: number;
  winningOutcome: OutcomeSide | null;
  duration?: number; // Lock period duration in hours
  closesAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Hydrated market payload returned by `/api/markets` combining
 * the market row, its creator profile, and YES/NO pool outcomes.
 */
export interface MarketWithDetails extends Market {
  creator: Creator;
  outcomes: {
    yes: Outcome;
    no: Outcome;
  };
  yesProbability: number; // 0..100 percentage derived from CPMM reserves
  noProbability: number;  // 0..100 percentage derived from CPMM reserves
  change24hPct: number;   // Signed 24-hour percentage-point delta for YES price
}

export interface Position {
  id: string;
  marketId: string;
  side: OutcomeSide;
  traderCommitment: string;
  payoutAddress: string | null;
  shares: number;
  costBasisZatoshis: number;
  claimed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShieldedTransaction {
  id: string;
  marketId: string;
  positionId: string | null;
  side: OutcomeSide;
  txid: string | null;
  zip321Uri: string;
  memoPayload: string;
  amountZatoshis: number;
  status: ShieldedTxStatus;
  confirmations: number;
  createdAt: string;
  confirmedAt: string | null;
}

export interface DecodedBetMemo {
  q: string;
  pick: 'YES' | 'NO';
  payout_to: string;
}

export interface ShieldedBet {
  id: string;
  marketId: string;
  txid: string;
  poolType: 'orchard' | 'sapling';
  recipientAddress: string;
  pick: OutcomeSide;
  payoutTo: string;
  amountZatoshis: number;
  rawMemoHex: string;
  decodedMemoJson: DecodedBetMemo;
  confirmations: number;
  createdAt: string;
}

export interface BatchPayoutItem {
  address: string;
  amount: number; // ZEC decimal amount for zingo-cli send
  memo?: string;
}

/**
 * WebSocket event payloads broadcast by the server to subscribed clients.
 */
export type RealtimeEvent =
  | { type: 'markets:sync'; payload: MarketWithDetails[] }
  | { type: 'market:updated'; payload: MarketWithDetails }
  | { type: 'tx:confirmed'; payload: ShieldedTransaction }
  | { type: 'bet:confirmed'; payload: ShieldedBet };

/**
 * Schema metadata descriptor used by the Phase 1 Schema Explorer UI.
 */
export interface SchemaTableDoc {
  name: string;
  purpose: string;
  realtimeEnabled: boolean;
  columns: {
    name: string;
    type: string;
    constraints: string;
    notes: string;
  }[];
}

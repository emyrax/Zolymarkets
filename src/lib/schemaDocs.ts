/**
 * Zolymarket — Google Firebase (Cloud Firestore) Schema & Architecture Metadata
 *
 * Used by the Schema Explorer view to document the Firestore collections,
 * security rules invariants, and modular codebase layout.
 */

import { SchemaTableDoc } from '../types/database.ts';

export const SCHEMA_TABLES: SchemaTableDoc[] = [
  {
    name: 'creators',
    purpose: 'Stores creator profiles, verified handles, owner UIDs, and Zcash Unified Addresses (u1...) for fee attribution.',
    realtimeEnabled: true,
    columns: [
      { name: 'id', type: 'string', constraints: 'Document ID', notes: 'Validated ID (1–128 chars)' },
      { name: 'ownerUid', type: 'string', constraints: 'Immutable UID', notes: 'Firebase Auth UID of creator' },
      { name: 'handle', type: 'string', constraints: '2–40 chars', notes: 'Public creator handle' },
      { name: 'displayName', type: 'string', constraints: '1–80 chars', notes: 'Display name on market cards' },
      { name: 'zcashUnifiedAddress', type: 'string', constraints: 'u1 / uregtest1', notes: 'Shielded payout address' },
      { name: 'verified', type: 'boolean', constraints: 'Admin-only', notes: 'Verified creator status' },
      { name: 'totalVolumeZatoshis', type: 'integer', constraints: '>= 0', notes: 'Cumulative market volume' },
    ],
  },
  {
    name: 'markets',
    purpose: 'Binary prediction market questions, resolution criteria, shielded pool address, and atomic CPMM reserves.',
    realtimeEnabled: true,
    columns: [
      { name: 'id', type: 'string', constraints: 'Document ID', notes: 'Market identifier' },
      { name: 'slug', type: 'string', constraints: '3–128 chars', notes: 'URL-friendly market slug' },
      { name: 'creatorId', type: 'string', constraints: 'exists(/creators)', notes: 'Immutable parent creator ref' },
      { name: 'question', type: 'string', constraints: '10–280 chars', notes: 'Binary YES/NO market question' },
      { name: 'category', type: 'string', constraints: 'Enum', notes: 'Zcash Protocol, Governance, etc.' },
      { name: 'status', type: 'string', constraints: 'Terminal locked', notes: 'open | locked | resolved | cancelled' },
      { name: 'shieldedPoolAddress', type: 'string', constraints: 'u1 / uregtest1', notes: 'Dedicated ZIP-321 pool address' },
      { name: 'yesPoolZatoshis', type: 'integer', constraints: '> 0', notes: 'CPMM YES reserve in zatoshis' },
      { name: 'noPoolZatoshis', type: 'integer', constraints: '> 0', notes: 'CPMM NO reserve in zatoshis' },
      { name: 'yesProbability24hAgo', type: 'number', constraints: '0..100', notes: '24-hour baseline YES odds' },
    ],
  },
  {
    name: 'shielded_bets',
    purpose: 'Immutable ledger of unspent Orchard/Sapling notes parsed from `zingo-cli notes` with decoded JSON memos.',
    realtimeEnabled: true,
    columns: [
      { name: 'id', type: 'string', constraints: 'Document ID', notes: 'Bet record ID' },
      { name: 'marketId', type: 'string', constraints: 'exists(/markets)', notes: 'Target market reference' },
      { name: 'txid', type: 'string', constraints: 'Hex 16–128', notes: 'Zcash shielded transaction ID' },
      { name: 'poolType', type: 'string', constraints: 'orchard | sapling', notes: 'Shielded note pool origin' },
      { name: 'pick', type: 'string', constraints: 'YES | NO', notes: 'Parsed outcome pick from memo' },
      { name: 'payoutTo', type: 'string', constraints: 'u1 / uregtest1', notes: 'Winner settlement address' },
      { name: 'amountZatoshis', type: 'integer', constraints: '> 0', notes: 'Exact note value in zatoshis' },
      { name: 'decodedMemo', type: 'map', constraints: '{q, pick, payout_to}', notes: 'Native Firestore Map' },
    ],
  },
  {
    name: 'positions',
    purpose: 'Owner-scoped outcome share positions indexed by Firebase UID and shielded commitment.',
    realtimeEnabled: false,
    columns: [
      { name: 'id', type: 'string', constraints: 'Document ID', notes: 'Position ID' },
      { name: 'marketId', type: 'string', constraints: 'exists(/markets)', notes: 'Market reference' },
      { name: 'ownerUid', type: 'string', constraints: 'Owner-scoped read', notes: 'Firebase Auth UID' },
      { name: 'side', type: 'string', constraints: 'YES | NO', notes: 'Outcome side held' },
      { name: 'traderCommitment', type: 'string', constraints: '4–128 chars', notes: 'Shielded commitment tag' },
      { name: 'shares', type: 'number', constraints: '> 0', notes: 'Shares held by position' },
      { name: 'costBasisZatoshis', type: 'integer', constraints: '> 0', notes: 'Total ZEC spent in zatoshis' },
    ],
  },
  {
    name: 'shielded_transactions',
    purpose: 'ZIP-321 payment request URIs and confirmation tracking across pending, confirmed, and settled states.',
    realtimeEnabled: true,
    columns: [
      { name: 'id', type: 'string', constraints: 'Document ID', notes: 'Transaction intent ID' },
      { name: 'marketId', type: 'string', constraints: 'exists(/markets)', notes: 'Target market' },
      { name: 'side', type: 'string', constraints: 'YES | NO', notes: 'Requested outcome side' },
      { name: 'zip321Uri', type: 'string', constraints: '10–1500 chars', notes: 'zcash:u1...?amount=...&memo=...' },
      { name: 'memoPayload', type: 'string', constraints: '1–512 chars', notes: 'Structured memo payload' },
      { name: 'amountZatoshis', type: 'integer', constraints: '> 0', notes: 'Exact payment amount' },
      { name: 'status', type: 'string', constraints: 'Enum', notes: 'pending | confirmed | settled | refunded' },
    ],
  },
  {
    name: 'users/{uid}/private/info',
    purpose: 'Split-collection PII isolation storing user email exclusively for the owner or verified admin.',
    realtimeEnabled: false,
    columns: [
      { name: 'uid', type: 'string', constraints: 'Matches path uid', notes: 'Firebase Auth UID' },
      { name: 'email', type: 'string', constraints: '3–254 chars', notes: 'Isolated private email' },
      { name: 'createdAt', type: 'timestamp', constraints: '== request.time', notes: 'Server creation timestamp' },
      { name: 'updatedAt', type: 'timestamp', constraints: '== request.time', notes: 'Server update timestamp' },
    ],
  },
];

export interface ProjectModuleDoc {
  path: string;
  role: string;
  phase: 'Phase 1' | 'Phase 2' | 'Upcoming';
}

export const PROJECT_MODULES: ProjectModuleDoc[] = [
  { path: 'firebase-blueprint.json', role: 'Cloud Firestore entity schemas and collection path mappings', phase: 'Phase 1' },
  { path: 'firestore.rules', role: 'Zero-trust Firestore security rules with PII isolation and type validation', phase: 'Phase 1' },
  { path: 'src/lib/firebase.ts', role: 'Firebase Client SDK init, Google Auth provider, and structured error handler', phase: 'Phase 1' },
  { path: 'src/contexts/AuthContext.tsx', role: 'Google Sign-In popup auth flow and split public/private user profile sync', phase: 'Phase 1' },
  { path: 'src/hooks/useRealtimeMarkets.ts', role: 'Real-time Cloud Firestore onSnapshot listener for markets and creators', phase: 'Phase 1' },
  { path: 'src/lib/zip321.ts', role: 'RFC 4648 Base64url memo encoder and ZIP-321 zcash: URI builder', phase: 'Phase 1' },
  { path: 'src/lib/cpmm.ts', role: 'Integer zatoshi conversions and Constant Product Market Maker pricing', phase: 'Phase 1' },
  { path: 'lib/zcash-service.ts', role: 'zingo-cli wrapper: createNewMarketWallet, pollMempoolForBets, executeBatchPayout', phase: 'Phase 2' },
  { path: 'server.ts', role: 'Express API routes for zingo-cli node operations and Vite dev middleware', phase: 'Phase 2' },
];

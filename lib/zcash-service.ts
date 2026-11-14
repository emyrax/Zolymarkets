/**
 * Zolymarket — Phase 2 Real Zcash Node Integration Service (zingo-cli)
 *
 * Wraps the local `zingo-cli` binary via `child_process.exec` for:
 * 1. `createNewMarketWallet()` — Provisions a fresh shielded Unified Address + UFVK
 * 2. `pollMempoolForBets(marketId, address)` — Scans unspent Orchard/Sapling notes,
 *    decodes hex-encoded memos to UTF-8 JSON, and records new valid bets by `txid`
 * 3. `executeBatchPayout(payoutArray)` — Executes batch `z_sendmany`-style payouts
 *    via `zingo-cli send '[...]'` when a prediction market resolves
 */

import { exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminFirestore } from '../src/lib/firebase-admin.ts';
import { store } from '../src/server/store.ts';
import {
  BatchPayoutItem,
  DecodedBetMemo,
  MarketWithDetails,
  OutcomeSide,
  ShieldedBet,
} from '../src/types/database.ts';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024; // 8 MiB for large note lists

/**
 * Typed error raised when `zingo-cli` is unavailable, fails execution,
 * or produces malformed JSON output.
 */
export class ZingoCliError extends Error {
  public readonly code:
    | 'ZINGO_CLI_NOT_FOUND'
    | 'ZINGO_CLI_EXEC_FAILED'
    | 'ZINGO_PARSE_ERROR'
    | 'INVALID_INPUT';

  constructor(
    message: string,
    code:
      | 'ZINGO_CLI_NOT_FOUND'
      | 'ZINGO_CLI_EXEC_FAILED'
      | 'ZINGO_PARSE_ERROR'
      | 'INVALID_INPUT',
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ZingoCliError';
    this.code = code;
  }
}

export interface MarketWalletCredentials {
  address: string;
  ufvk: string;
}

export interface PollMempoolResult {
  marketId: string;
  address: string;
  scannedNotesCount: number;
  insertedBets: ShieldedBet[];
  skippedDuplicateTxids: string[];
  updatedMarket: MarketWithDetails | null;
}

export interface BatchPayoutResult {
  txids: string[];
  rawOutput: string;
  recipientCount: number;
  totalAmountZec: number;
}

export interface ZingoCliStatus {
  available: boolean;
  version: string | null;
  binary: string;
  chain: 'testnet' | 'regtest' | 'mainnet';
  serverUri: string | null;
  dataDir: string | null;
  dataDirExists: boolean | null;
  error: string | null;
}

interface ZingoNoteRecord {
  txid?: string;
  output_index?: number;
  value?: number;
  zatoshis?: number;
  amount?: number;
  address?: string;
  recipient?: string;
  to?: string;
  memo?: string;
  memo_hex?: string;
  spent?: boolean | string | null;
  confirmations?: number;
  unconfirmed?: boolean;
}

interface ZingoNotesResponse {
  unspent_orchard_notes?: ZingoNoteRecord[];
  unspent_sapling_notes?: ZingoNoteRecord[];
  pending_orchard_notes?: ZingoNoteRecord[];
  pending_sapling_notes?: ZingoNoteRecord[];
}

/**
 * Resolves the configured `zingo-cli` binary and optional `--data-dir` flag.
 */
function getZingoBinary(): string {
  const configured = process.env.ZINGO_CLI_BIN?.trim();
  const bin = configured && configured.length > 0 ? configured : 'zingo-cli';
  // Guard against shell metacharacters in binary path
  if (!/^[a-zA-Z0-9_./-]+$/.test(bin)) {
    throw new ZingoCliError(
      'Invalid ZINGO_CLI_BIN path characters.',
      'INVALID_INPUT'
    );
  }
  return bin;
}

function getZingoChain(): 'testnet' | 'regtest' | 'mainnet' {
  const explicitChain = process.env.ZINGO_CHAIN?.trim().toLowerCase();
  if (explicitChain) {
    if (
      explicitChain === 'testnet' ||
      explicitChain === 'regtest' ||
      explicitChain === 'mainnet'
    ) {
      return explicitChain;
    }
    throw new ZingoCliError(
      `Invalid ZINGO_CHAIN "${explicitChain}". Expected testnet, regtest, or mainnet.`,
      'INVALID_INPUT'
    );
  }

  // Backward-compatible fallback if legacy ZINGO_NETWORK_FLAG is present
  const legacyFlag = process.env.ZINGO_NETWORK_FLAG?.trim().toLowerCase();
  if (legacyFlag === '--regtest' || legacyFlag === 'regtest') return 'regtest';
  if (legacyFlag === '--mainnet' || legacyFlag === 'mainnet') return 'mainnet';
  return 'testnet';
}

function getZingoServerUri(chain: 'testnet' | 'regtest' | 'mainnet'): string | null {
  const configured = process.env.ZINGO_SERVER_URI?.trim();
  if (configured !== undefined) {
    if (configured.length === 0) return null;
    if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/[a-zA-Z0-9._/-]*)?$/.test(configured)) {
      throw new ZingoCliError(
        'Invalid ZINGO_SERVER_URI format. Expected http(s)://host[:port].',
        'INVALID_INPUT'
      );
    }
    return configured;
  }

  return chain === 'testnet' ? 'https://testnet.zec.rocks:443' : null;
}

function resolveDataDir(): string | null {
  const raw = process.env.ZINGO_DATA_DIR?.trim();
  if (!raw) return null;
  if (raw.startsWith('~/')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  if (raw.startsWith('$HOME/')) {
    return path.join(os.homedir(), raw.slice(6));
  }
  return raw;
}

function buildZingoGlobalFlags(): string {
  const chain = getZingoChain();
  const serverUri = getZingoServerUri(chain);
  const dataDir = resolveDataDir();

  const parts: string[] = [`--chain ${shellQuote(chain)}`];
  if (serverUri) {
    parts.push(`--server ${shellQuote(serverUri)}`);
  }
  if (dataDir) {
    parts.push(`--data-dir ${shellQuote(dataDir)}`);
  }
  return parts.join(' ');
}

/**
 * Safely wraps a string argument in POSIX single quotes for `child_process.exec`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Executes a `zingo-cli` command and returns trimmed stdout.
 */
async function runZingoCommand(commandArgs: string): Promise<string> {
  const bin = getZingoBinary();
  const globalFlags = buildZingoGlobalFlags();
  const fullCommand = `${bin} ${globalFlags} ${commandArgs}`.trim();

  try {
    const { stdout } = await execAsync(fullCommand, {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
    });
    return stdout.trim();
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    const message = err?.message ?? '';
    if (
      err?.code === 'ENOENT' ||
      message.includes('not found') ||
      message.includes('ENOENT')
    ) {
      throw new ZingoCliError(
        `zingo-cli binary ("${bin}") was not found in PATH. Install zingo-cli or configure ZINGO_CLI_BIN.`,
        'ZINGO_CLI_NOT_FOUND',
        { cause: error }
      );
    }
    throw new ZingoCliError(
      `zingo-cli execution failed: ${err?.stderr?.trim() || message}`,
      'ZINGO_CLI_EXEC_FAILED',
      { cause: error }
    );
  }
}

/**
 * Checks whether `zingo-cli` is reachable on the host and returns sanitized
 * `.env` configuration details for the Zingo Setup diagnostic check.
 */
export async function checkZingoCliStatus(): Promise<ZingoCliStatus> {
  let binary = 'zingo-cli';
  let chain: 'testnet' | 'regtest' | 'mainnet' = 'testnet';
  let serverUri: string | null = null;
  let dataDir: string | null = null;

  try {
    binary = getZingoBinary();
    chain = getZingoChain();
    serverUri = getZingoServerUri(chain);
    dataDir = resolveDataDir();
  } catch (error) {
    return {
      available: false,
      version: null,
      binary,
      chain,
      serverUri,
      dataDir,
      dataDirExists: null,
      error: error instanceof Error ? error.message : 'Invalid ZINGO_* environment configuration.',
    };
  }

  const dataDirExists = dataDir ? fs.existsSync(dataDir) : null;

  try {
    const { stdout } = await execAsync(`${binary} --version`, {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const version = stdout.trim() || 'installed';
    return {
      available: true,
      version,
      binary,
      chain,
      serverUri,
      dataDir,
      dataDirExists,
      error: null,
    };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = err?.stderr?.trim() || err?.message || 'zingo-cli binary not reachable';
    return {
      available: false,
      version: null,
      binary,
      chain,
      serverUri,
      dataDir,
      dataDirExists,
      error:
        err?.code === 'ENOENT' || detail.includes('not found')
          ? `Binary "${binary}" was not found on this host.`
          : detail,
    };
  }
}

/**
 * Extracts the first valid JSON object or array from CLI stdout
 * (tolerant of leading informational log lines emitted by zingo-cli).
 */
export function extractJsonFromCliOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const firstObj = trimmed.indexOf('{');
    const firstArr = trimmed.indexOf('[');
    const startIdx =
      firstObj === -1
        ? firstArr
        : firstArr === -1
        ? firstObj
        : Math.min(firstObj, firstArr);

    if (startIdx === -1) {
      throw new ZingoCliError(
        'zingo-cli output did not contain a JSON payload.',
        'ZINGO_PARSE_ERROR'
      );
    }

    const candidate = trimmed.slice(startIdx);
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      throw new ZingoCliError(
        'Failed to parse JSON from zingo-cli stdout.',
        'ZINGO_PARSE_ERROR',
        { cause: error }
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Hex Memo Decoding Utilities
// -----------------------------------------------------------------------------

/**
 * Decodes a Zcash hex-encoded memo string into a trimmed UTF-8 string.
 * Strips optional `0x` prefix and trailing 0x00 null padding bytes from
 * Zcash's fixed 512-byte shielded memo field.
 */
export function decodeHexMemoToUtf8(rawMemo: string): string {
  const trimmed = rawMemo.trim();
  if (!trimmed) return '';

  // Support already-decoded JSON strings if a CLI version outputs plaintext
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const cleanHex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
    throw new ZingoCliError(
      'Invalid hex-encoded Zcash memo payload.',
      'ZINGO_PARSE_ERROR'
    );
  }

  const bytes = Buffer.from(cleanHex, 'hex');
  // Strip Zcash 512-byte trailing zero padding
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) {
    end -= 1;
  }

  return bytes.subarray(0, end).toString('utf8').trim();
}

/**
 * Decodes a hex-encoded Zcash memo and validates the Zolymarket bet JSON shape:
 * `{"q":"mkt_id","pick":"YES","payout_to":"u1..."}`
 */
export function decodeBetMemoJson(rawMemo: string): DecodedBetMemo | null {
  try {
    const utf8 = decodeHexMemoToUtf8(rawMemo);
    if (!utf8) return null;

    const parsed = JSON.parse(utf8) as Partial<DecodedBetMemo>;
    if (
      typeof parsed.q !== 'string' ||
      parsed.q.trim().length === 0 ||
      (parsed.pick !== 'YES' && parsed.pick !== 'NO') ||
      typeof parsed.payout_to !== 'string' ||
      !isValidZcashAddress(parsed.payout_to)
    ) {
      return null;
    }

    return {
      q: parsed.q.trim(),
      pick: parsed.pick,
      payout_to: parsed.payout_to.trim(),
    };
  } catch {
    return null;
  }
}

function isValidZcashAddress(address: string): boolean {
  const trimmed = address.trim();
  return (
    trimmed.startsWith('u1') ||
    trimmed.startsWith('uregtest1') ||
    trimmed.startsWith('utest1') ||
    trimmed.startsWith('zs1') ||
    trimmed.startsWith('zregtestsapling1')
  );
}

// -----------------------------------------------------------------------------
// 1. createNewMarketWallet()
// -----------------------------------------------------------------------------

/**
 * Creates a new Zcash market wallet using `zingo-cli --chain <chain> --server <uri> new`
 * and extracts the Unified Address (`utest1...` / `u1...`) and Unified Full Viewing Key (UFVK).
 */
export async function createNewMarketWallet(): Promise<MarketWalletCredentials> {
  const newStdout = await runZingoCommand('new');
  const parsedNew = extractJsonFromCliOutput<Record<string, unknown>>(newStdout);

  const credentials = extractWalletCredentials(parsedNew, newStdout);
  if (credentials.address && credentials.ufvk) {
    return {
      address: credentials.address,
      ufvk: credentials.ufvk,
    };
  }

  // Fallback: query addresses and UFVK explicitly if `new` returned minimal JSON
  let address = credentials.address;
  let ufvk = credentials.ufvk;

  if (!address) {
    const addrStdout = await runZingoCommand('addresses');
    const addrParsed = extractJsonFromCliOutput<unknown>(addrStdout);
    address = findAddressInPayload(addrParsed, addrStdout);
  }

  if (!ufvk) {
    const ufvkStdout = await runZingoCommand('exportufvk');
    const ufvkParsed = extractJsonFromCliOutput<unknown>(ufvkStdout);
    ufvk = findUfvkInPayload(ufvkParsed, ufvkStdout);
  }

  if (!address || !ufvk) {
    throw new ZingoCliError(
      'Unable to extract Unified Address and UFVK from zingo-cli output.',
      'ZINGO_PARSE_ERROR'
    );
  }

  return { address, ufvk };
}

function extractWalletCredentials(
  payload: unknown,
  rawText: string
): { address: string | null; ufvk: string | null } {
  return {
    address: findAddressInPayload(payload, rawText),
    ufvk: findUfvkInPayload(payload, rawText),
  };
}

function findAddressInPayload(payload: unknown, rawText: string): string | null {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const candidateKeys = ['address', 'unified_address', 'ua', 'encoded_address'];
    for (const key of candidateKeys) {
      const val = record[key];
      if (typeof val === 'string' && isValidZcashAddress(val)) {
        return val;
      }
    }
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const nested = findAddressInPayload(item, '');
        if (nested) return nested;
      }
    }
    for (const val of Object.values(record)) {
      if (val && typeof val === 'object') {
        const nested = findAddressInPayload(val, '');
        if (nested) return nested;
      }
    }
  }

  const uaMatch = rawText.match(/\b(u(?:regtest|test)?1[0-9a-z]{20,})\b/);
  return uaMatch ? uaMatch[1] : null;
}

function findUfvkInPayload(payload: unknown, rawText: string): string | null {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const candidateKeys = ['ufvk', 'viewing_key', 'unified_full_viewing_key'];
    for (const key of candidateKeys) {
      const val = record[key];
      if (typeof val === 'string' && val.startsWith('uview')) {
        return val;
      }
    }
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const nested = findUfvkInPayload(item, '');
        if (nested) return nested;
      }
    }
    for (const val of Object.values(record)) {
      if (val && typeof val === 'object') {
        const nested = findUfvkInPayload(val, '');
        if (nested) return nested;
      }
    }
  }

  const ufvkMatch = rawText.match(/\b(uview(?:regtest|test)?1[0-9a-z]{20,})\b/);
  return ufvkMatch ? ufvkMatch[1] : null;
}

// -----------------------------------------------------------------------------
// 2. pollMempoolForBets(marketId, address)
// -----------------------------------------------------------------------------

/**
 * Executes `zingo-cli notes` to scan unspent Orchard/Sapling notes sent to
 * `address`, decodes hex memos as JSON (`{"q","pick","payout_to"}`), and
 * inserts newly discovered `txid`s into Cloud Firestore `shielded_bets`
 * (and the local server store).
 */
export async function pollMempoolForBets(
  marketId: string,
  address: string
): Promise<PollMempoolResult> {
  if (!marketId.trim() || !isValidZcashAddress(address)) {
    throw new ZingoCliError(
      'pollMempoolForBets requires a valid marketId and Zcash shielded address.',
      'INVALID_INPUT'
    );
  }

  const stdout = await runZingoCommand('notes');
  const notesPayload = extractJsonFromCliOutput<ZingoNotesResponse>(stdout);

  const result = ingestZingoNotesResponse(marketId, address, notesPayload);

  // Persist newly discovered bets and updated CPMM reserves to Cloud Firestore
  if (result.insertedBets.length > 0) {
    const adminDb = getAdminFirestore();
    if (adminDb) {
      const batch = adminDb.batch();
      for (const bet of result.insertedBets) {
        const betRef = adminDb.collection('shielded_bets').doc(bet.id);
        batch.set(betRef, {
          id: bet.id,
          marketId: bet.marketId,
          txid: bet.txid,
          poolType: bet.poolType,
          recipientAddress: bet.recipientAddress,
          pick: bet.pick,
          payoutTo: bet.payoutTo,
          amountZatoshis: bet.amountZatoshis,
          rawMemoHex: bet.rawMemoHex,
          decodedMemo: bet.decodedMemoJson,
          confirmations: bet.confirmations,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      if (result.updatedMarket) {
        const marketRef = adminDb.collection('markets').doc(result.updatedMarket.id);
        batch.set(
          marketRef,
          {
            yesPoolZatoshis: result.updatedMarket.outcomes.yes.poolZatoshis,
            noPoolZatoshis: result.updatedMarket.outcomes.no.poolZatoshis,
            yesSharesOutstanding: result.updatedMarket.outcomes.yes.sharesOutstanding,
            noSharesOutstanding: result.updatedMarket.outcomes.no.sharesOutstanding,
            totalVolumeZatoshis: result.updatedMarket.totalVolumeZatoshis,
            liquidityZatoshis: result.updatedMarket.liquidityZatoshis,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      await batch.commit().catch((err) => {
        console.warn('Firestore Admin sync skipped or failed:', err);
      });
    }
  }

  return result;
}

/**
 * Pure parser & persistence routine for `zingo-cli notes` JSON payloads.
 * Separated from `exec` so note parsing and memo decoding remain modular.
 */
export function ingestZingoNotesResponse(
  marketId: string,
  address: string,
  notesPayload: ZingoNotesResponse
): PollMempoolResult {
  const orchardNotes = [
    ...(notesPayload.unspent_orchard_notes ?? []),
    ...(notesPayload.pending_orchard_notes ?? []),
  ].map((note) => ({ note, poolType: 'orchard' as const }));

  const saplingNotes = [
    ...(notesPayload.unspent_sapling_notes ?? []),
    ...(notesPayload.pending_sapling_notes ?? []),
  ].map((note) => ({ note, poolType: 'sapling' as const }));

  const candidates = [...orchardNotes, ...saplingNotes];
  const insertedBets: ShieldedBet[] = [];
  const skippedDuplicateTxids: string[] = [];
  let updatedMarket: MarketWithDetails | null = null;

  for (const { note, poolType } of candidates) {
    // Skip spent notes
    if (note.spent && note.spent !== 'false') {
      continue;
    }

    // Filter notes sent to the market's shielded pool address
    const noteRecipient = (note.address ?? note.recipient ?? note.to ?? '').trim();
    if (noteRecipient !== address.trim()) {
      continue;
    }

    const txid = typeof note.txid === 'string' ? note.txid.trim() : '';
    if (!txid) continue;

    const rawMemoHex = (note.memo_hex ?? note.memo ?? '').trim();
    const decoded = decodeBetMemoJson(rawMemoHex);
    if (!decoded) {
      continue;
    }

    // Ensure the memo's market tag matches the polled marketId (or slug)
    if (decoded.q !== marketId) {
      continue;
    }

    const amountZatoshis =
      typeof note.value === 'number'
        ? Math.round(note.value)
        : typeof note.zatoshis === 'number'
        ? Math.round(note.zatoshis)
        : typeof note.amount === 'number'
        ? Math.round(note.amount * 100_000_000)
        : 0;

    if (amountZatoshis <= 0) {
      continue;
    }

    const result = store.insertShieldedBetIfNew({
      marketId,
      txid,
      poolType,
      recipientAddress: noteRecipient,
      pick: decoded.pick === 'YES' ? OutcomeSide.Yes : OutcomeSide.No,
      payoutTo: decoded.payout_to,
      amountZatoshis,
      rawMemoHex,
      decodedMemoJson: decoded,
      confirmations: typeof note.confirmations === 'number' ? note.confirmations : 0,
    });

    if (result.inserted && result.bet) {
      insertedBets.push(result.bet);
      if (result.market) {
        updatedMarket = result.market;
      }
    } else {
      skippedDuplicateTxids.push(txid);
    }
  }

  return {
    marketId,
    address,
    scannedNotesCount: candidates.length,
    insertedBets,
    skippedDuplicateTxids,
    updatedMarket,
  };
}

// -----------------------------------------------------------------------------
// 3. executeBatchPayout(payoutArray)
// -----------------------------------------------------------------------------

/**
 * Formats a validated payout array into the JSON structure required by
 * `zingo-cli send` (z_sendmany batch payout).
 */
export function formatZingoSendPayload(payoutArray: BatchPayoutItem[]): string {
  if (!Array.isArray(payoutArray) || payoutArray.length === 0) {
    throw new ZingoCliError(
      'payoutArray must be a non-empty array of recipients.',
      'INVALID_INPUT'
    );
  }

  const formatted = payoutArray.map((item, idx) => {
    if (!item || typeof item.address !== 'string' || !isValidZcashAddress(item.address)) {
      throw new ZingoCliError(
        `Invalid recipient Zcash address at payoutArray[${idx}].`,
        'INVALID_INPUT'
      );
    }
    if (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0) {
      throw new ZingoCliError(
        `Invalid positive ZEC amount at payoutArray[${idx}].`,
        'INVALID_INPUT'
      );
    }

    const roundedAmount = Number(item.amount.toFixed(8));
    const entry: { address: string; amount: number; memo?: string } = {
      address: item.address.trim(),
      amount: roundedAmount,
    };

    if (typeof item.memo === 'string' && item.memo.trim().length > 0) {
      const memoBytes = Buffer.byteLength(item.memo.trim(), 'utf8');
      if (memoBytes > 512) {
        throw new ZingoCliError(
          `Memo at payoutArray[${idx}] exceeds Zcash 512-byte limit (${memoBytes} bytes).`,
          'INVALID_INPUT'
        );
      }
      entry.memo = item.memo.trim();
    }

    return entry;
  });

  return JSON.stringify(formatted);
}

/**
 * Executes a batch shielded payout on market resolution using:
 * `zingo-cli send '[{"address": "...", "amount": 0.48}, ...]'`
 */
export async function executeBatchPayout(
  payoutArray: BatchPayoutItem[]
): Promise<BatchPayoutResult> {
  const jsonPayload = formatZingoSendPayload(payoutArray);
  const cmd = `send ${shellQuote(jsonPayload)}`;

  const stdout = await runZingoCommand(cmd);

  const txids: string[] = [];
  try {
    const parsed = extractJsonFromCliOutput<unknown>(stdout);
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.txid === 'string') txids.push(rec.txid);
      if (Array.isArray(rec.txids)) {
        for (const id of rec.txids) {
          if (typeof id === 'string') txids.push(id);
        }
      }
    }
  } catch {
    const matches = stdout.match(/\b[0-9a-fA-F]{64}\b/g);
    if (matches) txids.push(...matches);
  }

  const totalAmountZec = payoutArray.reduce((sum, item) => sum + item.amount, 0);

  return {
    txids,
    rawOutput: stdout,
    recipientCount: payoutArray.length,
    totalAmountZec: Number(totalAmountZec.toFixed(8)),
  };
}

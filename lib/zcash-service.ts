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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminFirestore } from '../src/lib/firebase-admin.ts';
import { store } from '../src/server/store.ts';
import { encodeBase64Url } from '../src/lib/zip321.ts';
import {
  getZcashNetworkFromAddress,
  getZcashTxExplorerUrls,
  isValidOnChainTxid,
  normalizeOnChainTxid,
  ZcashNetwork,
} from '../src/lib/explorers.ts';
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
  misconfiguredBinAsUrl: boolean;
  lightwalletdReachable: boolean;
  lightwalletdLatencyMs: number | null;
  error: string | null;
}

export interface ZingoNodeTelemetry {
  status: ZingoCliStatus;
  nodeAddress: string | null;
  blockHeight: number | null;
  balanceZatoshis: number | null;
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

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function expandHomePrefix(value: string): string {
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  if (value.startsWith('$HOME/')) {
    return path.join(os.homedir(), value.slice(6));
  }
  return value;
}

/**
 * Resolves the configured `zingo-cli` binary and optional `--data-dir` flag.
 */
function getZingoBinary(): string {
  const configured = process.env.ZINGO_CLI_BIN
    ? stripOuterQuotes(process.env.ZINGO_CLI_BIN)
    : '';
  // Guard against lightwalletd server URLs mistakenly placed in ZINGO_CLI_BIN
  if (/^https?:\/\//i.test(configured)) {
    return 'zingo-cli';
  }
  const expanded = configured.length > 0 ? expandHomePrefix(configured) : 'zingo-cli';
  // Guard against shell metacharacters while allowing spaces, colons, dots, slashes, and hyphens
  if (!expanded || /[;&|`$()<>\r\n"']/.test(expanded)) {
    throw new ZingoCliError(
      'Invalid ZINGO_CLI_BIN path characters.',
      'INVALID_INPUT'
    );
  }
  return expanded;
}

function getZingoChain(): 'testnet' | 'regtest' | 'mainnet' {
  const explicitChain = process.env.ZINGO_CHAIN
    ? stripOuterQuotes(process.env.ZINGO_CHAIN).toLowerCase()
    : '';
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
  const legacyFlag = process.env.ZINGO_NETWORK_FLAG
    ? stripOuterQuotes(process.env.ZINGO_NETWORK_FLAG).toLowerCase()
    : '';
  if (legacyFlag === '--regtest' || legacyFlag === 'regtest') return 'regtest';
  if (legacyFlag === '--mainnet' || legacyFlag === 'mainnet') return 'mainnet';
  return 'testnet';
}

function getZingoServerUri(chain: 'testnet' | 'regtest' | 'mainnet'): string | null {
  const fallbackBinUrl = process.env.ZINGO_CLI_BIN
    ? stripOuterQuotes(process.env.ZINGO_CLI_BIN)
    : '';
  const rawUri =
    process.env.ZINGO_SERVER_URI !== undefined
      ? stripOuterQuotes(process.env.ZINGO_SERVER_URI)
      : /^https?:\/\//i.test(fallbackBinUrl)
      ? fallbackBinUrl
      : '';

  if (rawUri.length > 0) {
    if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/[a-zA-Z0-9._/-]*)?$/.test(rawUri)) {
      throw new ZingoCliError(
        'Invalid ZINGO_SERVER_URI format. Expected http(s)://host[:port].',
        'INVALID_INPUT'
      );
    }
    return rawUri;
  }

  return chain === 'testnet' ? 'https://testnet.zec.rocks:443' : null;
}

function resolveDataDir(): string | null {
  const raw = process.env.ZINGO_DATA_DIR
    ? stripOuterQuotes(process.env.ZINGO_DATA_DIR)
    : '';
  if (!raw) return null;
  return expandHomePrefix(raw);
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
  const fullCommand = `${shellQuote(bin)} ${globalFlags} ${commandArgs}`.trim();

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

async function probeLightwalletdServer(
  serverUri: string | null
): Promise<{ reachable: boolean; latencyMs: number | null }> {
  if (!serverUri) return { reachable: false, latencyMs: null };
  const startedAt = Date.now();
  try {
    await fetch(serverUri, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2_500),
    });
    return { reachable: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { reachable: false, latencyMs: null };
  }
}

/**
 * Checks whether `zingo-cli` is reachable on the host and returns sanitized
 * `.env` configuration details for the Zingo Setup diagnostic check.
 */
export async function checkZingoCliStatus(): Promise<ZingoCliStatus> {
  const rawEnvBin = process.env.ZINGO_CLI_BIN
    ? stripOuterQuotes(process.env.ZINGO_CLI_BIN)
    : '';
  const misconfiguredBinAsUrl = /^https?:\/\//i.test(rawEnvBin);

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
    const lwd = await probeLightwalletdServer(serverUri);
    return {
      available: false,
      version: null,
      binary,
      chain,
      serverUri,
      dataDir,
      dataDirExists: null,
      misconfiguredBinAsUrl,
      lightwalletdReachable: lwd.reachable,
      lightwalletdLatencyMs: lwd.latencyMs,
      error: error instanceof Error ? error.message : 'Invalid ZINGO_* environment configuration.',
    };
  }

  const dataDirExists = dataDir ? fs.existsSync(dataDir) : null;
  const lwdPromise = probeLightwalletdServer(serverUri);

  try {
    const [{ stdout }, lwd] = await Promise.all([
      execAsync(`${shellQuote(binary)} --version`, {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      }),
      lwdPromise,
    ]);
    const version = stdout.trim() || 'installed';
    return {
      available: true,
      version,
      binary,
      chain,
      serverUri,
      dataDir,
      dataDirExists,
      misconfiguredBinAsUrl,
      lightwalletdReachable: lwd.reachable,
      lightwalletdLatencyMs: lwd.latencyMs,
      error: null,
    };
  } catch (error: unknown) {
    const lwd = await lwdPromise;
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
      misconfiguredBinAsUrl,
      lightwalletdReachable: lwd.reachable,
      lightwalletdLatencyMs: lwd.latencyMs,
      error:
        err?.code === 'ENOENT' || detail.includes('not found')
          ? misconfiguredBinAsUrl
            ? `ZINGO_CLI_BIN is currently set to URL "${rawEnvBin}". Move that URL to ZINGO_SERVER_URI and set ZINGO_CLI_BIN to your binary path (e.g. /usr/local/bin/zingo-cli), or use Self-Custodial Testnet mode.`
            : `Binary "${binary}" was not found on this host. Use Self-Custodial Zashi / Zingo Testnet mode or install zingo-cli on your VPS.`
          : detail,
    };
  }
}

/**
 * Returns live Zingo Testnet Node telemetry (lightwalletd reachability plus active
 * zingo-cli wallet address, synced block height, and shielded balance when present).
 */
export async function getZingoNodeTelemetry(): Promise<ZingoNodeTelemetry> {
  const status = await checkZingoCliStatus();
  if (!status.available) {
    return {
      status,
      nodeAddress: null,
      blockHeight: null,
      balanceZatoshis: null,
    };
  }

  let nodeAddress: string | null = null;
  let blockHeight: number | null = null;
  let balanceZatoshis: number | null = null;

  try {
    const addrStdout = await runZingoCommand('addresses');
    const addrParsed = extractJsonFromCliOutput<unknown>(addrStdout);
    nodeAddress = findAddressInPayload(addrParsed, addrStdout);
  } catch {
    // Non-fatal
  }

  try {
    const balStdout = await runZingoCommand('balance');
    const balParsed = extractJsonFromCliOutput<Record<string, unknown>>(balStdout);
    if (typeof balParsed.total_orchard_balance === 'number') {
      balanceZatoshis =
        balParsed.total_orchard_balance +
        (typeof balParsed.total_sapling_balance === 'number'
          ? balParsed.total_sapling_balance
          : 0);
    } else if (typeof balParsed.orchard_balance === 'number') {
      balanceZatoshis = balParsed.orchard_balance;
    }
  } catch {
    // Non-fatal
  }

  try {
    const heightStdout = await runZingoCommand('height');
    const heightParsed = extractJsonFromCliOutput<Record<string, unknown>>(heightStdout);
    if (typeof heightParsed.height === 'number') {
      blockHeight = heightParsed.height;
    }
  } catch {
    // Non-fatal
  }

  return {
    status,
    nodeAddress,
    blockHeight,
    balanceZatoshis,
  };
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

// -----------------------------------------------------------------------------
// 4. verifyOnChainTransaction(txid, networkHint)
// -----------------------------------------------------------------------------

export interface OnChainTxVerificationResult {
  validFormat: boolean;
  txid: string;
  network: ZcashNetwork;
  explorerUrl: string;
  secondaryExplorerUrl: string;
  onChainFound: boolean;
  confirmations: number | null;
  blockHeight: number | null;
  source: 'zingo-cli' | 'explorer' | 'local-store' | 'format-only';
  message: string;
}

export async function verifyOnChainTransaction(
  rawTxid: string,
  addressOrNetwork?: string | null
): Promise<OnChainTxVerificationResult> {
  const cleanTxid = normalizeOnChainTxid(rawTxid);
  const links = getZcashTxExplorerUrls(cleanTxid, addressOrNetwork);

  if (!isValidOnChainTxid(rawTxid)) {
    return {
      validFormat: false,
      txid: cleanTxid,
      network: links.network,
      explorerUrl: links.primaryUrl,
      secondaryExplorerUrl: links.secondaryUrl,
      onChainFound: false,
      confirmations: null,
      blockHeight: null,
      source: 'format-only',
      message: 'Transaction ID must be a 64-character hex string.',
    };
  }

  // 1. Check attached zingo-cli wallet if present on host
  try {
    const cliStatus = await checkZingoCliStatus();
    if (cliStatus.available) {
      try {
        const listStdout = await runZingoCommand('listtransactions');
        const listParsed = extractJsonFromCliOutput<unknown>(listStdout);
        const rows = Array.isArray(listParsed)
          ? listParsed
          : listParsed && typeof listParsed === 'object' && Array.isArray((listParsed as Record<string, unknown>).transactions)
          ? ((listParsed as Record<string, unknown>).transactions as unknown[])
          : [];
        const matched = rows.find((item) => {
          if (!item || typeof item !== 'object') return false;
          const rec = item as Record<string, unknown>;
          return typeof rec.txid === 'string' && normalizeOnChainTxid(rec.txid) === cleanTxid;
        }) as Record<string, unknown> | undefined;

        if (matched) {
          const confirmations =
            typeof matched.confirmations === 'number' ? matched.confirmations : 1;
          const blockHeight =
            typeof matched.block_height === 'number'
              ? matched.block_height
              : typeof matched.blockheight === 'number'
              ? matched.blockheight
              : null;
          return {
            validFormat: true,
            txid: cleanTxid,
            network: links.network,
            explorerUrl: links.primaryUrl,
            secondaryExplorerUrl: links.secondaryUrl,
            onChainFound: true,
            confirmations,
            blockHeight,
            source: 'zingo-cli',
            message: `Verified on-chain via zingo-cli (${confirmations} confirmation${confirmations === 1 ? '' : 's'}).`,
          };
        }
      } catch {
        // Fallback to explorer & local registry below
      }
    }
  } catch {
    // Ignore binary probe failure
  }

  // 2. Query public Zcash Testnet/Mainnet explorer API with a short non-blocking timeout
  const explorerApiUrl =
    links.network === 'testnet'
      ? `https://testnet.zcashblockexplorer.com/api/v1/transactions/${cleanTxid}`
      : `https://api.blockchair.com/zcash/dashboards/transaction/${cleanTxid}`;

  try {
    const response = await fetch(explorerApiUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      const payload = (await response.json()) as Record<string, unknown>;
      const confirmations =
        typeof payload.confirmations === 'number' ? payload.confirmations : 1;
      const blockHeight =
        typeof payload.blockHeight === 'number'
          ? payload.blockHeight
          : typeof payload.height === 'number'
          ? payload.height
          : null;
      return {
        validFormat: true,
        txid: cleanTxid,
        network: links.network,
        explorerUrl: links.primaryUrl,
        secondaryExplorerUrl: links.secondaryUrl,
        onChainFound: true,
        confirmations,
        blockHeight,
        source: 'explorer',
        message: `Verified on Zcash ${links.network} explorer (${confirmations} confirmation${confirmations === 1 ? '' : 's'}).`,
      };
    }
  } catch {
    // Explorer APIs often rate-limit or block automated requests; keep flow non-blocking
  }

  // 3. Check if already recorded in local Zolymarket store
  const existingBet = store
    .listShieldedBets()
    .find((b) => normalizeOnChainTxid(b.txid) === cleanTxid);
  if (existingBet) {
    return {
      validFormat: true,
      txid: cleanTxid,
      network: links.network,
      explorerUrl: links.primaryUrl,
      secondaryExplorerUrl: links.secondaryUrl,
      onChainFound: true,
      confirmations: existingBet.confirmations,
      blockHeight: null,
      source: 'local-store',
      message: `Recorded in Zolymarket ledger (${existingBet.confirmations} confirmation${existingBet.confirmations === 1 ? '' : 's'}). Open explorer link to inspect on-chain.`,
    };
  }

  return {
    validFormat: true,
    txid: cleanTxid,
    network: links.network,
    explorerUrl: links.primaryUrl,
    secondaryExplorerUrl: links.secondaryUrl,
    onChainFound: false,
    confirmations: null,
    blockHeight: null,
    source: 'format-only',
    message: `Valid 64-hex Zcash ${links.network} txid format. Use the explorer links to verify inclusion on Zingo Testnet.`,
  };
}

// -----------------------------------------------------------------------------
// 5. Zcash ("Zk-Cash") Protocol Challenge-Response Sign-In & UFVK Binding
// -----------------------------------------------------------------------------

interface StoredAuthChallenge {
  challengeId: string;
  nonce: string;
  address: string;
  recipientAddress: string;
  network: ZcashNetwork;
  memoJson: string;
  expiresAtMs: number;
}

const AUTH_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const authChallenges = new Map<string, StoredAuthChallenge>();
const UFVK_REGEX = /^(uview1|uviewtest1|uviewregtest1)[0-9a-zA-Z]{30,350}$/;

export interface ZcashAuthChallengeResult {
  challengeId: string;
  nonce: string;
  address: string;
  recipientAddress: string;
  network: ZcashNetwork;
  memoJson: string;
  zip321Uri: string;
  amountZec: number;
  expiresAt: string;
  nodeAttached: boolean;
}

export interface ZcashAuthVerifyResult {
  verified: boolean;
  verifiedOnChain: boolean;
  address: string;
  network: ZcashNetwork;
  txid: string | null;
  ufvkFingerprint: string | null;
  explorerUrl: string | null;
  secondaryExplorerUrl: string | null;
  source: 'zingo-cli' | 'explorer' | 'ufvk' | 'tx-format' | 'address-only';
  message: string;
}

export async function createZcashAuthChallenge(
  rawAddress: string
): Promise<ZcashAuthChallengeResult> {
  const address = rawAddress.trim();
  if (!isValidZcashAddress(address) || address.length < 20) {
    throw new ZingoCliError(
      'A valid Zcash Unified (utest1.../u1...) or Sapling (zs1...) address is required for challenge sign-in.',
      'INVALID_INPUT'
    );
  }

  // Prune expired challenges
  const nowMs = Date.now();
  for (const [id, entry] of authChallenges.entries()) {
    if (entry.expiresAtMs < nowMs) authChallenges.delete(id);
  }

  const telemetry = await getZingoNodeTelemetry();
  const recipientAddress =
    telemetry.nodeAddress && isValidZcashAddress(telemetry.nodeAddress)
      ? telemetry.nodeAddress
      : address;

  const challengeId = `zauth_${crypto.randomBytes(8).toString('hex')}`;
  const nonce = crypto.randomBytes(6).toString('hex');
  const network = getZcashNetworkFromAddress(address);
  const memoObj = {
    v: 1,
    act: 'signin',
    nonce,
    addr: address.slice(0, 28),
  };
  const memoJson = JSON.stringify(memoObj);
  const memoB64 = encodeBase64Url(memoJson);
  const amountZec = 0.0001;
  const zip321Uri = `zcash:${recipientAddress}?amount=${amountZec}&memo=${memoB64}`;
  const expiresAtMs = nowMs + AUTH_CHALLENGE_TTL_MS;

  authChallenges.set(challengeId, {
    challengeId,
    nonce,
    address,
    recipientAddress,
    network,
    memoJson,
    expiresAtMs,
  });

  return {
    challengeId,
    nonce,
    address,
    recipientAddress,
    network,
    memoJson,
    zip321Uri,
    amountZec,
    expiresAt: new Date(expiresAtMs).toISOString(),
    nodeAttached: telemetry.status.available,
  };
}

export async function verifyZcashAuthProof(input: {
  address: string;
  challengeId?: string;
  txid?: string;
  ufvk?: string;
}): Promise<ZcashAuthVerifyResult> {
  const address = input.address.trim();
  if (!isValidZcashAddress(address) || address.length < 20) {
    throw new ZingoCliError(
      'Enter a valid Zcash shielded address (utest1..., u1..., or zs1...).',
      'INVALID_INPUT'
    );
  }

  const network = getZcashNetworkFromAddress(address);
  const challenge = input.challengeId ? authChallenges.get(input.challengeId.trim()) : undefined;

  if (challenge && challenge.address !== address) {
    throw new ZingoCliError(
      'Sign-in address does not match the issued Zcash authentication challenge.',
      'INVALID_INPUT'
    );
  }

  let ufvkFingerprint: string | null = null;
  if (input.ufvk && input.ufvk.trim().length > 0) {
    const cleanUfvk = input.ufvk.trim();
    if (!UFVK_REGEX.test(cleanUfvk)) {
      throw new ZingoCliError(
        'Invalid Unified Full Viewing Key format. Expected uviewtest1... or uview1...',
        'INVALID_INPUT'
      );
    }
    ufvkFingerprint = crypto.createHash('sha256').update(cleanUfvk).digest('hex').slice(0, 16);
  }

  // Optional 1: Verify supplied transaction ID
  if (input.txid && input.txid.trim().length > 0) {
    const txCheck = await verifyOnChainTransaction(input.txid, address);
    if (!txCheck.validFormat) {
      throw new ZingoCliError(txCheck.message, 'INVALID_INPUT');
    }

    if (challenge) authChallenges.delete(challenge.challengeId);
    return {
      verified: true,
      verifiedOnChain: txCheck.onChainFound,
      address,
      network,
      txid: txCheck.txid,
      ufvkFingerprint,
      explorerUrl: txCheck.explorerUrl,
      secondaryExplorerUrl: txCheck.secondaryExplorerUrl,
      source: txCheck.onChainFound ? (txCheck.source === 'zingo-cli' ? 'zingo-cli' : 'explorer') : 'tx-format',
      message: txCheck.onChainFound
        ? `Zcash protocol sign-in verified on ${network} (${txCheck.confirmations ?? 1} conf).`
        : `Challenge proof attached (${txCheck.txid.slice(0, 10)}...). Verify inclusion via the Testnet Explorer link.`,
    };
  }

  // Optional 2: Scan attached zingo-cli node notes for matching signin nonce memo
  if (challenge) {
    const status = await checkZingoCliStatus();
    if (status.available) {
      try {
        const notesStdout = await runZingoCommand('notes');
        const notesPayload = extractJsonFromCliOutput<ZingoNotesResponse>(notesStdout);
        const notes = [
          ...(notesPayload.unspent_orchard_notes ?? []),
          ...(notesPayload.pending_orchard_notes ?? []),
          ...(notesPayload.unspent_sapling_notes ?? []),
          ...(notesPayload.pending_sapling_notes ?? []),
        ];
        for (const note of notes) {
          const rawMemo = (note.memo_hex ?? note.memo ?? '').trim();
          if (!rawMemo) continue;
          try {
            const utf8 = decodeHexMemoToUtf8(rawMemo);
            const parsed = JSON.parse(utf8) as { act?: string; nonce?: string };
            if (parsed.act === 'signin' && parsed.nonce === challenge.nonce && note.txid) {
              const cleanTxid = normalizeOnChainTxid(note.txid);
              const links = getZcashTxExplorerUrls(cleanTxid, address);
              authChallenges.delete(challenge.challengeId);
              return {
                verified: true,
                verifiedOnChain: true,
                address,
                network,
                txid: cleanTxid,
                ufvkFingerprint,
                explorerUrl: links.primaryUrl,
                secondaryExplorerUrl: links.secondaryUrl,
                source: 'zingo-cli',
                message: `Verified challenge nonce via live zingo-cli Testnet node (${cleanTxid.slice(0, 10)}...).`,
              };
            }
          } catch {
            // Skip non-auth memos
          }
        }
      } catch {
        // Fallback below
      }
    }
  }

  if (ufvkFingerprint) {
    if (challenge) authChallenges.delete(challenge.challengeId);
    return {
      verified: true,
      verifiedOnChain: false,
      address,
      network,
      txid: null,
      ufvkFingerprint,
      explorerUrl: null,
      secondaryExplorerUrl: null,
      source: 'ufvk',
      message: `Signed in with read-only viewing key fingerprint (${ufvkFingerprint}).`,
    };
  }

  if (challenge) {
    throw new ZingoCliError(
      'Paste the broadcasted Zcash auth txid from Zingo/Zashi or bind a read-only UFVK to complete challenge verification.',
      'INVALID_INPUT'
    );
  }

  return {
    verified: true,
    verifiedOnChain: false,
    address,
    network,
    txid: null,
    ufvkFingerprint: null,
    explorerUrl: null,
    secondaryExplorerUrl: null,
    source: 'address-only',
    message: `Signed in with Zcash ${network} shielded address.`,
  };
}

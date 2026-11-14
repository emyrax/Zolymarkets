/**
 * Zolymarket — Phase 4 Creator Dashboard (/host)
 *
 * Uses React `useState` and Cloud Firestore to host binary Zcash prediction
 * markets, display the Market ID & QR join link, lock betting, and resolve
 * outcomes via a YES/NO modal.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Lock,
  Plus,
  QrCode,
  ShieldCheck,
  Trophy,
  X,
} from 'lucide-react';
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext.tsx';
import { usePollar } from '@pollar/react';
import { OperationType, db, handleFirestoreError } from '../lib/firebase.ts';
import { estimateSharesOut, formatZec, zatoshisToZec, zecToZatoshis } from '../lib/cpmm.ts';
import {
  computeMarketBatchPayouts,
  decodeZashiMemoInput,
  utf8ToHex,
} from '../lib/zip321.ts';
import {
  buildMarketAnchorZip321Uri,
  formatShortTxid,
  generateSampleTestnetUnifiedAddress,
  getZcashTxExplorerUrls,
  isValidOnChainTxid,
  normalizeOnChainTxid,
} from '../lib/explorers.ts';
import { TopCreatorsLeaderboard } from './TopCreatorsLeaderboard.tsx';
import {
  Creator,
  MarketCategory,
  MarketStatus,
  MarketWithDetails,
  OutcomeSide,
  ShieldedBet,
} from '../types/database.ts';

interface HostDashboardProps {
  markets: MarketWithDetails[];
  creators: Creator[];
  onOpenMarketModal?: (market: MarketWithDetails) => void;
  onOpenRoom?: (marketId: string) => void;
  onRefresh?: () => Promise<void>;
}

type DurationUnit = 'seconds' | 'minutes' | 'hours' | 'days';

const UNIT_MULTIPLIER_SECONDS: Record<DurationUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

const DURATION_OPTIONS: { label: string; value: number; unit: DurationUnit; totalSeconds: number }[] = [
  { label: '5 Secs', value: 5, unit: 'seconds', totalSeconds: 5 },
  { label: '30 Secs', value: 30, unit: 'seconds', totalSeconds: 30 },
  { label: '1 Min', value: 1, unit: 'minutes', totalSeconds: 60 },
  { label: '5 Mins', value: 5, unit: 'minutes', totalSeconds: 300 },
  { label: '1 Hour', value: 1, unit: 'hours', totalSeconds: 3600 },
  { label: '24 Hours', value: 24, unit: 'hours', totalSeconds: 86400 },
  { label: '7 Days', value: 7, unit: 'days', totalSeconds: 604800 },
];

const CATEGORIES: MarketCategory[] = [
  MarketCategory.CreatorBets,
  MarketCategory.ZcashProtocol,
  MarketCategory.Ecosystem,
  MarketCategory.PrivacyCrypto,
  MarketCategory.Governance,
];

const ZCASH_ADDRESS_REGEX = /^(u1|uregtest1|utest1|zs1)[0-9a-zA-Z]{16,252}$/;
const HEX_TXID_REGEX = /^[0-9a-fA-F]{16,128}$/;
const UFVK_STORAGE_PREFIX = 'zolymarket_host_ufvk_v1_';

function toIsoString(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string') {
    return val;
  }
  return new Date().toISOString();
}

function generateSampleHexTxid(): string {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function slugifyQuestion(question: string, suffix: string): string {
  const base = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const cleanBase = base.length >= 3 ? base : 'zcash-market';
  return `${cleanBase}-${suffix}`.slice(0, 128);
}

function sanitizeHandle(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (cleaned.length >= 2) return cleaned.slice(0, 40);
  return 'host_creator';
}

function buildFallbackPoolAddress(marketId: string, prefix: 'u1' | 'utest1'): string {
  const seed = marketId.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pad = 'qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l';
  return `${prefix}pool${seed}${pad}`.slice(0, 74);
}

export const HostDashboard: React.FC<HostDashboardProps> = ({
  markets,
  creators,
  onOpenMarketModal,
  onOpenRoom,
  onRefresh,
}) => {
  const { user, walletSession, openAuthModal, signInWithGoogle } = useAuth();
  const { isAuthenticated: pollarAuthed, wallet: pollarWallet } = usePollar();

  const hasAnyIdentity = Boolean(user || walletSession || pollarAuthed);

  // Create Screen state
  const [question, setQuestion] = useState<string>('');
  const [durationValue, setDurationValue] = useState<number>(24);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('hours');
  const [payoutAddress, setPayoutAddress] = useState<string>(() =>
    walletSession?.rail === 'zcash' ? walletSession.address : ''
  );
  const [poolAddressMode, setPoolAddressMode] = useState<'zashi' | 'zingo'>('zashi');
  const [customPoolAddress, setCustomPoolAddress] = useState<string>('');
  const [createUfvk, setCreateUfvk] = useState<string>('');
  const [createAnchorTxid, setCreateAnchorTxid] = useState<string>('');
  const [category, setCategory] = useState<MarketCategory>(MarketCategory.CreatorBets);
  const [creating, setCreating] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Active Screen state
  const [activeMarketId, setActiveMarketId] = useState<string | null>(null);
  const [localActiveSnapshot, setLocalActiveSnapshot] = useState<MarketWithDetails | null>(null);
  const [walletProvisionSource, setWalletProvisionSource] = useState<'zashi' | 'zingo-cli' | 'preview' | null>(null);

  // On-Chain Market Creation Anchor state
  const [anchorTxInput, setAnchorTxInput] = useState<string>('');
  const [anchoringMarket, setAnchoringMarket] = useState<boolean>(false);

  // Self-Custodial Hybrid Bet Verification state (No VPS)
  const [marketBets, setMarketBets] = useState<ShieldedBet[]>([]);
  const [rawZashiMemoInput, setRawZashiMemoInput] = useState<string>('');
  const [memoDecodeNote, setMemoDecodeNote] = useState<string | null>(null);
  const [verifyTxid, setVerifyTxid] = useState<string>('');
  const [verifyPick, setVerifyPick] = useState<OutcomeSide>(OutcomeSide.Yes);
  const [verifyAmountInput, setVerifyAmountInput] = useState<string>('0.5');
  const [verifyPayoutTo, setVerifyPayoutTo] = useState<string>('');
  const [verifyingBet, setVerifyingBet] = useState<boolean>(false);
  const [activeUfvk, setActiveUfvk] = useState<string>('');

  // Action & modal states
  const [locking, setLocking] = useState<boolean>(false);
  const [resolving, setResolving] = useState<boolean>(false);
  const [resolveModalOpen, setResolveModalOpen] = useState<boolean>(false);
  const [selectedWinner, setSelectedWinner] = useState<OutcomeSide>(OutcomeSide.Yes);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Resolve live market record from Firestore snapshot when available
  const activeMarket = useMemo(() => {
    if (!activeMarketId) return null;
    return (
      markets.find((m) => m.id === activeMarketId) ??
      (localActiveSnapshot?.id === activeMarketId ? localActiveSnapshot : null)
    );
  }, [activeMarketId, markets, localActiveSnapshot]);

  // Existing markets owned by the signed-in creator (Google, Zcash, or Pollar)
  const myHostedMarkets = useMemo(() => {
    const zcashAddr = walletSession?.rail === 'zcash' ? walletSession.address.toLowerCase() : null;
    if (!user && !zcashAddr) return [];
    return markets.filter(
      (m) =>
        (user &&
          (m.ownerUid === user.uid || m.creatorId === `creator_${user.uid.slice(0, 24)}`)) ||
        (zcashAddr &&
          (m.creator.zcashUnifiedAddress.toLowerCase() === zcashAddr ||
            m.shieldedPoolAddress.toLowerCase() === zcashAddr))
    );
  }, [markets, user, walletSession]);

  const existingUserCreator = useMemo(() => {
    if (user) {
      const expectedId = `creator_${user.uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`;
      const found = creators.find((c) => c.id === expectedId);
      if (found) return found;
    }
    if (walletSession?.rail === 'zcash') {
      return (
        creators.find(
          (c) => c.zcashUnifiedAddress.toLowerCase() === walletSession.address.toLowerCase()
        ) ?? null
      );
    }
    return null;
  }, [creators, user, walletSession]);

  useEffect(() => {
    if (walletSession?.rail === 'zcash' && !payoutAddress.trim()) {
      setPayoutAddress(walletSession.address);
    }
  }, [walletSession, payoutAddress]);

  // Subscribe to real-time `shielded_bets` for activeMarket + load browser-only UFVK
  useEffect(() => {
    if (!activeMarket?.id) {
      setMarketBets([]);
      setActiveUfvk('');
      return;
    }

    try {
      setActiveUfvk(localStorage.getItem(`${UFVK_STORAGE_PREFIX}${activeMarket.id}`) || '');
    } catch {
      setActiveUfvk('');
    }

    let active = true;
    fetch(`/api/markets/${encodeURIComponent(activeMarket.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { bets?: ShieldedBet[] } | null) => {
        if (active && data?.bets && data.bets.length > 0) {
          setMarketBets((prev) => (prev.length === 0 ? data.bets! : prev));
        }
      })
      .catch(() => {
        // Ignore API fallback error
      });

    const betsQuery = query(
      collection(db, 'shielded_bets'),
      where('marketId', '==', activeMarket.id)
    );

    const unsubBets = onSnapshot(
      betsQuery,
      (snapshot) => {
        if (!active) return;
        const rows: ShieldedBet[] = snapshot.docs.map((docSnap) => {
          const d = docSnap.data();
          const pick = d.pick === OutcomeSide.No ? OutcomeSide.No : OutcomeSide.Yes;
          return {
            id: String(d.id || docSnap.id),
            marketId: String(d.marketId || activeMarket.id),
            txid: String(d.txid || ''),
            poolType: d.poolType === 'sapling' ? 'sapling' : 'orchard',
            recipientAddress: String(d.recipientAddress || ''),
            pick,
            payoutTo: String(d.payoutTo || ''),
            amountZatoshis: Number(d.amountZatoshis || 0),
            rawMemoHex: String(d.rawMemoHex || ''),
            decodedMemoJson: (d.decodedMemo as ShieldedBet['decodedMemoJson']) ?? {
              q: activeMarket.id,
              pick,
              payout_to: String(d.payoutTo || ''),
            },
            confirmations: Number(d.confirmations || 0),
            createdAt: toIsoString(d.createdAt),
          };
        });
        rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setMarketBets((prev) => {
          if (rows.length === 0) return prev;
          const seen = new Set(rows.map((r) => r.txid.toLowerCase()));
          const extraLocal = prev.filter((p) => !seen.has(p.txid.toLowerCase()));
          return [...rows, ...extraLocal].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        });
      },
      (err) => {
        if (!active) return;
        try {
          handleFirestoreError(err, OperationType.LIST, 'shielded_bets');
        } catch {
          // Non-fatal fallback
        }
      }
    );

    return () => {
      active = false;
      unsubBets();
    };
  }, [activeMarket?.id]);

  // Persist optional read-only UFVK strictly inside browser localStorage (never sent to server)
  const handleSaveLocalUfvk = (val: string) => {
    setActiveUfvk(val);
    if (!activeMarket?.id) return;
    try {
      if (val.trim()) {
        localStorage.setItem(`${UFVK_STORAGE_PREFIX}${activeMarket.id}`, val.trim());
      } else {
        localStorage.removeItem(`${UFVK_STORAGE_PREFIX}${activeMarket.id}`);
      }
    } catch {
      // Ignore storage quota errors
    }
  };

  // Compute ZIP-321 multi-recipient batch payout split for modal preview & resolved console
  const resolvedBatchPayout = useMemo(() => {
    if (!activeMarket || activeMarket.status !== MarketStatus.Resolved || !activeMarket.winningOutcome) {
      return null;
    }
    return computeMarketBatchPayouts({
      marketId: activeMarket.id,
      creatorAddress: activeMarket.creator.zcashUnifiedAddress || activeMarket.shieldedPoolAddress,
      creatorFeeBps: activeMarket.creatorFeeBps,
      winningOutcome: activeMarket.winningOutcome,
      bets: marketBets,
    });
  }, [activeMarket, marketBets]);

  const modalPreviewBatchPayout = useMemo(() => {
    if (!activeMarket) return null;
    return computeMarketBatchPayouts({
      marketId: activeMarket.id,
      creatorAddress: activeMarket.creator.zcashUnifiedAddress || activeMarket.shieldedPoolAddress,
      creatorFeeBps: activeMarket.creatorFeeBps,
      winningOutcome: selectedWinner,
      bets: marketBets,
    });
  }, [activeMarket, selectedWinner, marketBets]);

  const totalDurationSeconds = useMemo(() => {
    const safeVal = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : 0;
    return Math.round(safeVal * UNIT_MULTIPLIER_SECONDS[durationUnit]);
  }, [durationValue, durationUnit]);

  const previewClosesAt = useMemo(() => {
    const clampedSeconds = totalDurationSeconds >= 5 ? totalDurationSeconds : 5;
    return new Date(Date.now() + clampedSeconds * 1000);
  }, [totalDurationSeconds]);

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleFillSampleAddress = () => {
    if (walletSession?.rail === 'zcash') {
      setPayoutAddress(walletSession.address);
      return;
    }
    if (existingUserCreator?.zcashUnifiedAddress) {
      setPayoutAddress(existingUserCreator.zcashUnifiedAddress);
      return;
    }
    setPayoutAddress(generateSampleTestnetUnifiedAddress('host'));
  };

  const creationAnchorUri = useMemo(() => {
    if (!activeMarket) return null;
    try {
      return buildMarketAnchorZip321Uri({
        marketId: activeMarket.id,
        poolAddress: activeMarket.shieldedPoolAddress,
        creatorAddress: activeMarket.creator.zcashUnifiedAddress,
        question: activeMarket.question,
      });
    } catch {
      return null;
    }
  }, [activeMarket]);

  const handleAnchorMarketCreation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeMarket) return;
    setActionError(null);
    setActionSuccess(null);

    if (!isValidOnChainTxid(anchorTxInput)) {
      setActionError('Enter a valid 64-character hex Zcash Transaction ID (txid) to anchor this market.');
      return;
    }

    const cleanTxid = normalizeOnChainTxid(anchorTxInput);
    setAnchoringMarket(true);
    try {
      const res = await fetch(`/api/markets/${encodeURIComponent(activeMarket.id)}/anchor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txid: cleanTxid }),
      });
      const json = (await res.json()) as {
        market?: MarketWithDetails;
        verification?: { message?: string };
        error?: string;
      };
      if (!res.ok) {
        throw new Error(json.error || 'Unable to anchor market creation transaction.');
      }

      setLocalActiveSnapshot((prev) =>
        prev && prev.id === activeMarket.id
          ? { ...prev, creationTxid: cleanTxid }
          : json.market ?? prev
      );
      setAnchorTxInput('');
      void onRefresh?.();
      setActionSuccess(
        `Market creation anchored on-chain (${formatShortTxid(cleanTxid)}). ${json.verification?.message || ''}`
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to anchor market transaction.');
    } finally {
      setAnchoringMarket(false);
    }
  };

  const handleDecodeZashiMemo = (raw: string) => {
    setRawZashiMemoInput(raw);
    setMemoDecodeNote(null);
    if (!raw.trim()) return;

    const decoded = decodeZashiMemoInput(raw);
    if (!decoded) {
      setMemoDecodeNote('Could not parse JSON, Base64URL, hex, or ZIP-321 memo format.');
      return;
    }

    if (decoded.pick) setVerifyPick(decoded.pick);
    if (decoded.payoutTo) setVerifyPayoutTo(decoded.payoutTo);
    if (decoded.amountZec && decoded.amountZec > 0) {
      setVerifyAmountInput(String(decoded.amountZec));
    }

    if (decoded.marketId && activeMarket && decoded.marketId !== activeMarket.id) {
      setMemoDecodeNote(
        `Decoded memo targets market "${decoded.marketId}" (active market is "${activeMarket.id}"). Verify before recording.`
      );
    } else {
      setMemoDecodeNote(
        `Decoded memo: ${decoded.pick ?? 'unknown side'} -> payout to ${decoded.payoutTo ? `${decoded.payoutTo.slice(0, 14)}...` : 'missing address'}.`
      );
    }
  };

  const handleVerifyZashiBet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeMarket || !hasAnyIdentity) return;

    setActionError(null);
    setActionSuccess(null);

    const cleanTxid = verifyTxid.trim().replace(/^0x/i, '');
    const cleanPayoutTo = verifyPayoutTo.trim();
    const parsedAmt = Number.parseFloat(verifyAmountInput);

    if (!HEX_TXID_REGEX.test(cleanTxid)) {
      setActionError('Enter a valid hex Zcash Transaction ID (16–128 hex characters).');
      return;
    }
    if (!Number.isFinite(parsedAmt) || parsedAmt <= 0) {
      setActionError('Enter a positive ZEC bet amount.');
      return;
    }
    if (!ZCASH_ADDRESS_REGEX.test(cleanPayoutTo)) {
      setActionError('Enter the player\'s valid shielded return address (u1..., utest1..., or zs1...).');
      return;
    }
    if (marketBets.some((b) => b.txid.toLowerCase() === cleanTxid.toLowerCase())) {
      setActionError('This txid is already recorded in shielded_bets for this market.');
      return;
    }

    const amountZatoshis = zecToZatoshis(parsedAmt);
    if (amountZatoshis <= 0) {
      setActionError('Amount must be at least 1 zatoshi (0.00000001 ZEC).');
      return;
    }

    setVerifyingBet(true);
    try {
      // Optional on-chain transaction lookup (non-blocking if tx is newly broadcasted)
      let onChainMsg = '';
      if (isValidOnChainTxid(cleanTxid)) {
        try {
          const verifyRes = await fetch('/api/zcash/tx/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              txid: cleanTxid,
              address: activeMarket.shieldedPoolAddress,
            }),
          });
          if (verifyRes.ok) {
            const verifyJson = (await verifyRes.json()) as { message?: string };
            if (verifyJson.message) onChainMsg = ` ${verifyJson.message}`;
          }
        } catch {
          // Non-blocking fallback
        }
      }

      const betId = `bet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const yesPool = Math.max(1, activeMarket.outcomes.yes.poolZatoshis);
      const noPool = Math.max(1, activeMarket.outcomes.no.poolZatoshis);
      const isYes = verifyPick === OutcomeSide.Yes;
      const targetPool = isYes ? yesPool : noPool;
      const oppositePool = isYes ? noPool : yesPool;

      const quote = estimateSharesOut({
        amountZatoshis,
        targetPoolZatoshis: targetPool,
        oppositePoolZatoshis: oppositePool,
        creatorFeeBps: activeMarket.creatorFeeBps,
      });

      const k = targetPool * oppositePool;
      const nextOppositePool = oppositePool + quote.netDepositZatoshis;
      const nextTargetPool = Math.max(1, Math.round(k / nextOppositePool));

      const nextYesPool = isYes ? nextTargetPool : nextOppositePool;
      const nextNoPool = isYes ? nextOppositePool : nextTargetPool;
      const nextYesShares = isYes
        ? Math.round((activeMarket.outcomes.yes.sharesOutstanding + quote.sharesOut) * 10_000) / 10_000
        : activeMarket.outcomes.yes.sharesOutstanding;
      const nextNoShares = !isYes
        ? Math.round((activeMarket.outcomes.no.sharesOutstanding + quote.sharesOut) * 10_000) / 10_000
        : activeMarket.outcomes.no.sharesOutstanding;

      const memoObj = {
        q: activeMarket.id,
        pick: verifyPick,
        payout_to: cleanPayoutTo,
      };
      const rawMemoHex = utf8ToHex(JSON.stringify(memoObj)).slice(0, 1024);

      if (user) {
        const batch = writeBatch(db);
        const betRef = doc(db, 'shielded_bets', betId);
        const marketRef = doc(db, 'markets', activeMarket.id);

        batch.set(betRef, {
          id: betId,
          marketId: activeMarket.id,
          txid: cleanTxid,
          poolType: 'orchard',
          recipientAddress: activeMarket.shieldedPoolAddress,
          pick: verifyPick,
          payoutTo: cleanPayoutTo,
          amountZatoshis,
          rawMemoHex,
          decodedMemo: memoObj,
          confirmations: 1,
          createdAt: serverTimestamp(),
        });

        batch.update(marketRef, {
          yesPoolZatoshis: nextYesPool,
          noPoolZatoshis: nextNoPool,
          yesSharesOutstanding: nextYesShares,
          noSharesOutstanding: nextNoShares,
          totalVolumeZatoshis: activeMarket.totalVolumeZatoshis + amountZatoshis,
          liquidityZatoshis: nextYesPool + nextNoPool,
          updatedAt: serverTimestamp(),
        });

        try {
          await batch.commit();
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `markets/${activeMarket.id}/shielded_bets`);
        }
      }

      // Mirror / persist to Express store (works for Zcash / Pollar-only sessions too)
      const apiBetRes = await fetch(`/api/markets/${encodeURIComponent(activeMarket.id)}/bets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txid: cleanTxid,
          poolType: 'orchard',
          recipientAddress: activeMarket.shieldedPoolAddress,
          pick: verifyPick,
          payoutTo: cleanPayoutTo,
          amountZatoshis,
          rawMemoHex,
          confirmations: 1,
        }),
      });
      if (!user && !apiBetRes.ok) {
        throw new Error('Unable to record verified bet on server.');
      }
      if (!user) {
        const createdBet: ShieldedBet = {
          id: betId,
          marketId: activeMarket.id,
          txid: cleanTxid,
          poolType: 'orchard',
          recipientAddress: activeMarket.shieldedPoolAddress,
          pick: verifyPick,
          payoutTo: cleanPayoutTo,
          amountZatoshis,
          rawMemoHex,
          decodedMemoJson: memoObj,
          confirmations: 1,
          createdAt: new Date().toISOString(),
        };
        setMarketBets((prev) => [createdBet, ...prev]);
        setLocalActiveSnapshot((prev) =>
          prev && prev.id === activeMarket.id
            ? {
                ...prev,
                totalVolumeZatoshis: prev.totalVolumeZatoshis + amountZatoshis,
                liquidityZatoshis: nextYesPool + nextNoPool,
                outcomes: {
                  yes: { ...prev.outcomes.yes, poolZatoshis: nextYesPool, sharesOutstanding: nextYesShares },
                  no: { ...prev.outcomes.no, poolZatoshis: nextNoPool, sharesOutstanding: nextNoShares },
                },
              }
            : prev
        );
      }
      void onRefresh?.();

      setVerifyTxid('');
      setRawZashiMemoInput('');
      setMemoDecodeNote(null);
      setActionSuccess(
        `Verified & locked ${parsedAmt.toFixed(4)} ZEC bet on ${verifyPick}.${onChainMsg}`
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Unable to verify bet in Cloud Firestore.'
      );
    } finally {
      setVerifyingBet(false);
    }
  };

  const handleCreateMarket = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setActionError(null);
    setActionSuccess(null);

    if (!hasAnyIdentity) {
      setFormError('Sign in with Zcash, Pollar / Polygon, or Google to host a market.');
      openAuthModal('zcash');
      return;
    }

    const cleanQuestion = question.trim();
    const cleanAddress = payoutAddress.trim();
    const safeSeconds = totalDurationSeconds;
    const durationHoursFloat = Number((safeSeconds / 3600).toFixed(6));

    if (cleanQuestion.length < 10 || cleanQuestion.length > 280) {
      setFormError('Question must be between 10 and 280 characters.');
      return;
    }
    if (!Number.isFinite(safeSeconds) || safeSeconds < 5 || safeSeconds > 31_536_000) {
      setFormError('Duration must be between 5 seconds and 365 days.');
      return;
    }
    if (!ZCASH_ADDRESS_REGEX.test(cleanAddress)) {
      setFormError(
        'Enter a valid Zcash shielded payout address starting with u1, utest1, uregtest1, or zs1 (20–256 characters).'
      );
      return;
    }

    const rawAnchorTxid = createAnchorTxid.trim();
    if (rawAnchorTxid && !isValidOnChainTxid(rawAnchorTxid)) {
      setFormError('Optional Creation Anchor TxID must be a valid 64-character hex Zcash txid.');
      return;
    }
    const normalizedAnchorTxid = rawAnchorTxid ? normalizeOnChainTxid(rawAnchorTxid) : null;

    setCreating(true);
    try {
      const identityKey =
        user?.uid ||
        walletSession?.address ||
        pollarWallet?.address ||
        'host';
      const uidFragment = identityKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'host';
      const creatorId = `creator_${uidFragment}`;
      const creatorDisplayName = (
        user?.displayName ||
        (walletSession
          ? `${walletSession.rail === 'zcash' ? 'Zcash' : 'Polygon'} Host`
          : 'Pollar Creator')
      ).slice(0, 80);
      const creatorHandle = sanitizeHandle(
        user?.email?.split('@')[0] || user?.displayName || `host_${uidFragment.slice(0, 6)}`
      );

      // Step 1: Ensure creator profile exists in Cloud Firestore when optional Google Auth is linked
      if (user) {
        const creatorRef = doc(db, 'creators', creatorId);
        try {
          const existingCreatorSnap = await getDoc(creatorRef);
          if (!existingCreatorSnap.exists()) {
            await setDoc(creatorRef, {
              id: creatorId,
              ownerUid: user.uid,
              handle: creatorHandle,
              displayName: creatorDisplayName,
              bio: 'Zolymarket prediction market creator.',
              zcashUnifiedAddress: cleanAddress,
              verified: false,
              marketsCreatedCount: 0,
              totalVolumeZatoshis: 0,
              createdAt: serverTimestamp(),
            });
          } else if (existingCreatorSnap.data()?.zcashUnifiedAddress !== cleanAddress) {
            await updateDoc(creatorRef, {
              zcashUnifiedAddress: cleanAddress,
            });
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `creators/${creatorId}`);
        }
      }

      // Step 2: Determine Shielded Pool Address (Self-Custodial Zashi default or optional zingo-cli)
      const shortSuffix = Math.random().toString(36).slice(2, 8);
      const marketId = `mkt_${Date.now().toString(36)}_${shortSuffix}`;
      const slug = slugifyQuestion(cleanQuestion, shortSuffix);
      const closesAtIso = new Date(Date.now() + safeSeconds * 1000).toISOString();

      let shieldedPoolAddress = '';
      let source: 'zashi' | 'zingo-cli' | 'preview' = 'zashi';

      if (poolAddressMode === 'zashi') {
        const cleanPool = customPoolAddress.trim() || cleanAddress;
        if (!ZCASH_ADDRESS_REGEX.test(cleanPool)) {
          setFormError(
            'Enter a valid Zashi Unified Address (u1... or utest1...) for the market shielded pool.'
          );
          setCreating(false);
          return;
        }
        shieldedPoolAddress = cleanPool;
        source = 'zashi';
      } else {
        source = 'preview';
        try {
          const walletRes = await fetch('/api/zcash/wallet', { method: 'POST' });
          if (walletRes.ok) {
            const walletJson = (await walletRes.json()) as { address?: string };
            if (walletJson.address && ZCASH_ADDRESS_REGEX.test(walletJson.address)) {
              shieldedPoolAddress = walletJson.address;
              source = 'zingo-cli';
            }
          }
        } catch {
          // Preview fallback
        }

        if (!shieldedPoolAddress) {
          const fallbackPrefix = cleanAddress.startsWith('utest1') ? 'utest1' : 'u1';
          shieldedPoolAddress = buildFallbackPoolAddress(marketId, fallbackPrefix);
        }
      }

      if (createUfvk.trim()) {
        try {
          localStorage.setItem(`${UFVK_STORAGE_PREFIX}${marketId}`, createUfvk.trim());
        } catch {
          // Ignore storage errors
        }
      }

      const initialSidePool = zecToZatoshis(5.0);
      const description = `Creator-hosted Zcash prediction market closing ${new Date(closesAtIso).toUTCString()}.`;
      const resolutionCriteria = `Market creator (${creatorDisplayName}) resolves YES or NO upon outcome verification before ${closesAtIso}.`;

      // Step 3: Persist market to Cloud Firestore when Google Auth is active
      if (user) {
        const marketRef = doc(db, 'markets', marketId);
        try {
          await setDoc(marketRef, {
            id: marketId,
            slug,
            creatorId,
            ownerUid: user.uid,
            question: cleanQuestion,
            description,
            resolutionCriteria,
            category,
            status: MarketStatus.Open,
            shieldedPoolAddress,
            creatorFeeBps: 150,
            yesPoolZatoshis: initialSidePool,
            noPoolZatoshis: initialSidePool,
            yesSharesOutstanding: 0,
            noSharesOutstanding: 0,
            totalVolumeZatoshis: 0,
            liquidityZatoshis: initialSidePool * 2,
            yesProbability24hAgo: 50,
            winningOutcome: null,
            duration: durationHoursFloat,
            closesAt: closesAtIso,
            resolvedAt: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `markets/${marketId}`);
        }
      }

      // Step 4: Mirror / Create in Express store (primary for Zcash / Pollar-only sessions)
      const nowIso = new Date().toISOString();
      const createdMarket: MarketWithDetails = {
        id: marketId,
        slug,
        creatorId,
        ownerUid: user?.uid || uidFragment,
        question: cleanQuestion,
        description,
        resolutionCriteria,
        category,
        status: MarketStatus.Open,
        shieldedPoolAddress,
        creationTxid: normalizedAnchorTxid,
        creatorFeeBps: 150,
        totalVolumeZatoshis: 0,
        liquidityZatoshis: initialSidePool * 2,
        yesProbability24hAgo: 50,
        winningOutcome: null,
        duration: durationHoursFloat,
        closesAt: closesAtIso,
        resolvedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        creator: {
          id: creatorId,
          handle: creatorHandle,
          displayName: creatorDisplayName,
          bio: 'Zolymarket prediction market creator.',
          zcashUnifiedAddress: cleanAddress,
          verified: false,
          marketsCreatedCount: 1,
          totalVolumeZatoshis: 0,
          createdAt: nowIso,
        },
        outcomes: {
          yes: {
            id: `${marketId}-yes`,
            marketId,
            side: OutcomeSide.Yes,
            poolZatoshis: initialSidePool,
            sharesOutstanding: 0,
            updatedAt: nowIso,
          },
          no: {
            id: `${marketId}-no`,
            marketId,
            side: OutcomeSide.No,
            poolZatoshis: initialSidePool,
            sharesOutstanding: 0,
            updatedAt: nowIso,
          },
        },
        yesProbability: 50,
        noProbability: 50,
        change24hPct: 0,
      };

      void fetch('/api/markets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: marketId,
          slug,
          creatorId,
          ownerUid: user?.uid || uidFragment,
          creatorDisplayName,
          creatorHandle,
          creatorPayoutAddress: cleanAddress,
          question: cleanQuestion,
          description,
          resolutionCriteria,
          category,
          shieldedPoolAddress,
          creationTxid: normalizedAnchorTxid,
          duration: durationHoursFloat,
          closesAt: closesAtIso,
        }),
      }).then(() => onRefresh?.());

      setLocalActiveSnapshot(createdMarket);
      setActiveMarketId(marketId);
      setWalletProvisionSource(source);
      setQuestion('');
      setCustomPoolAddress('');
      setCreateUfvk('');
      setCreateAnchorTxid('');
      setActionSuccess(
        source === 'zashi'
          ? 'Market created with your self-custodial Zashi pool address (zero VPS required).'
          : source === 'zingo-cli'
          ? 'Market created and shielded pool address provisioned via zingo-cli.'
          : 'Market created in Cloud Firestore with Testnet preview pool address.'
      );
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Unable to create market. Check permissions and try again.'
      );
    } finally {
      setCreating(false);
    }
  };

  const handleLockBetting = async () => {
    if (!activeMarket || activeMarket.status !== MarketStatus.Open) return;
    setActionError(null);
    setActionSuccess(null);
    setLocking(true);

    try {
      if (user) {
        const marketRef = doc(db, 'markets', activeMarket.id);
        try {
          await updateDoc(marketRef, {
            status: MarketStatus.Locked,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `markets/${activeMarket.id}`);
        }
      }

      setLocalActiveSnapshot((prev) =>
        prev && prev.id === activeMarket.id
          ? { ...prev, status: MarketStatus.Locked, updatedAt: new Date().toISOString() }
          : prev
      );

      void fetch(`/api/markets/${encodeURIComponent(activeMarket.id)}/lock`, {
        method: 'POST',
      }).then(() => onRefresh?.());

      setActionSuccess('Betting is now locked. No new bets will be accepted before resolution.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to lock betting.');
    } finally {
      setLocking(false);
    }
  };

  const handleConfirmResolve = async () => {
    if (!activeMarket || activeMarket.status === MarketStatus.Resolved) return;
    setActionError(null);
    setActionSuccess(null);
    setResolving(true);

    const resolvedAtIso = new Date().toISOString();

    try {
      if (user) {
        const marketRef = doc(db, 'markets', activeMarket.id);
        try {
          await updateDoc(marketRef, {
            status: MarketStatus.Resolved,
            winningOutcome: selectedWinner,
            resolvedAt: resolvedAtIso,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `markets/${activeMarket.id}`);
        }
      }

      setLocalActiveSnapshot((prev) =>
        prev && prev.id === activeMarket.id
          ? {
              ...prev,
              status: MarketStatus.Resolved,
              winningOutcome: selectedWinner,
              resolvedAt: resolvedAtIso,
              updatedAt: resolvedAtIso,
            }
          : prev
      );

      const localBatch = computeMarketBatchPayouts({
        marketId: activeMarket.id,
        creatorAddress: activeMarket.creator.zcashUnifiedAddress || activeMarket.shieldedPoolAddress,
        creatorFeeBps: activeMarket.creatorFeeBps,
        winningOutcome: selectedWinner,
        bets: marketBets,
      });

      let payoutMessage =
        localBatch.uri
          ? `Market resolved as ${selectedWinner}. One-tap Zashi multi-recipient batch payout QR generated below (${localBatch.recipientCount} output${localBatch.recipientCount === 1 ? '' : 's'}, ${localBatch.totalAmountZec} ZEC).`
          : `Market resolved as ${selectedWinner}.`;

      try {
        await fetch(`/api/markets/${encodeURIComponent(activeMarket.id)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ winningOutcome: selectedWinner }),
        });
        void onRefresh?.();
      } catch {
        // Firestore resolution already succeeded
      }

      setResolveModalOpen(false);
      setActionSuccess(payoutMessage);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve market.');
    } finally {
      setResolving(false);
    }
  };

  const joinUrl = useMemo(() => {
    if (!activeMarket) return '';
    const origin =
      typeof window !== 'undefined' ? window.location.origin : 'https://zolymarket.app';
    return `${origin}/room/${encodeURIComponent(activeMarket.id)}`;
  }, [activeMarket]);

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-4 sm:gap-6 pb-5 sm:pb-6 border-b border-slate-200">
        <div className="space-y-2 max-w-2xl min-w-0">
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
            {activeMarket ? 'Active Creator Market Console' : 'Host a Zcash Prediction Market'}
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            {activeMarket
              ? 'Share your Market ID and QR join link with bettors, lock betting before the event settles, and resolve YES or NO in Cloud Firestore.'
              : 'Launch a binary prediction market synced to Cloud Firestore with your Zcash Unified Address for creator fee payouts.'}
          </p>
        </div>

        {activeMarket && (
          <button
            type="button"
            onClick={() => {
              setActiveMarketId(null);
              setActionError(null);
              setActionSuccess(null);
            }}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 hover:text-slate-900 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Create Another Market</span>
          </button>
        )}
      </section>

      {/* Sign-in Prompt: Zcash or Pollar/Polygon primary, Google optional */}
      {!hasAnyIdentity ? (
        <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-semibold text-slate-900">
              Sign in with Zcash or Pollar / Polygon to Host Markets
            </h2>
            <p className="text-sm text-slate-600">
              Connect your Zcash Unified wallet, Pollar / Polygon identity, or optional Google
              account to create and resolve prediction markets.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => openAuthModal('zcash')}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150 whitespace-nowrap cursor-pointer"
            >
              Sign in (Zcash / Pollar)
            </button>
            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors duration-150 whitespace-nowrap cursor-pointer"
            >
              Optional: Google
            </button>
          </div>
        </section>
      ) : !user && (
        <section className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <p className="text-slate-600">
            Hosting via{' '}
            <span className="font-semibold text-slate-900">
              {walletSession ? walletSession.label : 'Pollar Social'}
            </span>
            . Optional: link Google for Cloud Firestore persistence across devices.
          </p>
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="min-h-[36px] px-3 py-1.5 font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            Optional: Link Google
          </button>
        </section>
      )}

      {/* ACTIVE SCREEN */}
      {activeMarket ? (
        <div className="space-y-6">
          {actionError && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-sm text-rose-800 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{actionError}</span>
            </div>
          )}

          {actionSuccess && (
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-900 flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{actionSuccess}</span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            {/* Left: Market Identity, Status & Two Massive Host Controls */}
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 flex flex-col justify-between gap-5 sm:gap-6">
              <div className="space-y-4">
                {/* Quiet unboxed metadata line */}
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{activeMarket.category}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    className={`font-semibold ${
                      activeMarket.status === MarketStatus.Open
                        ? 'text-emerald-700'
                        : activeMarket.status === MarketStatus.Locked
                        ? 'text-amber-700'
                        : 'text-slate-900'
                    }`}
                  >
                    {activeMarket.status === MarketStatus.Open
                      ? 'Status: Open for Betting'
                      : activeMarket.status === MarketStatus.Locked
                      ? 'Status: Betting Locked'
                      : `Status: Resolved (${activeMarket.winningOutcome ?? 'Settled'})`}
                  </span>
                  {walletProvisionSource && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        Pool:{' '}
                        {walletProvisionSource === 'zashi'
                          ? 'Self-Custodial Zashi'
                          : walletProvisionSource === 'zingo-cli'
                          ? 'zingo-cli node'
                          : 'Testnet preview'}
                      </span>
                    </>
                  )}
                </div>

                <h2 className="font-display text-xl sm:text-2xl font-bold text-slate-900 leading-snug [text-wrap:balance]">
                  {activeMarket.question}
                </h2>

                {/* Market ID Copy Row */}
                <div className="p-3.5 sm:p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-slate-500">Market ID</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy('market-id', activeMarket.id)}
                      className="inline-flex items-center gap-1.5 min-h-[32px] px-2 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                    >
                      {copiedKey === 'market-id' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Copy ID</span>
                        </>
                      )}
                    </button>
                  </div>
                  <p className="font-mono text-xs sm:text-sm font-semibold text-slate-900 break-all select-all">
                    {activeMarket.id}
                  </p>
                </div>

                {/* Live Pool Metrics */}
                <div className="grid grid-cols-1 min-[360px]:grid-cols-3 gap-3 sm:gap-4 pt-2 border-t border-slate-100 font-mono tabular-nums">
                  <div>
                    <p className="font-sans text-xs text-slate-500">YES Odds</p>
                    <p className="text-base sm:text-lg font-semibold text-emerald-700">
                      {activeMarket.yesProbability.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="font-sans text-xs text-slate-500">NO Odds</p>
                    <p className="text-base sm:text-lg font-semibold text-rose-700">
                      {activeMarket.noProbability.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="font-sans text-xs text-slate-500">Pool Liquidity</p>
                    <p className="text-base sm:text-lg font-semibold text-slate-900">
                      {formatZec(activeMarket.liquidityZatoshis, 1)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Two Massive Host Action Buttons */}
              <div className="pt-4 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <button
                  type="button"
                  onClick={() => void handleLockBetting()}
                  disabled={
                    locking ||
                    activeMarket.status === MarketStatus.Locked ||
                    activeMarket.status === MarketStatus.Resolved
                  }
                  className="w-full min-h-[52px] py-3.5 px-4 sm:px-5 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed text-amber-950 font-display text-sm sm:text-base font-bold transition-colors duration-150 flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
                >
                  <Lock className="w-4 h-4 sm:w-5 sm:h-5 text-amber-700 shrink-0" aria-hidden="true" />
                  <span>
                    {locking
                      ? 'Locking Betting...'
                      : activeMarket.status === MarketStatus.Locked
                      ? '🔒 Betting Locked'
                      : '🔒 Lock Betting'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActionError(null);
                    setResolveModalOpen(true);
                  }}
                  disabled={resolving || activeMarket.status === MarketStatus.Resolved}
                  className="w-full min-h-[52px] py-3.5 px-4 sm:px-5 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-display text-sm sm:text-base font-bold transition-colors duration-150 flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
                >
                  <Trophy className="w-4 h-4 sm:w-5 sm:h-5 text-amber-400 shrink-0" aria-hidden="true" />
                  <span>
                    {activeMarket.status === MarketStatus.Resolved
                      ? `🏆 Resolved: ${activeMarket.winningOutcome}`
                      : '🏆 Resolve Market'}
                  </span>
                </button>
              </div>
            </div>

            {/* Right: QR Code Link to Join */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 flex flex-col items-center justify-between gap-4 sm:gap-5 text-center">
              <div className="space-y-1">
                <h3 className="font-display text-base font-semibold text-slate-900">
                  QR Code Link to Join
                </h3>
                <p className="text-xs text-slate-500">
                  Scan to open this market directly and place a shielded YES or NO bet.
                </p>
              </div>

              <div className="p-3 sm:p-4 bg-white border border-slate-200 rounded-xl max-w-[240px] w-full flex items-center justify-center">
                <QRCodeSVG
                  value={joinUrl}
                  size={208}
                  level="M"
                  includeMargin={false}
                  bgColor="#ffffff"
                  fgColor="#0f172a"
                  className="w-full h-auto max-w-[208px]"
                />
              </div>

              <div className="w-full space-y-2.5 text-left">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-500">Shareable Join URL</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy('join-url', joinUrl)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                    >
                      {copiedKey === 'join-url' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Copy Link</span>
                        </>
                      )}
                    </button>
                  </div>
                  <p className="font-mono text-xs text-slate-700 break-all">{joinUrl}</p>
                </div>

                {onOpenRoom && (
                  <button
                    type="button"
                    onClick={() => onOpenRoom(activeMarket.id)}
                    className="w-full min-h-[44px] py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Open Player Betting Room</span>
                  </button>
                )}

                {onOpenMarketModal && (
                  <button
                    type="button"
                    onClick={() => onOpenMarketModal(activeMarket)}
                    className="w-full min-h-[44px] py-2.5 px-4 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 hover:text-slate-900 transition-colors duration-150 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Preview Bettor ZIP-321 Drawer</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ON-CHAIN MARKET ANCHOR (ZINGO TESTNET) */}
          <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="space-y-1">
                <h3 className="font-display text-base font-semibold text-slate-900">
                  On-Chain Market Anchor (Zingo Testnet)
                </h3>
                <p className="text-xs text-slate-600">
                  Anchor this market creation on Zcash Testnet with a 0.0001 ZEC ZIP-321 memo tx so anyone can verify market provenance on-chain.
                </p>
              </div>
              {activeMarket.creationTxid && (
                <span className="font-mono text-xs font-semibold text-emerald-700 shrink-0">
                  Verified On-Chain
                </span>
              )}
            </div>

            {activeMarket.creationTxid ? (
              (() => {
                const links = getZcashTxExplorerUrls(
                  activeMarket.creationTxid,
                  activeMarket.shieldedPoolAddress
                );
                return (
                  <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 space-y-0.5">
                      <span className="font-semibold text-emerald-950 block">
                        Creation Anchor TxID ({links.network})
                      </span>
                      <p className="font-mono text-emerald-900 break-all select-all">
                        {activeMarket.creationTxid}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 shrink-0">
                      <a
                        href={links.primaryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-semibold text-emerald-900 hover:text-slate-900 underline underline-offset-2"
                      >
                        <span>{links.primaryLabel}</span>
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      </a>
                      <a
                        href={links.secondaryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-emerald-800 hover:text-slate-900 underline underline-offset-2"
                      >
                        <span>{links.secondaryLabel}</span>
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
                {creationAnchorUri && (
                  <div className="lg:col-span-5 flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="p-2 bg-white border border-slate-200 rounded-lg shrink-0">
                      <QRCodeSVG
                        value={creationAnchorUri.uri}
                        size={84}
                        level="M"
                        includeMargin={false}
                        bgColor="#ffffff"
                        fgColor="#0f172a"
                      />
                    </div>
                    <div className="min-w-0 space-y-1.5 text-xs">
                      <p className="font-semibold text-slate-900">
                        1. Broadcast 0.0001 TAZ Anchor
                      </p>
                      <p className="text-slate-600 line-clamp-2">
                        Scan with Zingo / Zashi to commit market ID to pool.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <a
                          href={creationAnchorUri.uri}
                          className="font-semibold text-amber-800 hover:text-amber-900 underline underline-offset-2"
                        >
                          Open Wallet
                        </a>
                        <button
                          type="button"
                          onClick={() => void handleCopy('anchor-uri', creationAnchorUri.uri)}
                          className="font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                        >
                          {copiedKey === 'anchor-uri' ? 'Copied URI' : 'Copy URI'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <form
                  onSubmit={(e) => void handleAnchorMarketCreation(e)}
                  className={`${creationAnchorUri ? 'lg:col-span-7' : 'lg:col-span-12'} flex flex-col sm:flex-row gap-2`}
                >
                  <input
                    type="text"
                    value={anchorTxInput}
                    onChange={(e) => setAnchorTxInput(e.target.value)}
                    placeholder="2. Paste 64-char hex creationTxid from Zingo Testnet..."
                    aria-label="Market creation Zcash transaction ID"
                    className="flex-1 min-h-[42px] px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                  />
                  <button
                    type="submit"
                    disabled={anchoringMarket}
                    className="min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg whitespace-nowrap cursor-pointer"
                  >
                    {anchoringMarket ? 'Anchoring...' : 'Anchor & Verify Tx'}
                  </button>
                </form>
              </div>
            )}
          </section>

          {/* ONE-TAP ZASHI MULTI-RECIPIENT BATCH PAYOUT (Shown when Resolved) */}
          {activeMarket.status === MarketStatus.Resolved && resolvedBatchPayout && (
            <section className="bg-white border border-emerald-300 rounded-xl p-4 sm:p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <QrCode className="w-5 h-5 text-emerald-700 shrink-0" aria-hidden="true" />
                    <h3 className="font-display text-lg font-bold text-slate-900">
                      One-Tap Zashi Multi-Recipient Batch Payout (ZIP-321)
                    </h3>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {resolvedBatchPayout.note} Scan or tap below to approve every winning payout and
                    your creator fee in a single shielded Zashi transaction—zero server custody.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 min-[380px]:grid-cols-3 gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg font-mono tabular-nums text-xs">
                <div>
                  <span className="font-sans text-slate-500 block">Total Pool</span>
                  <span className="text-sm sm:text-base font-semibold text-slate-900">
                    {formatZec(resolvedBatchPayout.totalPoolZatoshis, 4)}
                  </span>
                </div>
                <div>
                  <span className="font-sans text-slate-500 block">
                    Creator Fee ({(activeMarket.creatorFeeBps / 100).toFixed(2)}%)
                  </span>
                  <span className="text-sm sm:text-base font-semibold text-amber-800">
                    {formatZec(resolvedBatchPayout.creatorFeeZatoshis, 4)}
                  </span>
                </div>
                <div>
                  <span className="font-sans text-slate-500 block">
                    Winners Pool ({activeMarket.winningOutcome})
                  </span>
                  <span className="text-sm sm:text-base font-semibold text-emerald-700">
                    {formatZec(resolvedBatchPayout.distributableZatoshis, 4)}
                  </span>
                </div>
              </div>

              {resolvedBatchPayout.uri ? (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
                  {/* Batch QR + Deep Link */}
                  <div className="lg:col-span-5 flex flex-col items-center gap-4 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                    <div className="p-3 bg-white border border-slate-200 rounded-xl max-w-[232px] w-full flex items-center justify-center">
                      <QRCodeSVG
                        value={resolvedBatchPayout.uri}
                        size={208}
                        level="M"
                        includeMargin={false}
                        bgColor="#ffffff"
                        fgColor="#0f172a"
                        className="w-full h-auto max-w-[208px]"
                      />
                    </div>

                    <div className="w-full space-y-2">
                      <a
                        href={resolvedBatchPayout.uri}
                        className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
                      >
                        <ExternalLink className="w-4 h-4" aria-hidden="true" />
                        <span>Approve Batch Payout in Zashi</span>
                      </a>

                      <button
                        type="button"
                        onClick={() => void handleCopy('batch-zip321', resolvedBatchPayout.uri)}
                        className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-white border border-slate-200 hover:border-slate-300 text-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
                      >
                        {copiedKey === 'batch-zip321' ? (
                          <>
                            <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                            <span>Copied Multi-Recipient URI</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4" aria-hidden="true" />
                            <span>Copy Batch ZIP-321 URI</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Itemized Output Breakdown + URI Preview */}
                  <div className="lg:col-span-7 space-y-3 min-w-0">
                    <h4 className="text-xs font-semibold text-slate-700">
                      Itemized Payout Outputs ({resolvedBatchPayout.recipientCount})
                    </h4>
                    <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                      {resolvedBatchPayout.recipients.map((rec, idx) => (
                        <li
                          key={`${rec.address}-${idx}`}
                          className="p-3 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span
                                className={`font-semibold ${
                                  rec.role === 'creator' ? 'text-amber-800' : 'text-emerald-700'
                                }`}
                              >
                                #{idx} · {rec.role === 'creator' ? 'Creator Fee' : `${activeMarket.winningOutcome} Winner`}
                              </span>
                              <span className="font-mono text-slate-400">
                                {idx === 0 ? 'address' : `address.${idx}`}
                              </span>
                            </div>
                            <p className="font-mono text-slate-700 truncate">{rec.address}</p>
                            <p className="text-slate-500 truncate">{rec.memo}</p>
                          </div>
                          <div className="font-mono font-semibold text-slate-900 tabular-nums shrink-0">
                            {rec.amountZec.toFixed(6).replace(/\.?0+$/, '')} ZEC
                          </div>
                        </li>
                      ))}
                    </ul>

                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1 text-xs">
                      <span className="font-medium text-slate-500 block">
                        Encoded Multi-Recipient ZIP-321 URI
                      </span>
                      <p className="font-mono text-slate-700 break-all select-all max-h-24 overflow-y-auto">
                        {resolvedBatchPayout.uri}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                  No verified shielded bets were recorded in this market before resolution. Verify
                  bets while open/locked to generate a multi-recipient Zashi batch payout QR.
                </div>
              )}
            </section>
          )}

          {/* SELF-CUSTODIAL HYBRID BET VERIFICATION (ZERO-VPS) */}
          <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-slate-900 shrink-0" aria-hidden="true" />
                  <h3 className="font-display text-lg font-semibold text-slate-900">
                    Self-Custodial Bet Verification (Zashi / Local UFVK)
                  </h3>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Paste incoming Zashi transactions or decrypted ZIP-321 memos to lock player bets into
                  Cloud Firestore, update live CPMM odds, and power your batch payout split—with $0 VPS
                  cost and zero server custody of spending keys.
                </p>
              </div>
              <span className="font-mono text-xs font-semibold text-slate-700 shrink-0 tabular-nums">
                {marketBets.length} verified bet{marketBets.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
              {/* Left: Verify Incoming Bet Form */}
              <div className="lg:col-span-6 space-y-4">
                {activeMarket.status === MarketStatus.Resolved ? (
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                    This market is already resolved ({activeMarket.winningOutcome}). Verified bets are
                    locked into the batch payout breakdown above.
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => void handleVerifyZashiBet(e)}
                    className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3.5"
                  >
                    {/* Quick Decode Memo from Zashi */}
                    <div className="space-y-1.5">
                      <label
                        htmlFor="zashi-memo-decode"
                        className="block text-xs font-medium text-slate-700"
                      >
                        1. Paste Decrypted Zashi Memo / Base64URL / Hex / ZIP-321 URI (Auto-Fill)
                      </label>
                      <textarea
                        id="zashi-memo-decode"
                        rows={2}
                        value={rawZashiMemoInput}
                        onChange={(e) => handleDecodeZashiMemo(e.target.value)}
                        placeholder='{"q":"mkt_...","pick":"YES","payout_to":"u1..."} or zcash:u1...'
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600"
                      />
                      {memoDecodeNote && (
                        <p className="text-xs text-amber-800">{memoDecodeNote}</p>
                      )}
                    </div>

                    {/* Zcash TxID */}
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <label htmlFor="zashi-txid" className="font-medium text-slate-700">
                          2. Incoming Zcash TxID (Hex)
                        </label>
                        <button
                          type="button"
                          onClick={() => setVerifyTxid(generateSampleHexTxid())}
                          className="text-xs font-medium text-amber-700 hover:text-amber-800 cursor-pointer"
                        >
                          Generate Preview Hex TxID
                        </button>
                      </div>
                      <input
                        id="zashi-txid"
                        type="text"
                        required
                        value={verifyTxid}
                        onChange={(e) => setVerifyTxid(e.target.value)}
                        placeholder="64-char hex transaction id from Zashi..."
                        className="w-full min-h-[42px] px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600"
                      />
                    </div>

                    {/* Side + Amount */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <span className="block text-xs font-medium text-slate-700">3. Pick</span>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setVerifyPick(OutcomeSide.Yes)}
                            className={`min-h-[42px] rounded-lg border text-xs font-bold cursor-pointer transition-colors ${
                              verifyPick === OutcomeSide.Yes
                                ? 'bg-emerald-50 border-emerald-600 text-emerald-900'
                                : 'bg-white border-slate-200 text-slate-600'
                            }`}
                          >
                            YES
                          </button>
                          <button
                            type="button"
                            onClick={() => setVerifyPick(OutcomeSide.No)}
                            className={`min-h-[42px] rounded-lg border text-xs font-bold cursor-pointer transition-colors ${
                              verifyPick === OutcomeSide.No
                                ? 'bg-rose-50 border-rose-600 text-rose-900'
                                : 'bg-white border-slate-200 text-slate-600'
                            }`}
                          >
                            NO
                          </button>
                        </div>
                      </div>

                      <label className="block space-y-1.5">
                        <span className="block text-xs font-medium text-slate-700">
                          4. Amount (ZEC)
                        </span>
                        <input
                          type="number"
                          min="0.0001"
                          step="0.0001"
                          required
                          value={verifyAmountInput}
                          onChange={(e) => setVerifyAmountInput(e.target.value)}
                          className="w-full min-h-[42px] px-3 py-2 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600"
                        />
                      </label>
                    </div>

                    {/* Player Return Address */}
                    <label className="block space-y-1.5">
                      <span className="block text-xs font-medium text-slate-700">
                        5. Player Payout Address (`payout_to`: u1... / utest1...)
                      </span>
                      <input
                        type="text"
                        required
                        value={verifyPayoutTo}
                        onChange={(e) => setVerifyPayoutTo(e.target.value)}
                        placeholder="u1... or utest1..."
                        className="w-full min-h-[42px] px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600"
                      />
                    </label>

                    <button
                      type="submit"
                      disabled={verifyingBet || !hasAnyIdentity}
                      className="w-full min-h-[44px] px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                    >
                      {verifyingBet ? 'Recording Bet On-Chain...' : 'Confirm & Lock Zashi / Zingo Bet'}
                    </button>
                  </form>
                )}

                {/* Browser-Only Read-Only UFVK Vault */}
                <div className="p-3.5 bg-white border border-slate-200 rounded-lg space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                    <KeyRound className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden="true" />
                    <span>Read-Only Viewing Key (Browser-Only UFVK)</span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Optional `uview1...` / `uviewtest1...` key saved strictly in{' '}
                    <span className="font-mono">localStorage</span> on this device for your WASM /
                    light-client verification—never sent to Express or Firestore.
                  </p>
                  <input
                    type="text"
                    value={activeUfvk}
                    onChange={(e) => handleSaveLocalUfvk(e.target.value)}
                    placeholder="uview1... or uviewtest1... (local browser only)"
                    className="w-full min-h-[40px] px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                  />
                </div>
              </div>

              {/* Right: Verified Bets Ledger */}
              <div className="lg:col-span-6 space-y-3 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-700">
                    Verified Pool Bets ({marketBets.length})
                  </span>
                  <span className="font-mono text-slate-500 break-all truncate max-w-[210px]">
                    Pool: {activeMarket.shieldedPoolAddress}
                  </span>
                </div>

                {marketBets.length === 0 ? (
                  <div className="p-6 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-500 leading-relaxed">
                    No incoming bets have been verified for this market yet. When a player scans your
                    room QR in Zashi or Zingo Testnet, paste the txid and decrypted memo on the left to record it.
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden max-h-[420px] overflow-y-auto">
                    {marketBets.map((bet) => {
                      const txLinks = getZcashTxExplorerUrls(
                        bet.txid,
                        activeMarket.shieldedPoolAddress
                      );
                      return (
                        <li key={bet.id} className="p-3.5 bg-white space-y-1.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`font-display font-bold ${
                                bet.pick === OutcomeSide.Yes ? 'text-emerald-700' : 'text-rose-700'
                              }`}
                            >
                              {bet.pick} · {zatoshisToZec(bet.amountZatoshis).toFixed(4)} ZEC
                            </span>
                            <span className="font-mono text-slate-500 tabular-nums">
                              {bet.confirmations} conf
                            </span>
                          </div>
                          <p className="font-mono text-slate-700 truncate">
                            payout_to: {bet.payoutTo}
                          </p>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-slate-500 truncate">
                              txid: {formatShortTxid(bet.txid)}
                            </span>
                            {isValidOnChainTxid(bet.txid) && (
                              <a
                                href={txLinks.primaryUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 font-semibold text-amber-800 hover:text-slate-900 underline underline-offset-2 shrink-0"
                              >
                                <span>Verify Tx</span>
                                <ExternalLink className="w-3 h-3" aria-hidden="true" />
                              </a>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : (
        /* CREATE SCREEN */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={(e) => void handleCreateMarket(e)}
            className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5"
          >
            <div className="space-y-1">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                Create Prediction Market
              </h2>
              <p className="text-xs text-slate-500">
                Enter your binary question, betting duration, and your Zcash shielded payout address.
              </p>
            </div>

            {formError && (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{formError}</span>
              </div>
            )}

            {/* Question */}
            <label className="block space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700">Question</span>
                <span className="font-mono tabular-nums text-slate-400">
                  {question.trim().length} / 280
                </span>
              </div>
              <textarea
                rows={3}
                required
                maxLength={280}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g., Will Zcash Orchard shielded supply pass 20% before Q1 2027?"
                className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              />
            </label>

            {/* Duration */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                <span className="font-medium text-slate-700">Duration (min 5 seconds)</span>
                <span className="font-mono tabular-nums text-slate-500">
                  Closes {previewClosesAt.toLocaleString()}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {DURATION_OPTIONS.map((opt) => {
                  const active = totalDurationSeconds === opt.totalSeconds;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        setDurationValue(opt.value);
                        setDurationUnit(opt.unit);
                      }}
                      className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 whitespace-nowrap cursor-pointer ${
                        active
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <label htmlFor="custom-duration-value" className="text-xs text-slate-500">
                  Custom:
                </label>
                <input
                  id="custom-duration-value"
                  type="number"
                  min={durationUnit === 'seconds' ? 5 : 1}
                  step="1"
                  value={durationValue}
                  onChange={(e) => setDurationValue(Math.max(1, Number(e.target.value) || 1))}
                  className="w-24 min-h-[40px] px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                />
                <select
                  aria-label="Duration unit"
                  value={durationUnit}
                  onChange={(e) => {
                    const nextUnit = e.target.value as DurationUnit;
                    setDurationUnit(nextUnit);
                    if (nextUnit === 'seconds' && durationValue < 5) {
                      setDurationValue(5);
                    }
                  }}
                  className="min-h-[40px] px-2.5 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                >
                  <option value="seconds">Seconds</option>
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </select>
              </div>
            </div>

            {/* Creator Payout Address */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <label htmlFor="creator-u1-address" className="font-medium text-slate-700">
                  Creator Fee Address (u1... / utest1...)
                </label>
                <button
                  type="button"
                  onClick={handleFillSampleAddress}
                  className="text-xs font-medium text-amber-700 hover:text-amber-800 cursor-pointer"
                >
                  {existingUserCreator?.zcashUnifiedAddress
                    ? 'Use My Saved Address'
                    : 'Fill Zingo Testnet utest1...'}
                </button>
              </div>
              <input
                id="creator-u1-address"
                type="text"
                required
                value={payoutAddress}
                onChange={(e) => setPayoutAddress(e.target.value)}
                placeholder="u1... or utest1..."
                className="w-full min-h-[42px] px-3.5 py-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              />
            </div>

            {/* Zero-VPS Zashi Pool Address Selector */}
            <div className="p-3.5 sm:p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800">
                  Market Shielded Pool Address
                </span>
                <div className="inline-flex items-center p-0.5 bg-slate-200/70 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setPoolAddressMode('zashi')}
                    className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors cursor-pointer ${
                      poolAddressMode === 'zashi'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Zashi Unified (No VPS)
                  </button>
                  <button
                    type="button"
                    onClick={() => setPoolAddressMode('zingo')}
                    className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors cursor-pointer ${
                      poolAddressMode === 'zingo'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    zingo-cli (Optional)
                  </button>
                </div>
              </div>

              {poolAddressMode === 'zashi' ? (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <label htmlFor="market-pool-u1-address" className="text-slate-600">
                      Paste your dedicated Zashi sub-account Unified Address:
                    </label>
                    <button
                      type="button"
                      onClick={() => payoutAddress && setCustomPoolAddress(payoutAddress)}
                      className="text-xs font-medium text-amber-700 hover:text-amber-800 cursor-pointer"
                    >
                      Same as Creator Address
                    </button>
                  </div>
                  <input
                    id="market-pool-u1-address"
                    type="text"
                    value={customPoolAddress}
                    onChange={(e) => setCustomPoolAddress(e.target.value)}
                    placeholder={
                      payoutAddress
                        ? 'Leave blank to use Creator Fee Address above, or paste Zashi sub-account u1...'
                        : 'u1... or utest1... Zashi sub-account address'
                    }
                    className="w-full min-h-[42px] px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600"
                  />
                  <input
                    type="text"
                    value={createUfvk}
                    onChange={(e) => setCreateUfvk(e.target.value)}
                    placeholder="Optional read-only UFVK (uview1... — browser localStorage only)"
                    aria-label="Optional read-only UFVK stored locally in browser"
                    className="w-full min-h-[40px] px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600"
                  />
                </div>
              ) : (
                <p className="text-xs text-slate-600 leading-relaxed">
                  Calls <span className="font-mono">/api/zcash/wallet</span> on launch if a VPS
                  node is attached, or generates a deterministic preview address otherwise.
                </p>
              )}
            </div>

            {/* Category */}
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-slate-700">Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as MarketCategory)}
                className="w-full min-h-[42px] px-3.5 py-2 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </label>

            {/* Optional On-Chain Market Creation Anchor TxID */}
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-slate-700">
                Creation Anchor TxID (Optional — or generate anchor QR after launch)
              </span>
              <input
                type="text"
                value={createAnchorTxid}
                onChange={(e) => setCreateAnchorTxid(e.target.value)}
                placeholder="Optional 64-char hex Zcash Testnet txid anchoring market creation..."
                className="w-full min-h-[42px] px-3.5 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              />
            </label>

            <div className="pt-2">
              <button
                type="submit"
                disabled={creating || !hasAnyIdentity}
                className="w-full py-3 px-5 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors duration-150 inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>{creating ? 'Creating Market...' : 'Launch Prediction Market'}</span>
              </button>
            </div>
          </form>

          {/* Right Column: Hosted Markets Switcher */}
          <aside className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4">
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-slate-900">
                Your Hosted Markets ({myHostedMarkets.length})
              </h2>
              <p className="text-xs text-slate-500">
                Select any market you own to open its QR code, lock betting, or resolve YES/NO.
              </p>
            </div>

            {myHostedMarkets.length === 0 ? (
              <div className="p-5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-500 leading-relaxed">
                Markets you launch will appear here immediately via Cloud Firestore real-time
                synchronization.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                {myHostedMarkets.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveMarketId(m.id);
                        setActionError(null);
                        setActionSuccess(null);
                      }}
                      className="w-full text-left p-4 hover:bg-slate-50 transition-colors duration-150 space-y-1 cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                        <span className="font-mono">{m.id}</span>
                        <span
                          className={`font-semibold ${
                            m.status === MarketStatus.Open
                              ? 'text-emerald-700'
                              : m.status === MarketStatus.Locked
                              ? 'text-amber-700'
                              : 'text-slate-700'
                          }`}
                        >
                          {m.status === MarketStatus.Resolved
                            ? `Resolved (${m.winningOutcome ?? ''})`
                            : m.status}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-slate-900 line-clamp-2">
                        {m.question}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}

      {/* Top Creators Leaderboard */}
      <TopCreatorsLeaderboard creators={creators} markets={markets} />

      {/* Resolve Market Modal (Select YES / NO) */}
      {resolveModalOpen && activeMarket && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="resolve-modal-title"
        >
          <div
            onClick={() => !resolving && setResolveModalOpen(false)}
            className="fixed inset-0 bg-slate-900/45 backdrop-blur-[1px]"
          />

          <div className="relative z-10 w-full max-w-md max-h-[90dvh] overflow-y-auto bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2
                  id="resolve-modal-title"
                  className="font-display text-lg font-bold text-slate-900"
                >
                  🏆 Resolve Market Outcome
                </h2>
                <p className="text-xs text-slate-500">
                  Finalizing the winning side locks the market permanently and settles the pool.
                </p>
              </div>
              <button
                type="button"
                disabled={resolving}
                onClick={() => setResolveModalOpen(false)}
                aria-label="Close resolve modal"
                className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center text-slate-400 hover:text-slate-900 rounded-lg cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <p className="text-sm font-medium text-slate-800 bg-slate-50 border border-slate-200 rounded-lg p-3.5">
              {activeMarket.question}
            </p>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setSelectedWinner(OutcomeSide.Yes)}
                className={`min-h-[52px] py-4 px-4 rounded-xl border-2 font-display text-base font-bold transition-colors duration-150 cursor-pointer ${
                  selectedWinner === OutcomeSide.Yes
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }`}
              >
                YES Won
              </button>
              <button
                type="button"
                onClick={() => setSelectedWinner(OutcomeSide.No)}
                className={`min-h-[52px] py-4 px-4 rounded-xl border-2 font-display text-base font-bold transition-colors duration-150 cursor-pointer ${
                  selectedWinner === OutcomeSide.No
                    ? 'border-rose-600 bg-rose-50 text-rose-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }`}
              >
                NO Won
              </button>
            </div>

            {modalPreviewBatchPayout && (
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5 text-xs">
                <div className="flex items-center justify-between font-semibold text-slate-800">
                  <span>Zashi ZIP-321 Batch Preview</span>
                  <span className="font-mono tabular-nums">
                    {modalPreviewBatchPayout.recipientCount} output
                    {modalPreviewBatchPayout.recipientCount === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="text-slate-600 leading-relaxed">{modalPreviewBatchPayout.note}</p>
                {modalPreviewBatchPayout.totalPoolZatoshis > 0 && (
                  <p className="font-mono tabular-nums text-slate-700">
                    Fee: {formatZec(modalPreviewBatchPayout.creatorFeeZatoshis, 4)} · Winners:{' '}
                    {formatZec(modalPreviewBatchPayout.distributableZatoshis, 4)}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2.5 sm:gap-3 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={resolving}
                onClick={() => setResolveModalOpen(false)}
                className="min-h-[44px] px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={resolving}
                onClick={() => void handleConfirmResolve()}
                className="min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg cursor-pointer"
              >
                {resolving ? 'Generating Zashi Payout QR...' : `Confirm ${selectedWinner} Winner`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

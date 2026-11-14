/**
 * Zolymarket — Phase 4 Creator Dashboard (/host)
 *
 * Uses React `useState` and Cloud Firestore to host binary Zcash prediction
 * markets, display the Market ID & QR join link, lock betting, and resolve
 * outcomes via a YES/NO modal.
 */

import React, { useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Lock,
  Plus,
  Trophy,
  X,
} from 'lucide-react';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext.tsx';
import { OperationType, db, handleFirestoreError } from '../lib/firebase.ts';
import { formatZec, zecToZatoshis } from '../lib/cpmm.ts';
import { TopCreatorsLeaderboard } from './TopCreatorsLeaderboard.tsx';
import {
  Creator,
  MarketCategory,
  MarketStatus,
  MarketWithDetails,
  OutcomeSide,
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
  const { user, signInWithGoogle } = useAuth();

  // Create Screen state
  const [question, setQuestion] = useState<string>('');
  const [durationValue, setDurationValue] = useState<number>(24);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('hours');
  const [payoutAddress, setPayoutAddress] = useState<string>('');
  const [category, setCategory] = useState<MarketCategory>(MarketCategory.CreatorBets);
  const [creating, setCreating] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Active Screen state
  const [activeMarketId, setActiveMarketId] = useState<string | null>(null);
  const [localActiveSnapshot, setLocalActiveSnapshot] = useState<MarketWithDetails | null>(null);
  const [walletProvisionSource, setWalletProvisionSource] = useState<'zingo-cli' | 'preview' | null>(null);

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

  // Existing markets owned by the signed-in creator
  const myHostedMarkets = useMemo(() => {
    if (!user) return [];
    return markets.filter(
      (m) => m.ownerUid === user.uid || m.creatorId === `creator_${user.uid.slice(0, 24)}`
    );
  }, [markets, user]);

  const existingUserCreator = useMemo(() => {
    if (!user) return null;
    const expectedId = `creator_${user.uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`;
    return creators.find((c) => c.id === expectedId) ?? null;
  }, [creators, user]);

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
    if (existingUserCreator?.zcashUnifiedAddress) {
      setPayoutAddress(existingUserCreator.zcashUnifiedAddress);
      return;
    }
    setPayoutAddress('u1hostpayout9x8c7v6b5n4m3l2k1j0h9g8f7d6s5a4p3o2i1u2y3t4r5e6w7q8');
  };

  const handleCreateMarket = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setActionError(null);
    setActionSuccess(null);

    if (!user) {
      setFormError('Sign in with Google first to create and manage a market in Cloud Firestore.');
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

    setCreating(true);
    try {
      const uidFragment = user.uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'host';
      const creatorId = `creator_${uidFragment}`;
      const creatorDisplayName = (user.displayName || 'Market Host').slice(0, 80);
      const creatorHandle = sanitizeHandle(
        user.email?.split('@')[0] || user.displayName || `host_${uidFragment.slice(0, 6)}`
      );

      // Step 1: Ensure creator profile exists in Cloud Firestore prior to market creation
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

      // Step 2: Provision shielded pool address via zingo-cli when available, with graceful fallback
      const shortSuffix = Math.random().toString(36).slice(2, 8);
      const marketId = `mkt_${Date.now().toString(36)}_${shortSuffix}`;
      const slug = slugifyQuestion(cleanQuestion, shortSuffix);
      const closesAtIso = new Date(Date.now() + safeSeconds * 1000).toISOString();

      let shieldedPoolAddress = '';
      let source: 'zingo-cli' | 'preview' = 'preview';
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
        // Preview environment without local zingo-cli falls back below
      }

      if (!shieldedPoolAddress) {
        const fallbackPrefix = cleanAddress.startsWith('utest1') ? 'utest1' : 'u1';
        shieldedPoolAddress = buildFallbackPoolAddress(marketId, fallbackPrefix);
      }

      const initialSidePool = zecToZatoshis(5.0);
      const description = `Creator-hosted Zcash prediction market closing ${new Date(closesAtIso).toUTCString()}.`;
      const resolutionCriteria = `Market creator (${creatorDisplayName}) resolves YES or NO upon outcome verification before ${closesAtIso}.`;

      // Step 3: Persist market to Cloud Firestore
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

      // Step 4: Mirror to Express store for /api/markets & zingo-cli resolution support
      const nowIso = new Date().toISOString();
      const createdMarket: MarketWithDetails = {
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
          ownerUid: user.uid,
          creatorDisplayName,
          creatorHandle,
          creatorPayoutAddress: cleanAddress,
          question: cleanQuestion,
          description,
          resolutionCriteria,
          category,
          shieldedPoolAddress,
          duration: durationHoursFloat,
          closesAt: closesAtIso,
        }),
      }).then(() => onRefresh?.());

      setLocalActiveSnapshot(createdMarket);
      setActiveMarketId(marketId);
      setWalletProvisionSource(source);
      setQuestion('');
      setActionSuccess(
        source === 'zingo-cli'
          ? 'Market created and shielded pool address provisioned via zingo-cli.'
          : 'Market created in Cloud Firestore with Testnet pool address.'
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
      const marketRef = doc(db, 'markets', activeMarket.id);
      try {
        await updateDoc(marketRef, {
          status: MarketStatus.Locked,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `markets/${activeMarket.id}`);
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

      let payoutMessage = `Market resolved as ${selectedWinner}.`;
      try {
        const res = await fetch(`/api/markets/${encodeURIComponent(activeMarket.id)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ winningOutcome: selectedWinner }),
        });
        if (res.ok) {
          const data = (await res.json()) as { payoutNote?: string };
          if (data.payoutNote) {
            payoutMessage = `Market resolved as ${selectedWinner}. ${data.payoutNote}`;
          }
        }
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
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
        <div className="space-y-2 max-w-2xl">
          <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
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
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 hover:text-slate-900 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Create Another Market</span>
          </button>
        )}
      </section>

      {/* Sign-in Prompt if Unauthenticated */}
      {!user && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-semibold text-slate-900">
              Sign in with Google to Host Markets
            </h2>
            <p className="text-sm text-slate-600">
              Cloud Firestore security rules require a verified Google account to publish, lock, and
              resolve markets.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Sign in with Google
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
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between gap-6">
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
                        Pool: {walletProvisionSource === 'zingo-cli' ? 'zingo-cli node' : 'Testnet preview'}
                      </span>
                    </>
                  )}
                </div>

                <h2 className="font-display text-2xl font-bold text-slate-900 leading-snug [text-wrap:balance]">
                  {activeMarket.question}
                </h2>

                {/* Market ID Copy Row */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-slate-500">Market ID</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy('market-id', activeMarket.id)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
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
                  <p className="font-mono text-sm font-semibold text-slate-900 break-all select-all">
                    {activeMarket.id}
                  </p>
                </div>

                {/* Live Pool Metrics */}
                <div className="grid grid-cols-3 gap-4 pt-2 border-t border-slate-100 font-mono tabular-nums">
                  <div>
                    <p className="font-sans text-xs text-slate-500">YES Odds</p>
                    <p className="text-lg font-semibold text-emerald-700">
                      {activeMarket.yesProbability.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="font-sans text-xs text-slate-500">NO Odds</p>
                    <p className="text-lg font-semibold text-rose-700">
                      {activeMarket.noProbability.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="font-sans text-xs text-slate-500">Pool Liquidity</p>
                    <p className="text-lg font-semibold text-slate-900">
                      {formatZec(activeMarket.liquidityZatoshis, 1)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Two Massive Host Action Buttons */}
              <div className="pt-4 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => void handleLockBetting()}
                  disabled={
                    locking ||
                    activeMarket.status === MarketStatus.Locked ||
                    activeMarket.status === MarketStatus.Resolved
                  }
                  className="w-full py-4 px-5 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed text-amber-950 font-display text-base font-bold transition-colors duration-150 flex items-center justify-center gap-2.5 whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
                >
                  <Lock className="w-5 h-5 text-amber-700 shrink-0" aria-hidden="true" />
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
                  className="w-full py-4 px-5 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-display text-base font-bold transition-colors duration-150 flex items-center justify-center gap-2.5 whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
                >
                  <Trophy className="w-5 h-5 text-amber-400 shrink-0" aria-hidden="true" />
                  <span>
                    {activeMarket.status === MarketStatus.Resolved
                      ? `🏆 Resolved: ${activeMarket.winningOutcome}`
                      : '🏆 Resolve Market'}
                  </span>
                </button>
              </div>
            </div>

            {/* Right: QR Code Link to Join */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col items-center justify-between gap-5 text-center">
              <div className="space-y-1">
                <h3 className="font-display text-base font-semibold text-slate-900">
                  QR Code Link to Join
                </h3>
                <p className="text-xs text-slate-500">
                  Scan to open this market directly and place a shielded YES or NO bet.
                </p>
              </div>

              <div className="p-4 bg-white border border-slate-200 rounded-xl">
                <QRCodeSVG
                  value={joinUrl}
                  size={208}
                  level="M"
                  includeMargin={false}
                  bgColor="#ffffff"
                  fgColor="#0f172a"
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
                    className="w-full py-2 px-4 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Open Player Betting Room</span>
                  </button>
                )}

                {onOpenMarketModal && (
                  <button
                    type="button"
                    onClick={() => onOpenMarketModal(activeMarket)}
                    className="w-full py-2 px-4 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 hover:text-slate-900 transition-colors duration-150 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Preview Bettor ZIP-321 Drawer</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* CREATE SCREEN */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={(e) => void handleCreateMarket(e)}
            className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-5"
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
              <div className="flex items-center justify-between text-xs">
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
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 whitespace-nowrap cursor-pointer ${
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
                  className="w-24 px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
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
                  className="px-2.5 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
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
              <div className="flex items-center justify-between gap-2 text-xs">
                <label htmlFor="creator-u1-address" className="font-medium text-slate-700">
                  Creator Payout Address (u1... / utest1...)
                </label>
                <button
                  type="button"
                  onClick={handleFillSampleAddress}
                  className="text-xs font-medium text-amber-700 hover:text-amber-800 cursor-pointer"
                >
                  {existingUserCreator?.zcashUnifiedAddress
                    ? 'Use My Saved Address'
                    : 'Fill Sample u1... Address'}
                </button>
              </div>
              <input
                id="creator-u1-address"
                type="text"
                required
                value={payoutAddress}
                onChange={(e) => setPayoutAddress(e.target.value)}
                placeholder="u1... or utest1..."
                className="w-full px-3.5 py-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              />
            </div>

            {/* Category */}
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-slate-700">Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as MarketCategory)}
                className="w-full px-3.5 py-2 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </label>

            <div className="pt-2">
              <button
                type="submit"
                disabled={creating || !user}
                className="w-full py-3 px-5 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors duration-150 inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>{creating ? 'Creating Market...' : 'Launch Prediction Market'}</span>
              </button>
            </div>
          </form>

          {/* Right Column: Hosted Markets Switcher */}
          <aside className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
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
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="resolve-modal-title"
        >
          <div
            onClick={() => !resolving && setResolveModalOpen(false)}
            className="fixed inset-0 bg-slate-900/45 backdrop-blur-[1px]"
          />

          <div className="relative z-10 w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-5 shadow-xl">
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
                className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg cursor-pointer"
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
                className={`py-4 px-4 rounded-xl border-2 font-display text-base font-bold transition-colors duration-150 cursor-pointer ${
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
                className={`py-4 px-4 rounded-xl border-2 font-display text-base font-bold transition-colors duration-150 cursor-pointer ${
                  selectedWinner === OutcomeSide.No
                    ? 'border-rose-600 bg-rose-50 text-rose-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }`}
              >
                NO Won
              </button>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={resolving}
                onClick={() => setResolveModalOpen(false)}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={resolving}
                onClick={() => void handleConfirmResolve()}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg cursor-pointer"
              >
                {resolving ? 'Resolving...' : `Confirm ${selectedWinner} Winner`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

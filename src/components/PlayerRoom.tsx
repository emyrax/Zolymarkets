/**
 * Zolymarket — Phase 5 Mobile-First Player Betting Interface (/room/[id])
 *
 * Loads live market state from Cloud Firestore (with `/api/markets/:id` fallback),
 * disables inputs when LOCKED or RESOLVED, persists the player's `u1...` return
 * address in `localStorage`, generates Base64URL ZIP-321 QR payment requests,
 * and subscribes to Cloud Firestore `shielded_bets` for instant mempool lock toasts.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trophy,
  X,
} from 'lucide-react';
import {
  Timestamp,
  collection,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { OperationType, db, handleFirestoreError } from '../lib/firebase.ts';
import {
  calculateBinaryOdds,
  estimateSharesOut,
  formatZec,
  zatoshisToZec,
  zecToZatoshis,
} from '../lib/cpmm.ts';
import { buildPlayerBetZip321Uri } from '../lib/zip321.ts';
import { buildPollarPaymentParams } from '../lib/pollar-assets.ts';
import { usePollarBridge } from '../contexts/PollarBridgeProvider.tsx';
import { useChains, usePollar } from '@pollar/react';
import { WalletChain } from '@pollar/core';
import { MarketCountdown } from './MarketCountdown.tsx';
import { SentimentTrendChart } from './SentimentTrendChart.tsx';
import {
  Creator,
  MarketCategory,
  MarketStatus,
  MarketWithDetails,
  OutcomeSide,
  ShieldedBet,
} from '../types/database.ts';

import { Zip321RoomPrefill } from './Zip321ScannerModal.tsx';

interface PlayerRoomProps {
  roomId: string;
  markets: MarketWithDetails[];
  creators: Creator[];
  initialPrefill?: Zip321RoomPrefill | null;
  onBackToMarkets: () => void;
}

const RETURN_ADDRESS_STORAGE_KEY = 'zolymarket_player_return_addr_v1';
const ZCASH_ADDRESS_REGEX = /^(u1|uregtest1|utest1|zs1)[0-9a-zA-Z]{16,252}$/;
const QUICK_AMOUNTS = ['0.1', '0.5', '1.0', '5.0'];

function toIsoString(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string') {
    return val;
  }
  return new Date().toISOString();
}

export const PlayerRoom: React.FC<PlayerRoomProps> = ({
  roomId,
  markets,
  creators,
  initialPrefill,
  onBackToMarkets,
}) => {
  const [firestoreMarket, setFirestoreMarket] = useState<MarketWithDetails | null>(null);
  const [apiMarket, setApiMarket] = useState<MarketWithDetails | null>(null);
  const [loadingMarket, setLoadingMarket] = useState<boolean>(true);
  const [marketLoadError, setMarketLoadError] = useState<string | null>(null);

  // Betting input form state
  const [side, setSide] = useState<OutcomeSide>(initialPrefill?.side ?? OutcomeSide.Yes);
  const [amountInput, setAmountInput] = useState<string>(
    initialPrefill?.amountZec ? String(initialPrefill.amountZec) : '0.5'
  );
  const [returnAddr, setReturnAddr] = useState<string>(() => {
    if (initialPrefill?.returnAddr) return initialPrefill.returnAddr;
    try {
      return localStorage.getItem(RETURN_ADDRESS_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });

  // Realtime shielded_bets state + mempool lock toast
  const [roomBets, setRoomBets] = useState<ShieldedBet[]>([]);
  const [toastBet, setToastBet] = useState<{
    txid: string;
    pick: OutcomeSide;
    amountZatoshis: number;
  } | null>(null);
  const [pollingMempool, setPollingMempool] = useState<boolean>(false);
  const [pollNote, setPollNote] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Pollar Multichain Instant Settlement Rail
  const [checkoutRail, setCheckoutRail] = useState<'zcash' | 'pollar'>('zcash');
  const [pollarChain, setPollarChain] = useState<WalletChain>('STELLAR');
  const [pollarDestination, setPollarDestination] = useState<string>('');
  const [pollarAmount, setPollarAmount] = useState<string>('5.00');
  const [pollarSending, setPollarSending] = useState<boolean>(false);
  const [pollarStatusMsg, setPollarStatusMsg] = useState<{
    ok: boolean;
    text: string;
    hash?: string;
  } | null>(null);

  const { publishableConfigured, targetNetwork } = usePollarBridge();
  const {
    isAuthenticated: pollarAuthed,
    network: pollarNetwork,
    login: pollarLogin,
    openLoginModal: openPollarLogin,
    openRampModal: openPollarRamp,
    openSwapModal: openPollarSwap,
    sendPayment: pollarSendPayment,
  } = usePollar();
  const { primaryAddress: pollarPrimaryAddr, chains: pollarChains } = useChains();

  const initializedBetsRef = useRef<boolean>(false);
  const seenBetIdsRef = useRef<Set<string>>(new Set());

  // Persist returnAddr in localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem(RETURN_ADDRESS_STORAGE_KEY, returnAddr);
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }, [returnAddr]);

  // Match from already-loaded markets list (supports id or slug)
  const listMatchedMarket = useMemo(
    () => markets.find((m) => m.id === roomId || m.slug === roomId) ?? null,
    [markets, roomId]
  );

  // Direct Cloud Firestore subscription to markets/{roomId} + Express fallback
  useEffect(() => {
    setLoadingMarket(true);
    setMarketLoadError(null);
    setFirestoreMarket(null);
    setApiMarket(null);

    let active = true;
    const targetDocId = listMatchedMarket?.id ?? roomId;

    // Fetch from Express API fallback (also supports slugs and unseeded preview)
    fetch(`/api/markets/${encodeURIComponent(roomId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { market?: MarketWithDetails; bets?: ShieldedBet[] } | null) => {
        if (!active) return;
        if (data?.market) {
          setApiMarket(data.market);
        }
        if (data?.bets && data.bets.length > 0) {
          setRoomBets(data.bets);
        }
      })
      .catch(() => {
        // Ignore API fallback error
      })
      .finally(() => {
        if (active) setLoadingMarket(false);
      });

    const marketDocRef = doc(db, 'markets', targetDocId);
    const unsubMarket = onSnapshot(
      marketDocRef,
      (docSnap) => {
        if (!active) return;
        if (!docSnap.exists()) {
          setLoadingMarket(false);
          return;
        }
        const d = docSnap.data();
        const id = String(d.id || docSnap.id);
        const creatorId = String(d.creatorId || '');
        const creator =
          creators.find((c) => c.id === creatorId) ?? {
            id: creatorId,
            handle: 'creator',
            displayName: 'Zcash Creator',
            bio: '',
            zcashUnifiedAddress: '',
            verified: false,
            marketsCreatedCount: 0,
            totalVolumeZatoshis: 0,
            createdAt: toIsoString(d.createdAt),
          };

        const yesPool = Number(d.yesPoolZatoshis || 500_000_000);
        const noPool = Number(d.noPoolZatoshis || 500_000_000);
        const { yesProbability, noProbability } = calculateBinaryOdds(yesPool, noPool);
        const yesProb24h = Number(d.yesProbability24hAgo ?? yesProbability);
        const change24hPct = Math.round((yesProbability - yesProb24h) * 10) / 10;
        const updatedAt = toIsoString(d.updatedAt);

        setFirestoreMarket({
          id,
          slug: String(d.slug || id),
          creatorId,
          ownerUid: typeof d.ownerUid === 'string' ? d.ownerUid : undefined,
          question: String(d.question || ''),
          description: String(d.description || ''),
          resolutionCriteria: String(d.resolutionCriteria || ''),
          category: (d.category as MarketCategory) || MarketCategory.CreatorBets,
          status: (d.status as MarketStatus) || MarketStatus.Open,
          shieldedPoolAddress: String(d.shieldedPoolAddress || ''),
          creatorFeeBps: Number(d.creatorFeeBps ?? 150),
          totalVolumeZatoshis: Number(d.totalVolumeZatoshis ?? 0),
          liquidityZatoshis: Number(d.liquidityZatoshis ?? yesPool + noPool),
          yesProbability24hAgo: yesProb24h,
          winningOutcome: (d.winningOutcome as OutcomeSide | null) ?? null,
          duration:
            typeof d.duration === 'number' && Number.isFinite(d.duration)
              ? d.duration
              : undefined,
          closesAt: String(d.closesAt || ''),
          resolvedAt: d.resolvedAt ? String(d.resolvedAt) : null,
          createdAt: toIsoString(d.createdAt),
          updatedAt,
          creator,
          outcomes: {
            yes: {
              id: `${id}-yes`,
              marketId: id,
              side: OutcomeSide.Yes,
              poolZatoshis: yesPool,
              sharesOutstanding: Number(d.yesSharesOutstanding ?? 0),
              updatedAt,
            },
            no: {
              id: `${id}-no`,
              marketId: id,
              side: OutcomeSide.No,
              poolZatoshis: noPool,
              sharesOutstanding: Number(d.noSharesOutstanding ?? 0),
              updatedAt,
            },
          },
          yesProbability,
          noProbability,
          change24hPct,
        });
        setLoadingMarket(false);
      },
      (err) => {
        if (!active) return;
        try {
          handleFirestoreError(err, OperationType.GET, `markets/${targetDocId}`);
        } catch (wrapped) {
          setMarketLoadError(
            wrapped instanceof Error ? wrapped.message : 'Unable to load market.'
          );
        }
        setLoadingMarket(false);
      }
    );

    return () => {
      active = false;
      unsubMarket();
    };
  }, [roomId, listMatchedMarket?.id, creators]);

  const market = firestoreMarket ?? listMatchedMarket ?? apiMarket;

  // Realtime Cloud Firestore subscription to `shielded_bets` for this market
  useEffect(() => {
    if (!market?.id) return;

    initializedBetsRef.current = false;
    seenBetIdsRef.current = new Set();

    const betsQuery = query(
      collection(db, 'shielded_bets'),
      where('marketId', '==', market.id)
    );

    const unsubBets = onSnapshot(
      betsQuery,
      (snapshot) => {
        const docs: ShieldedBet[] = snapshot.docs.map((docSnap) => {
          const d = docSnap.data();
          const pick = d.pick === OutcomeSide.No ? OutcomeSide.No : OutcomeSide.Yes;
          return {
            id: String(d.id || docSnap.id),
            marketId: String(d.marketId || market.id),
            txid: String(d.txid || ''),
            poolType: d.poolType === 'sapling' ? 'sapling' : 'orchard',
            recipientAddress: String(d.recipientAddress || ''),
            pick,
            payoutTo: String(d.payoutTo || ''),
            amountZatoshis: Number(d.amountZatoshis || 0),
            rawMemoHex: String(d.rawMemoHex || ''),
            decodedMemoJson: (d.decodedMemo as ShieldedBet['decodedMemoJson']) ?? {
              q: market.id,
              pick,
              payout_to: String(d.payoutTo || ''),
            },
            confirmations: Number(d.confirmations || 0),
            createdAt: toIsoString(d.createdAt),
          };
        });

        docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        const cleanUserAddr = returnAddr.trim();

        if (!initializedBetsRef.current) {
          for (const bet of docs) {
            seenBetIdsRef.current.add(bet.id);
          }
          initializedBetsRef.current = true;
        } else {
          for (const bet of docs) {
            if (!seenBetIdsRef.current.has(bet.id)) {
              seenBetIdsRef.current.add(bet.id);
              if (cleanUserAddr && bet.payoutTo.trim() === cleanUserAddr) {
                setToastBet({
                  txid: bet.txid,
                  pick: bet.pick,
                  amountZatoshis: bet.amountZatoshis,
                });
              }
            }
          }
        }

        if (docs.length > 0) {
          setRoomBets(docs);
        }
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, 'shielded_bets');
        } catch (wrapped) {
          console.warn('shielded_bets subscription warning:', wrapped);
        }
      }
    );

    return () => {
      unsubBets();
    };
  }, [market?.id, returnAddr]);

  const isBettingDisabled =
    !market ||
    market.status === MarketStatus.Locked ||
    market.status === MarketStatus.Resolved ||
    market.status === MarketStatus.Cancelled;

  const parsedAmount = Number.parseFloat(amountInput);
  const validAmount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;
  const trimmedReturnAddr = returnAddr.trim();
  const isReturnAddrValid = ZCASH_ADDRESS_REGEX.test(trimmedReturnAddr);

  const zip321Result = useMemo(() => {
    if (!market || isBettingDisabled || validAmount <= 0 || !isReturnAddrValid) {
      return null;
    }
    try {
      return buildPlayerBetZip321Uri({
        marketAddress: market.shieldedPoolAddress,
        amountZec: validAmount,
        marketId: market.id,
        side,
        returnAddr: trimmedReturnAddr,
      });
    } catch {
      return null;
    }
  }, [market, isBettingDisabled, validAmount, isReturnAddrValid, side, trimmedReturnAddr]);

  const quote = useMemo(() => {
    if (!market || validAmount <= 0) return null;
    const isYes = side === OutcomeSide.Yes;
    return estimateSharesOut({
      amountZatoshis: zecToZatoshis(validAmount),
      targetPoolZatoshis: isYes
        ? market.outcomes.yes.poolZatoshis
        : market.outcomes.no.poolZatoshis,
      oppositePoolZatoshis: isYes
        ? market.outcomes.no.poolZatoshis
        : market.outcomes.yes.poolZatoshis,
      creatorFeeBps: market.creatorFeeBps,
    });
  }, [market, side, validAmount]);

  const matchingUserBets = useMemo(() => {
    if (!trimmedReturnAddr) return [];
    return roomBets.filter((b) => b.payoutTo.trim() === trimmedReturnAddr);
  }, [roomBets, trimmedReturnAddr]);

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handlePollMempool = async () => {
    if (!market) return;
    setPollingMempool(true);
    setPollNote(null);
    try {
      const res = await fetch('/api/zcash/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketId: market.id,
          address: market.shieldedPoolAddress,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        insertedBets?: ShieldedBet[];
        scannedNotesCount?: number;
      };
      if (!res.ok) {
        setPollNote(data.error || 'Mempool scan unavailable on this host.');
      } else {
        const count = data.insertedBets?.length ?? 0;
        if (count > 0 && data.insertedBets) {
          const matching = data.insertedBets.find(
            (b) => trimmedReturnAddr && b.payoutTo.trim() === trimmedReturnAddr
          );
          if (matching) {
            setToastBet({
              txid: matching.txid,
              pick: matching.pick,
              amountZatoshis: matching.amountZatoshis,
            });
          }
          setPollNote(`Synced ${count} new shielded bet(s) from zingo-cli.`);
        } else {
          setPollNote(
            `Scanned ${data.scannedNotesCount ?? 0} notes; waiting for matching shielded tx.`
          );
        }
      }
    } catch {
      setPollNote('Unable to reach /api/zcash/poll.');
    } finally {
      setPollingMempool(false);
    }
  };

  const handlePollarBetPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!market || isBettingDisabled) return;
    setPollarStatusMsg(null);

    if (!publishableConfigured) {
      setPollarStatusMsg({
        ok: false,
        text: 'Configure VITE_POLLAR_PUBLISHABLE_KEY in your environment to submit Pollar transactions.',
      });
      return;
    }
    if (!pollarAuthed) {
      openPollarLogin();
      return;
    }
    if (!pollarDestination.trim()) {
      setPollarStatusMsg({
        ok: false,
        text: `Enter the host's ${pollarChain} settlement address.`,
      });
      return;
    }

    setPollarSending(true);
    try {
      const params = buildPollarPaymentParams({
        chain: pollarChain,
        network: pollarNetwork || targetNetwork,
        destination: pollarDestination,
        amount: pollarAmount,
        assetKind: 'USDC',
        memoText: `${market.id}:${side}`.slice(0, 28),
      });
      const outcome = await pollarSendPayment(params);
      if (outcome.status === 'success' || outcome.status === 'pending') {
        setPollarStatusMsg({
          ok: true,
          text:
            outcome.status === 'success'
              ? `USDC bet confirmed on ${pollarChain} for ${side}.`
              : `USDC bet submitted on ${pollarChain}; awaiting finality.`,
          hash: outcome.hash,
        });
      } else if (outcome.status === 'cosign_pending') {
        setPollarStatusMsg({
          ok: true,
          text: 'Awaiting your co-sign confirmation inside the Pollar approval modal.',
        });
      } else {
        setPollarStatusMsg({
          ok: false,
          text: outcome.message || outcome.details || 'Pollar payment failed.',
          hash: outcome.hash,
        });
      }
    } catch (err) {
      setPollarStatusMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Unable to complete Pollar transfer.',
      });
    } finally {
      setPollarSending(false);
    }
  };

  if (loadingMarket && !market) {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={onBackToMarkets}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 min-h-[44px] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to Markets</span>
        </button>
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 animate-pulse">
          <div className="h-4 w-40 bg-slate-200 rounded" />
          <div className="h-7 w-3/4 bg-slate-200 rounded" />
          <div className="h-40 w-full bg-slate-100 rounded" />
        </div>
      </div>
    );
  }

  if (!market) {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={onBackToMarkets}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 min-h-[44px] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to Markets</span>
        </button>
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
          <AlertTriangle className="w-6 h-6 text-amber-600 mx-auto" aria-hidden="true" />
          <h1 className="font-display text-xl font-bold text-slate-900">
            Betting Room Not Found
          </h1>
          <p className="text-sm text-slate-600">
            {marketLoadError || `No market found for room ID "${roomId}".`}
          </p>
          <button
            type="button"
            onClick={onBackToMarkets}
            className="px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
          >
            Browse Open Markets
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      {/* Realtime Success Toast */}
      {toastBet && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:bottom-6 sm:max-w-sm z-50 bg-slate-900 text-white border border-emerald-500/50 rounded-xl p-4 shadow-xl flex items-start justify-between gap-3"
        >
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-0.5 text-xs">
              <p className="font-display text-sm font-bold text-white">
                🔒 Bet Locked! in Mempool
              </p>
              <p className="text-slate-300 font-mono tabular-nums">
                {zatoshisToZec(toastBet.amountZatoshis).toFixed(4)} ZEC on {toastBet.pick}
              </p>
              {toastBet.txid && (
                <p className="text-slate-400 font-mono truncate max-w-[230px]">
                  txid: {toastBet.txid}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setToastBet(null)}
            aria-label="Dismiss notification"
            className="p-1 text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Top Back Navigation & Room ID */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBackToMarkets}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 min-h-[44px] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to Markets</span>
        </button>

        <span className="text-xs font-mono text-slate-500 truncate max-w-full">
          Room: {market.id}
        </span>
      </div>

      {/* Market Header Summary */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-700">{market.category}</span>
            <span aria-hidden="true">·</span>
            <span>@{market.creator.handle}</span>
          </div>
          <MarketCountdown market={market} variant="card" />
        </div>

        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
          {market.question}
        </h1>

        <div className="grid grid-cols-3 gap-4 pt-3 border-t border-slate-100 font-mono tabular-nums">
          <div>
            <p className="font-sans text-xs text-slate-500">YES Odds</p>
            <p className="text-lg font-semibold text-emerald-700">
              {market.yesProbability.toFixed(1)}%
            </p>
          </div>
          <div>
            <p className="font-sans text-xs text-slate-500">NO Odds</p>
            <p className="text-lg font-semibold text-rose-700">
              {market.noProbability.toFixed(1)}%
            </p>
          </div>
          <div>
            <p className="font-sans text-xs text-slate-500">Volume</p>
            <p className="text-lg font-semibold text-slate-900">
              {formatZec(market.totalVolumeZatoshis, 2)}
            </p>
          </div>
        </div>
      </section>

      {/* Locked / Resolved Banner */}
      {isBettingDisabled && (
        <section className="p-4 sm:p-5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3 text-sm text-amber-950">
          {market.status === MarketStatus.Resolved ? (
            <Trophy className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
          ) : (
            <Lock className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
          )}
          <div className="space-y-1">
            <p className="font-semibold">
              {market.status === MarketStatus.Resolved
                ? `Market Resolved — Winning Outcome: ${market.winningOutcome ?? 'Settled'}`
                : market.status === MarketStatus.Locked
                ? 'Betting is Locked'
                : 'Market Cancelled'}
            </p>
            <p className="text-xs text-amber-900">
              Betting inputs and QR payment generation are disabled while this market is{' '}
              {market.status.toUpperCase()}.
            </p>
          </div>
        </section>
      )}

      {/* Mobile-First 2-Column Responsive Betting Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Player Input Form */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Place Shielded Bet
            </h2>
            <p className="text-xs text-slate-500">
              Pick YES or NO, set your ZEC stake, and provide your shielded payout address.
            </p>
          </div>

          {/* YES / NO Toggle */}
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-slate-700">1. Select Outcome</span>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isBettingDisabled}
                onClick={() => setSide(OutcomeSide.Yes)}
                className={`min-h-[52px] px-4 py-3 rounded-xl border-2 font-display text-base font-bold transition-colors duration-150 flex items-center justify-between cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  side === OutcomeSide.Yes
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }`}
              >
                <span>YES</span>
                <span className="font-mono text-sm tabular-nums">
                  {market.yesProbability.toFixed(1)}%
                </span>
              </button>

              <button
                type="button"
                disabled={isBettingDisabled}
                onClick={() => setSide(OutcomeSide.No)}
                className={`min-h-[52px] px-4 py-3 rounded-xl border-2 font-display text-base font-bold transition-colors duration-150 flex items-center justify-between cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  side === OutcomeSide.No
                    ? 'border-rose-600 bg-rose-50 text-rose-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }`}
              >
                <span>NO</span>
                <span className="font-mono text-sm tabular-nums">
                  {market.noProbability.toFixed(1)}%
                </span>
              </button>
            </div>
          </div>

          {/* Amount Input */}
          <div className="space-y-2">
            <label
              htmlFor="player-bet-amount"
              className="block text-xs font-medium text-slate-700"
            >
              2. Bet Amount (ZEC)
            </label>
            <input
              id="player-bet-amount"
              type="number"
              min="0.001"
              step="0.01"
              disabled={isBettingDisabled}
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              className="w-full min-h-[48px] px-3.5 py-2.5 text-base font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <div className="grid grid-cols-4 gap-2">
              {QUICK_AMOUNTS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={isBettingDisabled}
                  onClick={() => setAmountInput(preset)}
                  className={`min-h-[40px] py-2 text-xs font-mono font-medium rounded-lg border transition-colors duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    amountInput === preset
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {preset} ZEC
                </button>
              ))}
            </div>
            {quote && (
              <div className="pt-1 flex items-center justify-between text-xs font-mono tabular-nums text-slate-600">
                <span>Est. Shares: {quote.sharesOut.toFixed(4)}</span>
                <span>Creator Fee: {formatZec(quote.feeZatoshis, 4)}</span>
              </div>
            )}
          </div>

          {/* Return Address Input (persisted in localStorage) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="player-return-addr" className="font-medium text-slate-700">
                3. Your Return / Payout Address (u1... / utest1...)
              </label>
              <span className="text-slate-400">Saved locally</span>
            </div>
            <input
              id="player-return-addr"
              type="text"
              disabled={isBettingDisabled}
              value={returnAddr}
              onChange={(e) => setReturnAddr(e.target.value)}
              placeholder="u1... or utest1..."
              className="w-full min-h-[48px] px-3.5 py-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {trimmedReturnAddr.length > 0 && !isReturnAddrValid && (
              <p className="text-xs text-rose-700">
                Enter a valid Zcash shielded address starting with u1, utest1, uregtest1, or zs1
                (minimum 20 characters).
              </p>
            )}
          </div>
        </section>

        {/* Right: Dual Checkout Rail (ZIP-321 Shielded + Pollar Instant USDC) */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setCheckoutRail('zcash')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  checkoutRail === 'zcash'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Zcash ZIP-321
              </button>
              <button
                type="button"
                onClick={() => setCheckoutRail('pollar')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  checkoutRail === 'pollar'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Pollar USDC
              </button>
            </div>

            {checkoutRail === 'zcash' && (
              <button
                type="button"
                onClick={() => void handlePollMempool()}
                disabled={pollingMempool}
                className="min-h-[40px] px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${pollingMempool ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>{pollingMempool ? 'Scanning...' : 'Scan Mempool'}</span>
              </button>
            )}
          </div>

          {checkoutRail === 'zcash' ? (
            <>
              <div className="space-y-1">
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  ZIP-321 Shielded Checkout
                </h2>
                <p className="text-xs text-slate-500">
                  Scan with Zashi or any ZIP-321 wallet to broadcast your shielded bet.
                </p>
              </div>

              {pollNote && (
                <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  {pollNote}
                </p>
              )}

              {isBettingDisabled ? (
                <div className="p-8 bg-slate-50 border border-slate-200 rounded-xl text-center text-xs text-slate-500">
                  QR checkout is disabled because this market is {market.status}.
                </div>
              ) : !zip321Result ? (
                <div className="p-8 bg-slate-50 border border-slate-200 rounded-xl text-center space-y-2">
                  <p className="text-sm font-medium text-slate-800">
                    Enter a valid amount and u1... return address
                  </p>
                  <p className="text-xs text-slate-500">
                    Your ZIP-321 QR code and Base64URL memo will appear here immediately.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-col items-center justify-center p-5 bg-white border border-slate-200 rounded-xl">
                    <QRCodeSVG
                      value={zip321Result.uri}
                      size={220}
                      level="M"
                      includeMargin={false}
                      bgColor="#ffffff"
                      fgColor="#0f172a"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <a
                      href={zip321Result.uri}
                      className="min-h-[48px] px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors duration-150"
                    >
                      <ExternalLink className="w-4 h-4" aria-hidden="true" />
                      <span>Open in Zcash Wallet</span>
                    </a>

                    <button
                      type="button"
                      onClick={() => void handleCopy('zip321-uri', zip321Result.uri)}
                      className="min-h-[48px] px-4 py-3 rounded-xl bg-white border border-slate-200 hover:border-slate-300 text-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors duration-150 cursor-pointer"
                    >
                      {copiedKey === 'zip321-uri' ? (
                        <>
                          <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                          <span>Copied URI</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4" aria-hidden="true" />
                          <span>Copy ZIP-321 URI</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                    <div>
                      <span className="font-medium text-slate-500">ZIP-321 URI</span>
                      <p className="font-mono text-slate-800 break-all mt-0.5 select-all">
                        {zip321Result.uri}
                      </p>
                    </div>
                    <div className="pt-2 border-t border-slate-200/70">
                      <span className="font-medium text-slate-500">Encoded JSON Memo</span>
                      <p className="font-mono text-slate-700 break-all mt-0.5">
                        {zip321Result.memoJson}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  Pollar Instant USDC Checkout
                </h2>
                <p className="text-xs text-slate-500">
                  Pay sponsored USDC directly on Stellar, Solana, or Polygon with social login and
                  built-in fiat on-ramps—zero VPS required.
                </p>
              </div>

              {!publishableConfigured && (
                <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
                  Set <span className="font-mono">VITE_POLLAR_PUBLISHABLE_KEY</span> in environment
                  secrets to activate live Pollar wallet sign-in and sponsored USDC transfers.
                </div>
              )}

              {!pollarAuthed ? (
                <div className="p-5 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <p className="text-xs text-slate-600">
                    Sign in with Google, Email OTP, or Passkey to unlock your multichain USDC
                    wallet.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={!publishableConfigured || isBettingDisabled}
                      onClick={() => pollarLogin({ provider: 'google' })}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg cursor-pointer"
                    >
                      Continue with Google
                    </button>
                    <button
                      type="button"
                      disabled={!publishableConfigured || isBettingDisabled}
                      onClick={() => openPollarLogin()}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 disabled:opacity-50 rounded-lg cursor-pointer"
                    >
                      Email / Passkey
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={(e) => void handlePollarBetPayment(e)} className="space-y-4">
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800">Connected Pollar Wallet</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openPollarRamp()}
                          className="text-amber-700 hover:text-amber-800 font-semibold cursor-pointer"
                        >
                          Cash In
                        </button>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <button
                          type="button"
                          onClick={() => openPollarSwap()}
                          className="text-slate-700 hover:text-slate-900 font-semibold cursor-pointer"
                        >
                          Swap
                        </button>
                      </div>
                    </div>
                    {pollarPrimaryAddr && (
                      <p className="font-mono text-slate-600 truncate">{pollarPrimaryAddr}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {(pollarChains.length > 0
                      ? pollarChains
                      : (['STELLAR', 'SOLANA', 'POLYGON'] as WalletChain[])
                    ).map((ch) => (
                      <button
                        key={ch}
                        type="button"
                        disabled={isBettingDisabled}
                        onClick={() => setPollarChain(ch)}
                        className={`min-h-[40px] py-2 text-xs font-semibold rounded-lg border cursor-pointer disabled:opacity-50 ${
                          pollarChain === ch
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        {ch}
                      </button>
                    ))}
                  </div>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">
                      Host {pollarChain} Escrow / Payout Address
                    </span>
                    <input
                      type="text"
                      disabled={isBettingDisabled}
                      value={pollarDestination}
                      onChange={(e) => setPollarDestination(e.target.value)}
                      placeholder={
                        pollarChain === 'STELLAR'
                          ? 'G... Stellar address'
                          : pollarChain === 'SOLANA'
                          ? 'Solana public key'
                          : '0x... Polygon address'
                      }
                      className="w-full min-h-[44px] px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white disabled:opacity-50"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">
                      USDC Stake for {side}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      disabled={isBettingDisabled}
                      value={pollarAmount}
                      onChange={(e) => setPollarAmount(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white disabled:opacity-50"
                    />
                  </label>

                  <button
                    type="submit"
                    disabled={isBettingDisabled || pollarSending}
                    className="w-full min-h-[48px] px-4 py-3 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-xl cursor-pointer"
                  >
                    {pollarSending
                      ? `Sending ${pollarAmount} USDC on ${pollarChain}...`
                      : `Send ${pollarAmount || '0'} USDC on ${pollarChain} (${side})`}
                  </button>
                </form>
              )}

              {pollarStatusMsg && (
                <div
                  className={`p-3 rounded-lg border text-xs space-y-1 ${
                    pollarStatusMsg.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-rose-50 border-rose-200 text-rose-800'
                  }`}
                >
                  <p className="font-semibold">{pollarStatusMsg.text}</p>
                  {pollarStatusMsg.hash && (
                    <p className="font-mono break-all text-[11px]">
                      Hash: {pollarStatusMsg.hash}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Live Matching Bets Status */}
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-600">
                Your Detected Shielded Bets ({matchingUserBets.length})
              </span>
              <span className="text-slate-400">Listening on Firestore shielded_bets</span>
            </div>

            {matchingUserBets.length === 0 ? (
              <p className="text-xs text-slate-500">
                {isReturnAddrValid
                  ? 'Waiting for an unspent Orchard/Sapling note with your payout_to address...'
                  : 'Enter your return address above to watch for incoming confirmations.'}
              </p>
            ) : (
              <ul className="space-y-2">
                {matchingUserBets.map((bet) => (
                  <li
                    key={bet.id}
                    className="p-3 bg-emerald-50/70 border border-emerald-200 rounded-lg flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <CheckCircle2
                        className="w-4 h-4 text-emerald-700 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="font-medium text-emerald-900 truncate font-mono">
                        {bet.pick} · {zatoshisToZec(bet.amountZatoshis).toFixed(4)} ZEC
                      </span>
                    </div>
                    <span className="font-mono text-emerald-800 shrink-0">
                      {bet.confirmations} conf
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* Market Sentiment Chart & Countdown */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
          <SentimentTrendChart market={market} />
        </div>
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
          <MarketCountdown market={market} variant="drawer" />
          <div className="space-y-1.5 pt-2 border-t border-slate-100">
            <h3 className="text-xs font-semibold text-slate-500">Resolution Criteria</h3>
            <p className="text-sm text-slate-700 leading-relaxed">{market.resolutionCriteria}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

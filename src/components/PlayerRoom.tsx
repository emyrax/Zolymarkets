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
import { buildPlayerBetZip321Uri, utf8ToHex } from '../lib/zip321.ts';
import {
  formatShortTxid,
  generateSampleTestnetUnifiedAddress,
  getZcashTxExplorerUrls,
  isValidOnChainTxid,
  normalizeOnChainTxid,
} from '../lib/explorers.ts';
import { buildPollarPaymentParams } from '../lib/pollar-assets.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
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
  onOpenScanner?: () => void;
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
  onOpenScanner,
}) => {
  const { walletSession, openAuthModal } = useAuth();
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
    if (walletSession?.rail === 'zcash') return walletSession.address;
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

  // Direct On-Chain Bet Transaction Verification (Zingo Testnet)
  const [betTxidInput, setBetTxidInput] = useState<string>(initialPrefill?.txid || '');
  const [verifyingBetTx, setVerifyingBetTx] = useState<boolean>(false);
  const [betVerifyResult, setBetVerifyResult] = useState<{
    ok: boolean;
    message: string;
    txid?: string;
    explorerUrl?: string;
    secondaryExplorerUrl?: string;
  } | null>(null);

  // Pollar & Polygon Settlement Rail
  const [checkoutRail, setCheckoutRail] = useState<'zcash' | 'pollar'>(
    initialPrefill?.rail === 'pollar' || walletSession?.rail === 'polygon' ? 'pollar' : 'zcash'
  );
  const [pollarChain, setPollarChain] = useState<WalletChain>(
    walletSession?.rail === 'polygon' ? 'POLYGON' : 'STELLAR'
  );
  const [pollarDestination, setPollarDestination] = useState<string>('');
  const [pollarAmount, setPollarAmount] = useState<string>('5.00');
  const [pollarSending, setPollarSending] = useState<boolean>(false);
  const [pollarStatusMsg, setPollarStatusMsg] = useState<{
    ok: boolean;
    text: string;
    hash?: string;
  } | null>(null);

  const {
    publishableConfigured,
    targetNetwork,
    pollarAuthError,
    clearPollarAuthError,
  } = usePollarBridge();
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

  // Persist returnAddr in localStorage on change & sync Zcash wallet session
  useEffect(() => {
    try {
      localStorage.setItem(RETURN_ADDRESS_STORAGE_KEY, returnAddr);
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }, [returnAddr]);

  useEffect(() => {
    if (walletSession?.rail === 'zcash' && !returnAddr.trim()) {
      setReturnAddr(walletSession.address);
    }
  }, [walletSession, returnAddr]);

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
          creationTxid:
            listMatchedMarket?.creationTxid ??
            (typeof d.creationTxid === 'string' ? d.creationTxid : null),
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
          setRoomBets((prev) => {
            const seen = new Set(docs.map((d) => d.txid.toLowerCase()));
            const extraLocal = prev.filter((p) => !seen.has(p.txid.toLowerCase()));
            return [...docs, ...extraLocal].sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt)
            );
          });
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

  const handleRecordAndVerifyBetTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!market || isBettingDisabled) return;

    setBetVerifyResult(null);
    const rawTxid = betTxidInput.trim();
    if (!isValidOnChainTxid(rawTxid)) {
      setBetVerifyResult({
        ok: false,
        message: 'Enter a valid 64-character hex Zcash Transaction ID (txid) from Zingo Testnet.',
      });
      return;
    }
    if (validAmount <= 0) {
      setBetVerifyResult({
        ok: false,
        message: 'Enter a positive ZEC bet amount in Step 2 before verifying.',
      });
      return;
    }
    if (!isReturnAddrValid) {
      setBetVerifyResult({
        ok: false,
        message: 'Enter a valid Zcash return address (utest1... or u1...) in Step 3 first.',
      });
      return;
    }

    const cleanTxid = normalizeOnChainTxid(rawTxid);
    setVerifyingBetTx(true);
    try {
      const verifyRes = await fetch('/api/zcash/tx/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txid: cleanTxid,
          address: market.shieldedPoolAddress,
        }),
      });
      const verifyJson = (await verifyRes.json()) as {
        validFormat?: boolean;
        txid?: string;
        explorerUrl?: string;
        secondaryExplorerUrl?: string;
        confirmations?: number | null;
        message?: string;
        error?: string;
      };

      if (!verifyRes.ok || !verifyJson.validFormat) {
        setBetVerifyResult({
          ok: false,
          message: verifyJson.message || verifyJson.error || 'Transaction format check failed.',
        });
        return;
      }

      const amountZatoshis = zecToZatoshis(validAmount);
      const rawMemoHex = utf8ToHex(
        JSON.stringify({
          q: market.id,
          pick: side,
          payout_to: trimmedReturnAddr,
        })
      ).slice(0, 1024);

      const betRes = await fetch(`/api/markets/${encodeURIComponent(market.id)}/bets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txid: cleanTxid,
          poolType: 'orchard',
          recipientAddress: market.shieldedPoolAddress,
          pick: side,
          payoutTo: trimmedReturnAddr,
          amountZatoshis,
          rawMemoHex,
          confirmations: verifyJson.confirmations ?? 1,
        }),
      });
      const betJson = (await betRes.json()) as {
        inserted?: boolean;
        bet?: ShieldedBet;
        market?: MarketWithDetails;
        error?: string;
      };

      if (!betRes.ok) {
        throw new Error(betJson.error || 'Unable to store verified bet.');
      }

      if (betJson.market) {
        setApiMarket(betJson.market);
      }

      const recordedBet: ShieldedBet =
        betJson.bet ?? {
          id: `bet_${Date.now().toString(36)}`,
          marketId: market.id,
          txid: cleanTxid,
          poolType: 'orchard',
          recipientAddress: market.shieldedPoolAddress,
          pick: side,
          payoutTo: trimmedReturnAddr,
          amountZatoshis,
          rawMemoHex,
          decodedMemoJson: {
            q: market.id,
            pick: side,
            payout_to: trimmedReturnAddr,
          },
          confirmations: verifyJson.confirmations ?? 1,
          createdAt: new Date().toISOString(),
        };

      setRoomBets((prev) => {
        if (prev.some((b) => normalizeOnChainTxid(b.txid) === cleanTxid)) {
          return prev;
        }
        return [recordedBet, ...prev];
      });

      setToastBet({
        txid: cleanTxid,
        pick: side,
        amountZatoshis,
      });

      setBetVerifyResult({
        ok: true,
        message:
          betJson.inserted === false
            ? `Transaction ${formatShortTxid(cleanTxid)} was already recorded. ${verifyJson.message || ''}`
            : `Recorded ${validAmount} ZEC on ${side}. ${verifyJson.message || ''}`,
        txid: cleanTxid,
        explorerUrl: verifyJson.explorerUrl,
        secondaryExplorerUrl: verifyJson.secondaryExplorerUrl,
      });
      setBetTxidInput('');
    } catch (err) {
      setBetVerifyResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Unable to record verified transaction.',
      });
    } finally {
      setVerifyingBetTx(false);
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
          className="inline-flex items-center gap-1.5 text-xs font-medium var(--text-secondary) hover:text-[var(--text-primary)] min-h-[44px] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to Markets</span>
        </button>
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg p-6 space-y-4 animate-pulse">
          <div className="h-4 w-40 bg-[var(--border-subtle)] rounded" />
          <div className="h-7 w-3/4 bg-[var(--border-subtle)] rounded" />
          <div className="h-40 w-full bg-[var(--border-subtle)] rounded" />
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
          className="inline-flex items-center gap-1.5 text-xs font-medium var(--text-secondary) hover:text-[var(--text-primary)] min-h-[44px] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to Markets</span>
        </button>
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-8 text-center space-y-3">
          <AlertTriangle className="w-6 h-6 var(--accent-cyan) mx-auto" aria-hidden="true" />
          <h1 className="font-display text-xl sm:text-3xl font-bold var(--text-primary)">
            Betting Room Not Found
          </h1>
          <p className="text-sm var(--text-secondary)">
            {marketLoadError || `No market found for room ID "${roomId}".`}
          </p>
          <button
            type="button"
            onClick={onBackToMarkets}
            className="px-4 py-2.5 text-xs font-semibold var(--text-primary) bg-[var(--border-subtle)] rounded-lg hover:bg-[rgba(59,130,246,0.1)] cursor-pointer"
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

      {/* Top Back Navigation, Scan-to-Checkout & Room ID */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBackToMarkets}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 min-h-[44px] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to Markets</span>
        </button>

        <div className="flex flex-wrap items-center gap-2.5">
          {onOpenScanner && (
            <button
              type="button"
              onClick={onOpenScanner}
              className="min-h-[40px] px-3 py-1.5 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 rounded-lg cursor-pointer"
            >
              Scan Bet QR
            </button>
          )}
          <span className="text-xs font-mono text-slate-500 truncate max-w-full">
            Room: {market.id}
          </span>
        </div>
      </div>

      {/* Scanned Bet Upload Confirmation Banner */}
      {initialPrefill?.scannedAt && (
        <section className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-emerald-950">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <p className="font-semibold">
                Scanned Bet Loaded &amp; Ready for Checkout ({initialPrefill.side || side} ·{' '}
                {initialPrefill.amountZec ?? validAmount}{' '}
                {checkoutRail === 'zcash' ? 'ZEC' : 'USDC'})
              </p>
              <p className="text-emerald-800">
                {initialPrefill.uploaded
                  ? 'Bet payload uploaded and saved locally. Sign below to complete settlement.'
                  : 'All scanned QR fields applied below. Sign with Zashi or Pollar / Polygon to check out.'}
              </p>
            </div>
          </div>
          {initialPrefill.txid && (
            <span className="font-mono text-[11px] text-emerald-800 truncate max-w-[220px]">
              tx: {initialPrefill.txid}
            </span>
          )}
        </section>
      )}

      {/* Market Header Summary */}
<section className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs var(--text-muted)">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className="font-medium var(--text-secondary)">{market.category}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">@{market.creator.handle}</span>
            {market.creationTxid && (
              <>
                <span aria-hidden="true">·</span>
                <a
                  href={getZcashTxExplorerUrls(market.creationTxid, market.shieldedPoolAddress).primaryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono var(--accent-cyan) hover:text-[var(--accent-cyan)] underline underline-offset-2"
                >
                  <span>Anchored {formatShortTxid(market.creationTxid, 6, 4)}</span>
                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
              </>
            )}
          </div>
          <MarketCountdown market={market} variant="card" />
        </div>

        <h1 className="font-display text-xl sm:text-3xl font-bold var(--text-primary) [text-wrap:balance]">
          {market.question}
        </h1>

        <div className="grid grid-cols-3 gap-2.5 sm:gap-4 pt-3 border-t border-[var(--border-subtle)] font-mono tabular-nums">
          <div className="min-w-0">
            <p className="font-sans text-xs var(--text-muted)">YES Odds</p>
            <p className="text-base sm:text-lg font-semibold var(--accent-cyan)">
              {market.yesProbability.toFixed(1)}%
            </p>
          </div>
          <div className="min-w-0">
            <p className="font-sans text-xs var(--text-muted)">NO Odds</p>
            <p className="text-base sm:text-lg font-semibold var(--accent-yellow)">
              {market.noProbability.toFixed(1)}%
            </p>
          </div>
          <div className="min-w-0">
            <p className="font-sans text-xs var(--text-muted)">Volume</p>
            <p className="text-base sm:text-lg font-semibold var(--text-primary) truncate">
              {formatZec(market.totalVolumeZatoshis, 2)}
            </p>
          </div>
        </div>
      </section>

      {/* Locked / Resolved Banner */}
      {isBettingDisabled && (
        <section className="p-4 sm:p-5 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl flex items-start gap-3 text-sm var(--text-secondary)">
          {market.status === MarketStatus.Resolved ? (
            <Trophy className="w-5 h-5 var(--accent-cyan) shrink-0 mt-0.5" aria-hidden="true" />
          ) : (
            <Lock className="w-5 h-5 var(--accent-cyan) shrink-0 mt-0.5" aria-hidden="true" />
          )}
          <div className="space-y-1">
            <p className="font-semibold">
              {market.status === MarketStatus.Resolved
                ? `Market Resolved — Winning Outcome: ${market.winningOutcome ?? 'Settled'}`
                : market.status === MarketStatus.Locked
                ? 'Betting is Locked'
                : 'Market Cancelled'}
            </p>
            <p className="text-xs var(--text-muted)">
              Betting inputs and QR payment generation are disabled while this market is{' '}
              {market.status.toUpperCase()}.
            </p>
          </div>
        </section>
      )}

      {/* Mobile-First 2-Column Responsive Betting Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
        {/* Left: Player Input Form */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5">
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
            <span className="block text-xs font-medium var(--text-secondary)">1. Select Outcome</span>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isBettingDisabled}
                onClick={() => setSide(OutcomeSide.Yes)}
className={`min-h-[52px] px-4 py-3 rounded-xl font-display text-base font-bold transition-colors duration-150 flex items-center justify-between cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    side === OutcomeSide.Yes
                      ? 'border-[var(--accent-cyan)] bg-[rgba(6,214,160,0.1)] text-[var(--accent-cyan)]'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--accent-cyan)]'}
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
className={`min-h-[52px] px-4 py-3 rounded-xl font-display text-base font-bold transition-colors duration-150 flex items-center justify-between cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    side === OutcomeSide.No
                      ? 'border-[var(--accent-yellow)] bg-[rgba(234,179,8,0.1)] text-[var(--accent-yellow)]'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--accent-cyan)]'}
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
              className="block text-xs font-medium var(--text-secondary)"
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
              className="w-full min-h-[48px] px-3.5 py-2.5 text-base font-mono tabular-nums bg-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-xl text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)] focus:bg-[var(--bg-surface)] disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <div className="grid grid-cols-2 min-[380px]:grid-cols-4 gap-2">
              {QUICK_AMOUNTS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={isBettingDisabled}
                  onClick={() => setAmountInput(preset)}
className={`min-h-[40px] py-2 px-2 text-xs font-mono font-medium rounded-lg border transition-colors duration-150 whitespace-nowrap cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                      amountInput === preset
                        ? 'bg-[var(--bg-surface)] text-white border-[var(--border-subtle)]'
                        : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-subtle)] hover:border-[var(--accent-blue)]'}
                    }`}
                >
                  {preset} ZEC
                </button>
              ))}
            </div>
            {quote && (
              <div className="pt-1 flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-600">
                <span>Est. Shares: {quote.sharesOut.toFixed(4)}</span>
                <span>Creator Fee: {formatZec(quote.feeZatoshis, 4)}</span>
              </div>
            )}
          </div>

          {/* Return Address Input (persisted in localStorage) */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <label htmlFor="player-return-addr" className="font-medium var(--text-secondary)">
                3. Your Return / Payout Address (utest1... / u1...)
              </label>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  disabled={isBettingDisabled}
                  onClick={() => setReturnAddr(generateSampleTestnetUnifiedAddress('zingo'))}
                  className="text-xs font-medium text-amber-700 hover:text-amber-800 cursor-pointer disabled:opacity-50"
                >
                  Use Zingo Testnet (utest1...)
                </button>
                {!walletSession && (
                  <button
                    type="button"
                    onClick={() => openAuthModal('zcash')}
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Connect Wallet
                  </button>
                )}
              </div>
            </div>
            <input
              id="player-return-addr"
              type="text"
              disabled={isBettingDisabled}
              value={returnAddr}
              onChange={(e) => setReturnAddr(e.target.value)}
              placeholder="u1... or utest1..."
              className="w-full min-h-[48px] px-3.5 py-2.5 text-xs font-mono bg-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-xl text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)] focus:bg-[var(--bg-surface)] disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {trimmedReturnAddr.length > 0 && !isReturnAddrValid && (
              <p className="text-xs var(--accent-yellow)">
                Enter a valid Zcash shielded address starting with u1, utest1, uregtest1, or zs1
                (minimum 20 characters).
              </p>
            )}
          </div>
        </section>

        {/* Right: Dual Checkout Rail (ZIP-321 Shielded + Pollar Instant USDC) */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-[var(--border-subtle)] rounded-lg">
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
                Pollar / Polygon
              </button>
            </div>

{checkoutRail === 'zcash' && (
              <button
                type="button"
                onClick={() => void handlePollMempool()}
                disabled={pollingMempool}
                className="min-h-[40px] px-3 py-2 text-xs font-medium var(--text-secondary) bg-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-lg hover:border-[var(--accent-blue)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
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
                  <div className="flex flex-col items-center justify-center p-4 sm:p-5 bg-white border border-slate-200 rounded-xl">
                    <div className="w-full max-w-[220px] flex items-center justify-center">
                      <QRCodeSVG
                        value={zip321Result.uri}
                        size={220}
                        level="M"
                        includeMargin={false}
                        bgColor="#ffffff"
                        fgColor="#0f172a"
                        className="w-full h-auto max-w-[220px]"
                      />
                    </div>
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

              {/* Direct On-Chain Bet Verification (Zingo Testnet TxID) */}
              {!isBettingDisabled && (
                <form
                  onSubmit={(e) => void handleRecordAndVerifyBetTx(e)}
                  className="pt-4 border-t border-slate-100 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor="player-bet-txid"
                      className="text-xs font-semibold text-slate-800"
                    >
                      Verify &amp; Record Zingo Testnet Bet TxID
                    </label>
                    <span className="text-[11px] font-mono text-slate-500">
                      64-char hex txid
                    </span>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      id="player-bet-txid"
                      type="text"
                      value={betTxidInput}
                      onChange={(e) => setBetTxidInput(e.target.value)}
                      placeholder="Paste broadcasted Zingo Testnet txid..."
                      className="flex-1 min-h-[42px] px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                    />
                    <button
                      type="submit"
                      disabled={verifyingBetTx}
                      className="min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg whitespace-nowrap cursor-pointer"
                    >
                      {verifyingBetTx ? 'Verifying...' : 'Verify & Record Tx'}
                    </button>
                  </div>
                  {betVerifyResult && (
                    <div
                      className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                        betVerifyResult.ok
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                          : 'bg-rose-50 border-rose-200 text-rose-800'
                      }`}
                    >
                      <p className="font-medium">{betVerifyResult.message}</p>
                      {betVerifyResult.explorerUrl && (
                        <div className="flex flex-wrap items-center gap-3 pt-0.5">
                          <a
                            href={betVerifyResult.explorerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
                          >
                            <span>Inspect on CipherScan Testnet</span>
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                          </a>
                          {betVerifyResult.secondaryExplorerUrl && (
                            <a
                              href={betVerifyResult.secondaryExplorerUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                            >
                              <span>Zcash Testnet Explorer</span>
                              <ExternalLink className="w-3 h-3" aria-hidden="true" />
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </form>
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

              {pollarAuthError && (
                <div
                  role="alert"
                  className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 break-words"
                >
                  {pollarAuthError}
                </div>
              )}

              {!pollarAuthed && walletSession?.rail !== 'polygon' ? (
                <div className="p-5 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <p className="text-xs text-slate-600">
                    Sign in via Pollar social login or connect your Polygon wallet to submit USDC
                    settlement transfers.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={isBettingDisabled}
                      onClick={() => openAuthModal('polygon')}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg cursor-pointer"
                    >
                      Sign in with Polygon / Pollar
                    </button>
                    <button
                      type="button"
                      disabled={!publishableConfigured || isBettingDisabled}
                      onClick={() => {
                        clearPollarAuthError();
                        pollarLogin({ provider: 'google' });
                      }}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 disabled:opacity-50 rounded-lg cursor-pointer"
                    >
                      Pollar Google
                    </button>
                    <button
                      type="button"
                      disabled={!publishableConfigured || isBettingDisabled}
                      onClick={() => {
                        clearPollarAuthError();
                        openPollarLogin();
                      }}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 disabled:opacity-50 rounded-lg cursor-pointer"
                    >
                      Email / Passkey
                    </button>
                  </div>
                </div>
              ) : !pollarAuthed && walletSession?.rail === 'polygon' ? (
                <div className="p-5 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-900">Polygon Wallet Connected</span>
                    <span className="font-mono text-slate-600 truncate max-w-[180px]">
                      {walletSession.address}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600">
                    Generate a Polygon EIP-681 payment link or connect Pollar Social for sponsored
                    USDC checkout.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={`polygon:${
                        /^0x[a-fA-F0-9]{40}$/.test(pollarDestination.trim())
                          ? pollarDestination.trim()
                          : walletSession.address
                      }?amount=${encodeURIComponent(pollarAmount || '5')}&market=${encodeURIComponent(
                        market.id
                      )}&pick=${encodeURIComponent(side)}&payout_to=${encodeURIComponent(
                        walletSession.address
                      )}`}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg inline-flex items-center justify-center"
                    >
                      Open Polygon Wallet Checkout
                    </a>
                    <button
                      type="button"
                      onClick={() => openAuthModal('polygon')}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 rounded-lg cursor-pointer"
                    >
                      Pollar Social Sign-In
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

                  <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
                    {(pollarChains.length > 0
                      ? pollarChains
                      : (['STELLAR', 'SOLANA', 'POLYGON'] as WalletChain[])
                    ).map((ch) => (
                      <button
                        key={ch}
                        type="button"
                        disabled={isBettingDisabled}
                        onClick={() => setPollarChain(ch)}
                        className={`min-h-[40px] py-2 px-1.5 sm:px-3 text-xs font-semibold rounded-lg border truncate cursor-pointer disabled:opacity-50 ${
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
            <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
              <span className="font-semibold text-slate-600">
                Your Detected Shielded Bets ({matchingUserBets.length})
              </span>
              <span className="text-slate-400">
                {roomBets.length} total verified in room
              </span>
            </div>

            {matchingUserBets.length === 0 ? (
              <p className="text-xs text-slate-500">
                {isReturnAddrValid
                  ? 'Waiting for an unspent Orchard/Sapling note or submitted txid with your payout_to address...'
                  : 'Enter your return address above to watch for incoming confirmations.'}
              </p>
            ) : (
              <ul className="space-y-2">
                {matchingUserBets.map((bet) => {
                  const explorerLinks = getZcashTxExplorerUrls(
                    bet.txid,
                    market.shieldedPoolAddress
                  );
                  return (
                    <li
                      key={bet.id}
                      className="p-3 bg-emerald-50/70 border border-emerald-200 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <CheckCircle2
                          className="w-4 h-4 text-emerald-700 shrink-0"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <span className="font-medium text-emerald-900 truncate font-mono block">
                            {bet.pick} · {zatoshisToZec(bet.amountZatoshis).toFixed(4)} ZEC
                          </span>
                          <span className="font-mono text-[11px] text-emerald-700/80 block truncate">
                            txid: {formatShortTxid(bet.txid)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        <span className="font-mono text-emerald-800">
                          {bet.confirmations} conf
                        </span>
                        {isValidOnChainTxid(bet.txid) && (
                          <a
                            href={explorerLinks.primaryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-semibold text-emerald-900 hover:text-slate-900 underline underline-offset-2"
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
        </section>
      </div>

      {/* Market Sentiment Chart & Countdown */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 sm:p-6">
          <SentimentTrendChart market={market} />
        </div>
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4">
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

/**
 * Zolymarket — Real-Time Cloud Firestore Market Subscription Hook
 *
 * Subscribes to live Cloud Firestore `creators` and `markets` collections
 * via `onSnapshot`. If Cloud Firestore has not been seeded yet, loads initial
 * market records from `/api/markets` and automatically seeds Firestore when
 * an admin user signs in.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  Timestamp,
  collection,
  onSnapshot,
  query,
} from 'firebase/firestore';
import {
  Creator,
  MarketCategory,
  MarketStatus,
  MarketWithDetails,
  OutcomeSide,
} from '../types/database.ts';
import { calculateBinaryOdds } from '../lib/cpmm.ts';
import {
  OperationType,
  db,
  handleFirestoreError,
} from '../lib/firebase.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import { seedFirestoreFromBootstrap } from '../lib/firestore-seed.ts';

interface UseRealtimeMarketsResult {
  markets: MarketWithDetails[];
  creators: Creator[];
  loading: boolean;
  error: string | null;
  firestoreActive: boolean;
  refresh: () => Promise<void>;
}

function toIsoString(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string') {
    return val;
  }
  return new Date().toISOString();
}

export function useRealtimeMarkets(): UseRealtimeMarketsResult {
  const { user } = useAuth();
  const [bootstrapMarkets, setBootstrapMarkets] = useState<MarketWithDetails[]>([]);
  const [bootstrapCreators, setBootstrapCreators] = useState<Creator[]>([]);
  const [firestoreCreators, setFirestoreCreators] = useState<Creator[]>([]);
  const [firestoreMarketDocs, setFirestoreMarketDocs] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [seededAttempted, setSeededAttempted] = useState<boolean>(false);

  const fetchBootstrapData = useCallback(async () => {
    try {
      setError(null);
      const [marketsRes, creatorsRes] = await Promise.all([
        fetch('/api/markets'),
        fetch('/api/creators'),
      ]);

      if (!marketsRes.ok || !creatorsRes.ok) {
        throw new Error('Unable to fetch market registry.');
      }

      const marketsJson = (await marketsRes.json()) as { markets: MarketWithDetails[] };
      const creatorsJson = (await creatorsRes.json()) as { creators: Creator[] };

      setBootstrapMarkets(marketsJson.markets);
      setBootstrapCreators(creatorsJson.creators);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error loading markets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBootstrapData();

    const creatorsQuery = query(collection(db, 'creators'));
    const marketsQuery = query(collection(db, 'markets'));

    const unsubCreators = onSnapshot(
      creatorsQuery,
      (snapshot) => {
        const list: Creator[] = snapshot.docs.map((docSnap) => {
          const d = docSnap.data();
          return {
            id: String(d.id || docSnap.id),
            handle: String(d.handle || ''),
            displayName: String(d.displayName || ''),
            bio: String(d.bio || ''),
            zcashUnifiedAddress: String(d.zcashUnifiedAddress || ''),
            verified: Boolean(d.verified),
            marketsCreatedCount: Number(d.marketsCreatedCount || 0),
            totalVolumeZatoshis: Number(d.totalVolumeZatoshis || 0),
            createdAt: toIsoString(d.createdAt),
          };
        });
        setFirestoreCreators(list);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, 'creators');
        } catch (wrapped) {
          console.warn('Firestore creators listener fallback:', wrapped);
        }
      }
    );

    const unsubMarkets = onSnapshot(
      marketsQuery,
      (snapshot) => {
        const docs = snapshot.docs.map((docSnap) => ({
          ...docSnap.data(),
          id: docSnap.data().id || docSnap.id,
        }));
        setFirestoreMarketDocs(docs);
        setLoading(false);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, 'markets');
        } catch (wrapped) {
          console.warn('Firestore markets listener fallback:', wrapped);
        }
      }
    );

    return () => {
      unsubCreators();
      unsubMarkets();
    };
  }, [fetchBootstrapData]);

  // Auto-seed Cloud Firestore once when an admin signs in and Firestore is empty
  useEffect(() => {
    if (
      !user ||
      user.email !== 'ekwuemesat@gmail.com' ||
      !user.emailVerified ||
      seededAttempted ||
      firestoreMarketDocs.length > 0 ||
      bootstrapMarkets.length === 0
    ) {
      return;
    }

    setSeededAttempted(true);
    void seedFirestoreFromBootstrap(bootstrapCreators, bootstrapMarkets).catch((err) => {
      console.error('Automatic Firestore seed failed:', err);
    });
  }, [user, seededAttempted, firestoreMarketDocs.length, bootstrapCreators, bootstrapMarkets]);

  const firestoreActive = firestoreMarketDocs.length > 0 && firestoreCreators.length > 0;

  const creators = firestoreActive
    ? [
        ...firestoreCreators,
        ...bootstrapCreators.filter(
          (bc) => !firestoreCreators.some((fc) => fc.id === bc.id)
        ),
      ]
    : bootstrapCreators;

  const mappedFirestoreMarkets: MarketWithDetails[] = firestoreActive
    ? firestoreMarketDocs.map((d) => {
        const id = String(d.id);
        const creatorId = String(d.creatorId);
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
        const bootstrapMatch = bootstrapMarkets.find((bm) => bm.id === id);

        return {
          id,
          slug: String(d.slug || id),
          creatorId,
          ownerUid: typeof d.ownerUid === 'string' ? d.ownerUid : undefined,
          question: String(d.question || ''),
          description: String(d.description || ''),
          resolutionCriteria: String(d.resolutionCriteria || ''),
          category: (d.category as MarketCategory) || MarketCategory.ZcashProtocol,
          status: (d.status as MarketStatus) || MarketStatus.Open,
          shieldedPoolAddress: String(d.shieldedPoolAddress || ''),
          creationTxid:
            bootstrapMatch?.creationTxid ??
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
        };
      })
    : [];

  const markets: MarketWithDetails[] = firestoreActive
    ? [
        ...bootstrapMarkets.filter(
          (bm) => !mappedFirestoreMarkets.some((fm) => fm.id === bm.id)
        ),
        ...mappedFirestoreMarkets,
      ]
    : bootstrapMarkets;

  return {
    markets,
    creators,
    loading,
    error,
    firestoreActive,
    refresh: fetchBootstrapData,
  };
}

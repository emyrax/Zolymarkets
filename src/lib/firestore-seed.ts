/**
 * Zolymarket — Cloud Firestore Client Seeding Utility
 *
 * Allows an authenticated admin to seed initial Zcash prediction markets
 * and creators directly into Cloud Firestore (`creators` and `markets` collections)
 * conforming strictly to `firebase-blueprint.json` and `firestore.rules`.
 */

import { doc, getDocs, collection, serverTimestamp, writeBatch } from 'firebase/firestore';
import {
  OperationType,
  auth,
  db,
  handleFirestoreError,
} from './firebase.ts';
import { Creator, MarketWithDetails } from '../types/database.ts';

export async function seedFirestoreFromBootstrap(
  creators: Creator[],
  markets: MarketWithDetails[]
): Promise<{ seededCreators: number; seededMarkets: number }> {
  const ownerUid = auth.currentUser?.uid;
  if (!ownerUid) {
    throw new Error('Sign in with Google before seeding Cloud Firestore.');
  }

  let existingCreatorsCount = 0;
  try {
    const snap = await getDocs(collection(db, 'creators'));
    existingCreatorsCount = snap.size;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'creators');
  }

  let existingMarketsCount = 0;
  try {
    const snap = await getDocs(collection(db, 'markets'));
    existingMarketsCount = snap.size;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'markets');
  }

  if (existingCreatorsCount > 0 && existingMarketsCount > 0) {
    return { seededCreators: 0, seededMarkets: 0 };
  }

  let seededCreators = 0;
  let seededMarkets = 0;

  if (existingCreatorsCount === 0 && creators.length > 0) {
    const creatorsBatch = writeBatch(db);
    for (const creator of creators) {
      const ref = doc(db, 'creators', creator.id);
      creatorsBatch.set(ref, {
        id: creator.id,
        ownerUid,
        handle: creator.handle,
        displayName: creator.displayName,
        bio: creator.bio,
        zcashUnifiedAddress: creator.zcashUnifiedAddress,
        verified: creator.verified,
        marketsCreatedCount: creator.marketsCreatedCount,
        totalVolumeZatoshis: creator.totalVolumeZatoshis,
        createdAt: serverTimestamp(),
      });
      seededCreators += 1;
    }

    try {
      await creatorsBatch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'creators');
    }
  }

  if (existingMarketsCount === 0 && markets.length > 0) {
    const marketsBatch = writeBatch(db);
    for (const market of markets) {
      const ref = doc(db, 'markets', market.id);
      marketsBatch.set(ref, {
        id: market.id,
        slug: market.slug,
        creatorId: market.creatorId,
        ownerUid,
        question: market.question,
        description: market.description,
        resolutionCriteria: market.resolutionCriteria,
        category: market.category,
        status: market.status,
        shieldedPoolAddress: market.shieldedPoolAddress,
        creatorFeeBps: market.creatorFeeBps,
        yesPoolZatoshis: market.outcomes.yes.poolZatoshis,
        noPoolZatoshis: market.outcomes.no.poolZatoshis,
        yesSharesOutstanding: market.outcomes.yes.sharesOutstanding,
        noSharesOutstanding: market.outcomes.no.sharesOutstanding,
        totalVolumeZatoshis: market.totalVolumeZatoshis,
        liquidityZatoshis: market.liquidityZatoshis,
        yesProbability24hAgo: market.yesProbability24hAgo,
        winningOutcome: market.winningOutcome,
        duration:
          typeof market.duration === 'number' && market.duration >= 1
            ? Math.round(market.duration)
            : Math.max(
                1,
                Math.min(
                  87600,
                  Math.round(
                    (Date.parse(market.closesAt) - Date.parse(market.createdAt)) / 3_600_000
                  ) || 720
                )
              ),
        closesAt: market.closesAt,
        resolvedAt: market.resolvedAt,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      seededMarkets += 1;
    }

    try {
      await marketsBatch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'markets');
    }
  }

  return { seededCreators, seededMarkets };
}

/**
 * Zolymarket — Authoritative Server Store (Local JSON Fallback Cache)
 *
 * Provides persistent state mirroring `firebase-blueprint.json`
 * for server bootstrap and zingo-cli synchronization alongside Cloud Firestore.
 * Automatically seeds initial Zcash creator prediction markets on first boot.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Creator,
  DecodedBetMemo,
  Market,
  MarketCategory,
  MarketStatus,
  MarketWithDetails,
  Outcome,
  OutcomeSide,
  Position,
  ShieldedBet,
  ShieldedTransaction,
} from '../types/database.ts';
import { calculateBinaryOdds, estimateSharesOut, zecToZatoshis } from '../lib/cpmm.ts';

interface DatabaseState {
  creators: Creator[];
  markets: Market[];
  outcomes: Outcome[];
  positions: Position[];
  shieldedTransactions: ShieldedTransaction[];
  shieldedBets: ShieldedBet[];
}

const DATA_FILE = path.resolve(process.cwd(), '.zolymarket-data.json');

function createSeedState(): DatabaseState {
  const now = new Date('2026-11-13T20:00:00.000Z').toISOString();

  const creators: Creator[] = [
    {
      id: 'c1a00001-0000-4000-8000-000000000001',
      handle: 'zooko_notes',
      displayName: 'Shielded Lab',
      bio: 'Tracking Zcash protocol upgrades, Crosslink PoS milestones, and Halo 2 recursion.',
      zcashUnifiedAddress: 'u1q8w9x2e4r6t8y0u2i4o6p8a0s2d4f6g8h0j2k4l6z8x0c2v4b6n8m0q1w2e3r4t5y6',
      verified: true,
      marketsCreatedCount: 2,
      totalVolumeZatoshis: zecToZatoshis(184.5),
      createdAt: now,
    },
    {
      id: 'c1a00001-0000-4000-8000-000000000002',
      handle: 'ecc_watcher',
      displayName: 'Orchard Observer',
      bio: 'Independent analyst covering Zcash wallets, Zashi adoption, and shielded pool inflows.',
      zcashUnifiedAddress: 'u1k9j8h7g6f5d4s3a2p1o0i9u8y7t6r5e4w3q2m1n0b9v8c7x6z5l4k3j2h1g0f9d8s7',
      verified: true,
      marketsCreatedCount: 2,
      totalVolumeZatoshis: zecToZatoshis(142.25),
      createdAt: now,
    },
    {
      id: 'c1a00001-0000-4000-8000-000000000003',
      handle: 'zcg_pulse',
      displayName: 'ZCG Governance Desk',
      bio: 'Community grants, ZIP governance ballots, and Zcash ecosystem treasury proposals.',
      zcashUnifiedAddress: 'u1m2n3b4v5c6x7z8l9k0j1h2g3f4d5s6a7p8o9i0u1y2t3r4e5w6q7a8s9d0f1g2h3j4',
      verified: false,
      marketsCreatedCount: 2,
      totalVolumeZatoshis: zecToZatoshis(96.8),
      createdAt: now,
    },
  ];

  const markets: Market[] = [
    {
      id: 'm1a00001-0000-4000-8000-000000000001',
      slug: 'zcash-orchard-shielded-pool-25-percent',
      creatorId: creators[0].id,
      question: 'Will Zcash shielded supply exceed 25% of circulating ZEC before Q2 2027?',
      description: 'Tracks combined Sapling and Orchard shielded pool balances relative to circulating ZEC supply.',
      resolutionCriteria: 'Resolves YES if zcash.explorer or Electric Coin Co. daily telemetry reports shielded ZEC / circulating ZEC >= 25.00% on any UTC daily snapshot prior to April 1, 2027.',
      category: MarketCategory.ZcashProtocol,
      status: MarketStatus.Open,
      shieldedPoolAddress: 'u1marketpool01orchardsupply25pct9x8c7v6b5n4m3l2k1j0h9g8f7d6s5a4p3o2',
      creatorFeeBps: 150,
      totalVolumeZatoshis: zecToZatoshis(112.4),
      liquidityZatoshis: zecToZatoshis(48.0),
      yesProbability24hAgo: 62.4,
      winningOutcome: null,
      closesAt: '2027-03-31T23:59:59.000Z',
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'm1a00001-0000-4000-8000-000000000002',
      slug: 'crosslink-hybrid-pos-testnet-launch',
      creatorId: creators[0].id,
      question: 'Will Crosslink hybrid PoS finality launch on Zcash public testnet by Feb 2027?',
      description: 'Evaluates Shielded Labs Crosslink milestone delivery on a publicly accessible test network.',
      resolutionCriteria: 'Resolves YES upon official Shielded Labs GitHub release tag and public testnet RPC announcement enabling Crosslink finality gadgets before Feb 28, 2027.',
      category: MarketCategory.ZcashProtocol,
      status: MarketStatus.Open,
      shieldedPoolAddress: 'u1marketpool02crosslinktestnet0a1s2d3f4g5h6j7k8l9z0x1c2v3b4n5m6q7w8',
      creatorFeeBps: 150,
      totalVolumeZatoshis: zecToZatoshis(72.1),
      liquidityZatoshis: zecToZatoshis(36.0),
      yesProbability24hAgo: 49.5,
      winningOutcome: null,
      closesAt: '2027-02-28T23:59:59.000Z',
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'm1a00001-0000-4000-8000-000000000003',
      slug: 'zashi-zip321-merchant-checkout-100k',
      creatorId: creators[1].id,
      question: 'Will Zashi Wallet cross 100,000 active shielded monthly installs in 2026?',
      description: 'Measures consumer privacy wallet adoption driven by ZIP-321 QR checkouts and CrossPay.',
      resolutionCriteria: 'Resolves YES if ECC publishes an official report confirming >= 100,000 MAU across iOS and Android Zashi clients for any calendar month in 2026.',
      category: MarketCategory.Ecosystem,
      status: MarketStatus.Open,
      shieldedPoolAddress: 'u1marketpool03zashiwallet100k1q2w3e4r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9',
      creatorFeeBps: 100,
      totalVolumeZatoshis: zecToZatoshis(88.75),
      liquidityZatoshis: zecToZatoshis(32.5),
      yesProbability24hAgo: 57.0,
      winningOutcome: null,
      closesAt: '2026-12-31T23:59:59.000Z',
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'm1a00001-0000-4000-8000-000000000004',
      slug: 'zcash-shielded-assets-nu7-activation',
      creatorId: creators[1].id,
      question: 'Will Zcash Shielded Assets (ZSA) lock in NU7 mainnet activation height?',
      description: 'Tracks ZIP-226 / ZIP-227 Zcash Shielded Assets consensus activation schedule.',
      resolutionCriteria: 'Resolves YES if Zcashd / Zebra release notes publish a finalized mainnet activation block height for ZSA in NU7.',
      category: MarketCategory.PrivacyCrypto,
      status: MarketStatus.Open,
      shieldedPoolAddress: 'u1marketpool04zsashieldedassets9z8x7c6v5b4n3m2l1k0j9h8g7f6d5s4a3p2',
      creatorFeeBps: 200,
      totalVolumeZatoshis: zecToZatoshis(53.5),
      liquidityZatoshis: zecToZatoshis(28.0),
      yesProbability24hAgo: 63.8,
      winningOutcome: null,
      closesAt: '2027-01-31T23:59:59.000Z',
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'm1a00001-0000-4000-8000-000000000005',
      slug: 'zcg-dev-fund-coin-weighted-poll-pass',
      creatorId: creators[2].id,
      question: 'Will the next Zcash coin-weighted governance poll exceed 350,000 ZEC turnout?',
      description: 'Measures shielded ZEC holder participation in Zcash Community Grants governance votes.',
      resolutionCriteria: 'Resolves YES if the official coin-weighted polling tally verifies >= 350,000 ZEC participating across shielded + transparent ballots.',
      category: MarketCategory.Governance,
      status: MarketStatus.Open,
      shieldedPoolAddress: 'u1marketpool05zcggovpoll350k5t4r3e2w1q0y9u8i7o6p5l4k3j2h1g0f9d8s7',
      creatorFeeBps: 125,
      totalVolumeZatoshis: zecToZatoshis(64.3),
      liquidityZatoshis: zecToZatoshis(25.0),
      yesProbability24hAgo: 46.8,
      winningOutcome: null,
      closesAt: '2026-12-20T23:59:59.000Z',
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'm1a00001-0000-4000-8000-000000000006',
      slug: 'zec-spot-etf-filing-submission-2027',
      creatorId: creators[2].id,
      question: 'Will a US issuer file an S-1 registration for a spot ZEC ETF before July 2027?',
      description: 'Creator-curated market on institutional privacy asset wrappers in US public markets.',
      resolutionCriteria: 'Resolves YES if SEC EDGAR publishes a Form S-1 filing specifically naming Zcash (ZEC) as the primary spot underlying asset.',
      category: MarketCategory.CreatorBets,
      status: MarketStatus.Open,
      shieldedPoolAddress: 'u1marketpool06zecetfs1filing7u6y5t4r3e2w1q0p9o8i7u6y5t4r3e2w1q0a9',
      creatorFeeBps: 200,
      totalVolumeZatoshis: zecToZatoshis(32.5),
      liquidityZatoshis: zecToZatoshis(20.0),
      yesProbability24hAgo: 32.9,
      winningOutcome: null,
      closesAt: '2027-06-30T23:59:59.000Z',
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];

  // Initial CPMM reserve pairs (remember: P(YES) = noPool / (yesPool + noPool))
  const reserveConfigs: Record<string, { yesZec: number; noZec: number }> = {
    [markets[0].id]: { yesZec: 15.8, noZec: 32.2 },  // ~67.1% YES
    [markets[1].id]: { yesZec: 19.4, noZec: 16.6 },  // ~46.1% YES
    [markets[2].id]: { yesZec: 12.0, noZec: 20.5 },  // ~63.1% YES
    [markets[3].id]: { yesZec: 9.5, noZec: 18.5 },   // ~66.1% YES
    [markets[4].id]: { yesZec: 14.5, noZec: 10.5 },  // ~42.0% YES
    [markets[5].id]: { yesZec: 13.8, noZec: 6.2 },   // ~31.0% YES
  };

  const outcomes: Outcome[] = markets.flatMap((market, index) => {
    const cfg = reserveConfigs[market.id];
    return [
      {
        id: `o1a00001-0000-4000-8000-000000000${index}01`,
        marketId: market.id,
        side: OutcomeSide.Yes,
        poolZatoshis: zecToZatoshis(cfg.yesZec),
        sharesOutstanding: cfg.yesZec * 1.4,
        updatedAt: now,
      },
      {
        id: `o1a00001-0000-4000-8000-000000000${index}02`,
        marketId: market.id,
        side: OutcomeSide.No,
        poolZatoshis: zecToZatoshis(cfg.noZec),
        sharesOutstanding: cfg.noZec * 1.4,
        updatedAt: now,
      },
    ];
  });

  return {
    creators,
    markets,
    outcomes,
    positions: [],
    shieldedTransactions: [],
    shieldedBets: [],
  };
}

class LocalStore {
  private state: DatabaseState;

  constructor() {
    this.state = this.loadState();
  }

  private loadState(): DatabaseState {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as DatabaseState;
        if (parsed && Array.isArray(parsed.markets) && parsed.markets.length > 0) {
          const seed = createSeedState();
          let migrated = false;
          parsed.markets = parsed.markets.map((m) => {
            if (typeof m.yesProbability24hAgo === 'number') {
              return m;
            }
            migrated = true;
            const seededMatch = seed.markets.find((sm) => sm.id === m.id);
            const fallbackDuration = Math.max(
              1,
              Math.round((Date.parse(m.closesAt) - Date.parse(m.createdAt)) / 3_600_000) || 720
            );
            return {
              ...m,
              yesProbability24hAgo: seededMatch ? seededMatch.yesProbability24hAgo : 50,
              duration: typeof m.duration === 'number' ? m.duration : fallbackDuration,
            };
          });
          if (!Array.isArray(parsed.shieldedBets)) {
            parsed.shieldedBets = [];
            migrated = true;
          }
          if (migrated) {
            this.persist(parsed);
          }
          return parsed;
        }
      }
    } catch (error) {
      console.error('Failed to read local store, re-seeding:', error);
    }

    const seed = createSeedState();
    this.persist(seed);
    return seed;
  }

  private persist(nextState: DatabaseState): void {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(nextState, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to persist local store:', error);
    }
  }

  public listCreators(): Creator[] {
    return [...this.state.creators];
  }

  public listMarketsWithDetails(): MarketWithDetails[] {
    return this.state.markets.map((market) => this.hydrateMarket(market));
  }

  public getMarketByIdOrSlug(idOrSlug: string): MarketWithDetails | null {
    const market = this.state.markets.find(
      (m) => m.id === idOrSlug || m.slug === idOrSlug
    );
    return market ? this.hydrateMarket(market) : null;
  }

  public listTransactions(marketId?: string): ShieldedTransaction[] {
    const items = marketId
      ? this.state.shieldedTransactions.filter((t) => t.marketId === marketId)
      : this.state.shieldedTransactions;
    return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public listShieldedBets(marketId?: string): ShieldedBet[] {
    const items = marketId
      ? this.state.shieldedBets.filter((b) => b.marketId === marketId)
      : this.state.shieldedBets;
    return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Inserts a decoded shielded bet into `shielded_bets` if its `txid`
   * has not already been processed. Updates CPMM pool reserves and market
   * volume atomically, returning the newly created bet and updated market.
   */
  public insertShieldedBetIfNew(input: {
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
  }): { inserted: boolean; bet?: ShieldedBet; market?: MarketWithDetails } {
    const existing = this.state.shieldedBets.find((b) => b.txid === input.txid);
    if (existing) {
      return { inserted: false };
    }

    const market = this.state.markets.find(
      (m) => m.id === input.marketId || m.slug === input.marketId
    );
    if (!market) {
      return { inserted: false };
    }

    const now = new Date().toISOString();
    const bet: ShieldedBet = {
      id: crypto.randomUUID(),
      marketId: market.id,
      txid: input.txid,
      poolType: input.poolType,
      recipientAddress: input.recipientAddress,
      pick: input.pick,
      payoutTo: input.payoutTo,
      amountZatoshis: input.amountZatoshis,
      rawMemoHex: input.rawMemoHex,
      decodedMemoJson: input.decodedMemoJson,
      confirmations: input.confirmations,
      createdAt: now,
    };

    this.state.shieldedBets.push(bet);

    // Update CPMM pool reserves on bet ingestion
    const yesOutcome = this.state.outcomes.find(
      (o) => o.marketId === market.id && o.side === OutcomeSide.Yes
    );
    const noOutcome = this.state.outcomes.find(
      (o) => o.marketId === market.id && o.side === OutcomeSide.No
    );

    if (yesOutcome && noOutcome && input.amountZatoshis > 0) {
      const targetOutcome = input.pick === OutcomeSide.Yes ? yesOutcome : noOutcome;
      const oppositeOutcome = input.pick === OutcomeSide.Yes ? noOutcome : yesOutcome;

      const quote = estimateSharesOut({
        amountZatoshis: input.amountZatoshis,
        targetPoolZatoshis: targetOutcome.poolZatoshis,
        oppositePoolZatoshis: oppositeOutcome.poolZatoshis,
        creatorFeeBps: market.creatorFeeBps,
      });

      if (quote.netDepositZatoshis > 0) {
        const k = targetOutcome.poolZatoshis * oppositeOutcome.poolZatoshis;
        const nextOppositePool = oppositeOutcome.poolZatoshis + quote.netDepositZatoshis;
        const nextTargetPool = Math.max(1, Math.round(k / nextOppositePool));

        oppositeOutcome.poolZatoshis = nextOppositePool;
        targetOutcome.poolZatoshis = nextTargetPool;
        targetOutcome.sharesOutstanding =
          Math.round((targetOutcome.sharesOutstanding + quote.sharesOut) * 10_000) / 10_000;
        oppositeOutcome.updatedAt = now;
        targetOutcome.updatedAt = now;

        market.totalVolumeZatoshis += input.amountZatoshis;
        market.liquidityZatoshis = yesOutcome.poolZatoshis + noOutcome.poolZatoshis;
        market.updatedAt = now;

        const creator = this.state.creators.find((c) => c.id === market.creatorId);
        if (creator) {
          creator.totalVolumeZatoshis += input.amountZatoshis;
        }
      }
    }

    this.persist(this.state);
    return {
      inserted: true,
      bet,
      market: this.hydrateMarket(market),
    };
  }

  public createHostMarket(input: {
    id: string;
    slug: string;
    creatorId: string;
    ownerUid?: string;
    creatorDisplayName: string;
    creatorHandle: string;
    creatorPayoutAddress: string;
    question: string;
    description: string;
    resolutionCriteria: string;
    category: MarketCategory;
    shieldedPoolAddress: string;
    creationTxid?: string | null;
    duration?: number;
    closesAt: string;
    creatorFeeBps?: number;
  }): MarketWithDetails {
    const existingMarket = this.state.markets.find((m) => m.id === input.id);
    if (existingMarket) {
      return this.hydrateMarket(existingMarket);
    }

    const now = new Date().toISOString();
    let creator = this.state.creators.find((c) => c.id === input.creatorId);
    if (!creator) {
      creator = {
        id: input.creatorId,
        handle: input.creatorHandle,
        displayName: input.creatorDisplayName,
        bio: 'Zolymarket prediction market creator.',
        zcashUnifiedAddress: input.creatorPayoutAddress,
        verified: false,
        marketsCreatedCount: 0,
        totalVolumeZatoshis: 0,
        createdAt: now,
      };
      this.state.creators.push(creator);
    } else if (input.creatorPayoutAddress) {
      creator.zcashUnifiedAddress = input.creatorPayoutAddress;
    }

    creator.marketsCreatedCount += 1;

    const initialSidePool = zecToZatoshis(5.0);
    const diffHours = (Date.parse(input.closesAt) - Date.parse(now)) / 3_600_000;
    const computedDuration = Number.isFinite(diffHours) && diffHours > 0
      ? Math.max(0.001389, Number(diffHours.toFixed(6)))
      : 24;
    const market: Market = {
      id: input.id,
      slug: input.slug,
      creatorId: creator.id,
      ownerUid: input.ownerUid,
      question: input.question,
      description: input.description,
      resolutionCriteria: input.resolutionCriteria,
      category: input.category,
      status: MarketStatus.Open,
      shieldedPoolAddress: input.shieldedPoolAddress,
      creationTxid: input.creationTxid?.trim() || null,
      creatorFeeBps: input.creatorFeeBps ?? 150,
      totalVolumeZatoshis: 0,
      liquidityZatoshis: initialSidePool * 2,
      yesProbability24hAgo: 50,
      winningOutcome: null,
      duration: input.duration ?? computedDuration,
      closesAt: input.closesAt,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const yesOutcome: Outcome = {
      id: `${input.id}-yes`,
      marketId: input.id,
      side: OutcomeSide.Yes,
      poolZatoshis: initialSidePool,
      sharesOutstanding: 0,
      updatedAt: now,
    };

    const noOutcome: Outcome = {
      id: `${input.id}-no`,
      marketId: input.id,
      side: OutcomeSide.No,
      poolZatoshis: initialSidePool,
      sharesOutstanding: 0,
      updatedAt: now,
    };

    this.state.markets.unshift(market);
    this.state.outcomes.push(yesOutcome, noOutcome);
    this.persist(this.state);
    return this.hydrateMarket(market);
  }

  public attachMarketCreationTxid(marketId: string, txid: string): MarketWithDetails | null {
    const market = this.state.markets.find(
      (m) => m.id === marketId || m.slug === marketId
    );
    if (!market) return null;
    market.creationTxid = txid.trim().replace(/^0x/i, '').toLowerCase();
    market.updatedAt = new Date().toISOString();
    this.persist(this.state);
    return this.hydrateMarket(market);
  }

  public lockMarket(marketId: string): MarketWithDetails | null {
    const market = this.state.markets.find(
      (m) => m.id === marketId || m.slug === marketId
    );
    if (!market) return null;
    if (market.status === MarketStatus.Open) {
      market.status = MarketStatus.Locked;
      market.updatedAt = new Date().toISOString();
      this.persist(this.state);
    }
    return this.hydrateMarket(market);
  }

  public resolveMarket(
    marketId: string,
    winningOutcome: OutcomeSide
  ): {
    market: MarketWithDetails;
    payoutItems: { address: string; amount: number; memo: string }[];
  } | null {
    const market = this.state.markets.find(
      (m) => m.id === marketId || m.slug === marketId
    );
    if (!market) return null;

    const now = new Date().toISOString();
    market.status = MarketStatus.Resolved;
    market.winningOutcome = winningOutcome;
    market.resolvedAt = now;
    market.updatedAt = now;
    this.persist(this.state);

    const creator = this.state.creators.find((c) => c.id === market.creatorId);
    const bets = this.listShieldedBets(market.id);
    const totalPoolZatoshis = bets.reduce((sum, b) => sum + b.amountZatoshis, 0);
    const winningBets = bets.filter((b) => b.pick === winningOutcome);
    const winningStakeTotal = winningBets.reduce((sum, b) => sum + b.amountZatoshis, 0);

    const payoutItems: { address: string; amount: number; memo: string }[] = [];
    if (totalPoolZatoshis > 0 && creator) {
      const feeZatoshis = Math.round((totalPoolZatoshis * market.creatorFeeBps) / 10_000);
      const distributableZatoshis = Math.max(0, totalPoolZatoshis - feeZatoshis);

      if (feeZatoshis > 0 && creator.zcashUnifiedAddress) {
        payoutItems.push({
          address: creator.zcashUnifiedAddress,
          amount: Number((feeZatoshis / 100_000_000).toFixed(8)),
          memo: `Zolymarket creator fee (${market.id})`,
        });
      }

      if (winningStakeTotal > 0 && distributableZatoshis > 0) {
        for (const bet of winningBets) {
          const shareZatoshis = Math.floor(
            (distributableZatoshis * bet.amountZatoshis) / winningStakeTotal
          );
          if (shareZatoshis > 0) {
            payoutItems.push({
              address: bet.payoutTo,
              amount: Number((shareZatoshis / 100_000_000).toFixed(8)),
              memo: `Zolymarket ${winningOutcome} payout (${market.id})`,
            });
          }
        }
      }
    }

    return {
      market: this.hydrateMarket(market),
      payoutItems,
    };
  }

  private hydrateMarket(market: Market): MarketWithDetails {
    const creator = this.state.creators.find((c) => c.id === market.creatorId)!;
    const yes = this.state.outcomes.find(
      (o) => o.marketId === market.id && o.side === OutcomeSide.Yes
    )!;
    const no = this.state.outcomes.find(
      (o) => o.marketId === market.id && o.side === OutcomeSide.No
    )!;
    const { yesProbability, noProbability } = calculateBinaryOdds(
      yes.poolZatoshis,
      no.poolZatoshis
    );

    const change24hPct =
      Math.round((yesProbability - market.yesProbability24hAgo) * 10) / 10;

    const rawDiffHours = (Date.parse(market.closesAt) - Date.parse(market.createdAt)) / 3_600_000;
    const duration =
      typeof market.duration === 'number' && market.duration > 0
        ? market.duration
        : Number.isFinite(rawDiffHours) && rawDiffHours > 0
        ? Math.max(0.001389, Number(rawDiffHours.toFixed(6)))
        : 720;

    return {
      ...market,
      duration,
      creator,
      outcomes: { yes, no },
      yesProbability,
      noProbability,
      change24hPct,
    };
  }
}

export const store = new LocalStore();

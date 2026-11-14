/**
 * Zolymarket — Express + Vite Full-Stack Server (Port 3000)
 *
 * - Serves bootstrap & node integration REST API routes under `/api/*`
 * - Exposes Phase 2 `zingo-cli` endpoints backed by `lib/zcash-service.ts`
 * - Serves Firebase blueprint & Firestore rules metadata via `/api/schema`
 * - Integrates Vite dev middleware in development or static `dist/` assets in production
 */

import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { store } from './src/server/store.ts';
import { BatchPayoutItem, MarketCategory, OutcomeSide } from './src/types/database.ts';
import { SCHEMA_TABLES } from './src/lib/schemaDocs.ts';
import {
  ZingoCliError,
  checkZingoCliStatus,
  createNewMarketWallet,
  executeBatchPayout,
  pollMempoolForBets,
} from './lib/zcash-service.ts';
import {
  PollarServiceError,
  getPollarIntegrationStatus,
  getPollarUserRampOrders,
  getPollarUserTxHistory,
  getPollarUserWallets,
  provisionPollarUserWithWallet,
} from './lib/pollar-service.ts';

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json());

  const server = http.createServer(app);

  // ---------------------------------------------------------------------------
  // Market & Schema Routes
  // ---------------------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'zolymarket',
      database: 'firebase-firestore',
      phase: 2,
    });
  });

  app.get('/api/markets', (_req, res) => {
    try {
      const markets = store.listMarketsWithDetails();
      res.json({ markets });
    } catch (error) {
      console.error('Error listing markets:', error);
      res.status(500).json({ error: 'Failed to load markets.' });
    }
  });

  app.get('/api/markets/:idOrSlug', (req, res) => {
    try {
      const market = store.getMarketByIdOrSlug(req.params.idOrSlug);
      if (!market) {
        return res.status(404).json({ error: 'Market not found.' });
      }
      const bets = store.listShieldedBets(market.id);
      return res.json({ market, bets });
    } catch (error) {
      console.error('Error loading market details:', error);
      return res.status(500).json({ error: 'Failed to load market details.' });
    }
  });

  app.post('/api/markets', (req, res) => {
    try {
      const body = req.body as {
        id?: string;
        slug?: string;
        creatorId?: string;
        ownerUid?: string;
        creatorDisplayName?: string;
        creatorHandle?: string;
        creatorPayoutAddress?: string;
        question?: string;
        description?: string;
        resolutionCriteria?: string;
        category?: MarketCategory;
        shieldedPoolAddress?: string;
        duration?: number;
        closesAt?: string;
      };

      if (
        !body.id ||
        !body.slug ||
        !body.creatorId ||
        !body.question ||
        !body.creatorPayoutAddress ||
        !body.shieldedPoolAddress ||
        !body.closesAt
      ) {
        return res.status(400).json({ error: 'Missing required market creation fields.' });
      }

      const market = store.createHostMarket({
        id: body.id,
        slug: body.slug,
        creatorId: body.creatorId,
        ownerUid: body.ownerUid,
        creatorDisplayName: body.creatorDisplayName || 'Market Host',
        creatorHandle: body.creatorHandle || 'host_creator',
        creatorPayoutAddress: body.creatorPayoutAddress,
        question: body.question,
        description:
          body.description ||
          'Creator-hosted shielded prediction market settled via Zcash Unified Addresses.',
        resolutionCriteria:
          body.resolutionCriteria ||
          `Market creator resolves YES or NO upon outcome verification before ${body.closesAt}.`,
        category: body.category || MarketCategory.CreatorBets,
        shieldedPoolAddress: body.shieldedPoolAddress,
        duration: typeof body.duration === 'number' ? body.duration : undefined,
        closesAt: body.closesAt,
      });

      return res.status(201).json({ market });
    } catch (error) {
      console.error('Error creating host market:', error);
      return res.status(500).json({ error: 'Failed to create market.' });
    }
  });

  app.post('/api/markets/:id/lock', (req, res) => {
    try {
      const market = store.lockMarket(req.params.id);
      if (!market) {
        return res.status(404).json({ error: 'Market not found.' });
      }
      return res.json({ market });
    } catch (error) {
      console.error('Error locking market:', error);
      return res.status(500).json({ error: 'Failed to lock market.' });
    }
  });

  app.post('/api/markets/:id/resolve', async (req, res) => {
    try {
      const { winningOutcome } = req.body as { winningOutcome?: string };
      if (winningOutcome !== OutcomeSide.Yes && winningOutcome !== OutcomeSide.No) {
        return res.status(400).json({ error: 'winningOutcome must be YES or NO.' });
      }

      const resolved = store.resolveMarket(req.params.id, winningOutcome);
      if (!resolved) {
        return res.status(404).json({ error: 'Market not found.' });
      }

      let payoutResult = null;
      let payoutNote = 'No settled shielded bets in pool yet.';

      if (resolved.payoutItems.length > 0) {
        try {
          payoutResult = await executeBatchPayout(resolved.payoutItems);
          payoutNote = `Executed batch payout to ${payoutResult.recipientCount} recipient(s).`;
        } catch (err) {
          payoutNote =
            err instanceof Error
              ? `Market resolved in Firestore; zingo-cli batch payout deferred (${err.message}).`
              : 'Market resolved in Firestore; zingo-cli batch payout deferred.';
        }
      }

      return res.json({
        market: resolved.market,
        payoutItems: resolved.payoutItems,
        payoutResult,
        payoutNote,
      });
    } catch (error) {
      console.error('Error resolving market:', error);
      return res.status(500).json({ error: 'Failed to resolve market.' });
    }
  });

  app.get('/api/creators', (_req, res) => {
    try {
      const creators = store.listCreators();
      res.json({ creators });
    } catch (error) {
      console.error('Error listing creators:', error);
      res.status(500).json({ error: 'Failed to load creators.' });
    }
  });

  app.get('/api/bets', (req, res) => {
    try {
      const marketId =
        typeof req.query.marketId === 'string' ? req.query.marketId : undefined;
      const bets = store.listShieldedBets(marketId);
      res.json({ bets });
    } catch (error) {
      console.error('Error listing shielded bets:', error);
      res.status(500).json({ error: 'Failed to load shielded bets.' });
    }
  });

  app.get('/api/schema', (_req, res) => {
    try {
      const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
      const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');
      const rules = fs.existsSync(rulesPath)
        ? fs.readFileSync(rulesPath, 'utf-8')
        : '// firestore.rules not found';
      const blueprint = fs.existsSync(blueprintPath)
        ? fs.readFileSync(blueprintPath, 'utf-8')
        : '{}';
      res.json({
        tables: SCHEMA_TABLES,
        rules,
        blueprint,
      });
    } catch (error) {
      console.error('Error reading Firebase schema artifacts:', error);
      res.status(500).json({ error: 'Failed to read schema artifacts.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 2 Zcash Node Integration Routes (zingo-cli)
  // ---------------------------------------------------------------------------

  app.get('/api/zcash/status', async (_req, res) => {
    try {
      const status = await checkZingoCliStatus();
      res.json(status);
    } catch (error) {
      console.error('Unexpected zingo-cli status error:', error);
      res.status(500).json({
        available: false,
        version: null,
        binary: process.env.ZINGO_CLI_BIN || 'zingo-cli',
        chain: process.env.ZINGO_CHAIN || 'testnet',
        serverUri: process.env.ZINGO_SERVER_URI || null,
        dataDir: process.env.ZINGO_DATA_DIR || null,
        dataDirExists: null,
        error: 'Failed to inspect zingo-cli status.',
      });
    }
  });

  app.post('/api/zcash/wallet', async (_req, res) => {
    try {
      const credentials = await createNewMarketWallet();
      res.json(credentials);
    } catch (error) {
      if (error instanceof ZingoCliError) {
        const status = error.code === 'ZINGO_CLI_NOT_FOUND' ? 503 : 502;
        return res.status(status).json({ error: error.message, code: error.code });
      }
      console.error('Unexpected wallet creation error:', error);
      return res.status(500).json({ error: 'Failed to create Zcash market wallet.' });
    }
  });

  app.post('/api/zcash/poll', async (req, res) => {
    try {
      const { marketId, address } = req.body as {
        marketId?: string;
        address?: string;
      };
      if (!marketId || !address) {
        return res
          .status(400)
          .json({ error: 'marketId and address are required.' });
      }
      const result = await pollMempoolForBets(marketId, address);
      return res.json(result);
    } catch (error) {
      if (error instanceof ZingoCliError) {
        const status =
          error.code === 'INVALID_INPUT'
            ? 400
            : error.code === 'ZINGO_CLI_NOT_FOUND'
            ? 503
            : 502;
        return res.status(status).json({ error: error.message, code: error.code });
      }
      console.error('Unexpected mempool poll error:', error);
      return res.status(500).json({ error: 'Failed to poll Zcash mempool.' });
    }
  });

  app.post('/api/zcash/payout', async (req, res) => {
    try {
      const { payouts } = req.body as { payouts?: BatchPayoutItem[] };
      if (!Array.isArray(payouts) || payouts.length === 0) {
        return res
          .status(400)
          .json({ error: 'Non-empty payouts array is required.' });
      }
      const result = await executeBatchPayout(payouts);
      return res.json(result);
    } catch (error) {
      if (error instanceof ZingoCliError) {
        const status =
          error.code === 'INVALID_INPUT'
            ? 400
            : error.code === 'ZINGO_CLI_NOT_FOUND'
            ? 503
            : 502;
        return res.status(status).json({ error: error.message, code: error.code });
      }
      console.error('Unexpected batch payout error:', error);
      return res.status(500).json({ error: 'Failed to execute batch payout.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Pollar Multichain Server API v3 Proxy Routes (Zero-VPS Settlement Rail)
  // ---------------------------------------------------------------------------

  app.get('/api/pollar/status', (_req, res) => {
    res.json(getPollarIntegrationStatus());
  });

  app.post('/api/pollar/users/provision', async (req, res) => {
    try {
      const { externalUserId, email, name } = req.body as {
        externalUserId?: string;
        email?: string;
        name?: string;
      };
      if (!externalUserId) {
        return res.status(400).json({ error: 'externalUserId is required.' });
      }
      const data = await provisionPollarUserWithWallet({ externalUserId, email, name });
      return res.status(201).json({ data });
    } catch (error) {
      if (error instanceof PollarServiceError) {
        return res
          .status(error.statusCode)
          .json({ error: error.message, code: error.code });
      }
      console.error('Unexpected Pollar provision error:', error);
      return res.status(500).json({ error: 'Failed to provision Pollar user.' });
    }
  });

  app.get('/api/pollar/users/:externalUserId/wallets', async (req, res) => {
    try {
      const data = await getPollarUserWallets(req.params.externalUserId);
      return res.json({ data });
    } catch (error) {
      if (error instanceof PollarServiceError) {
        return res
          .status(error.statusCode)
          .json({ error: error.message, code: error.code });
      }
      console.error('Unexpected Pollar wallets error:', error);
      return res.status(500).json({ error: 'Failed to fetch Pollar user wallets.' });
    }
  });

  app.get('/api/pollar/users/:externalUserId/ramps', async (req, res) => {
    try {
      const data = await getPollarUserRampOrders(req.params.externalUserId);
      return res.json({ data });
    } catch (error) {
      if (error instanceof PollarServiceError) {
        return res
          .status(error.statusCode)
          .json({ error: error.message, code: error.code });
      }
      console.error('Unexpected Pollar ramps error:', error);
      return res.status(500).json({ error: 'Failed to fetch Pollar ramp orders.' });
    }
  });

  app.get('/api/pollar/users/:externalUserId/history', async (req, res) => {
    try {
      const chain = typeof req.query.chain === 'string' ? req.query.chain : undefined;
      const data = await getPollarUserTxHistory(req.params.externalUserId, chain);
      return res.json({ data });
    } catch (error) {
      if (error instanceof PollarServiceError) {
        return res
          .status(error.statusCode)
          .json({ error: error.message, code: error.code });
      }
      console.error('Unexpected Pollar history error:', error);
      return res.status(500).json({ error: 'Failed to fetch Pollar transaction history.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Vite Middleware (Dev) or Static Dist Serving (Prod)
  // ---------------------------------------------------------------------------
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Zolymarket server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

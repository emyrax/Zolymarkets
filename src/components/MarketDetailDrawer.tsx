/**
 * Zolymarket — Phase 1 Market Detail & ZIP-321 Contract Inspector Drawer
 *
 * Displays CPMM reserve balances, creator fee parameters, resolution criteria,
 * and a live-generated ZIP-321 payment URI preview for the selected market.
 */

import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Copy, Check, ExternalLink } from 'lucide-react';
import { MarketWithDetails, OutcomeSide } from '../types/database.ts';
import { estimateSharesOut, formatZec, zecToZatoshis } from '../lib/cpmm.ts';
import { buildZip321Uri } from '../lib/zip321.ts';
import { formatShortTxid, getZcashTxExplorerUrls } from '../lib/explorers.ts';
import { SentimentTrendChart } from './SentimentTrendChart.tsx';
import { MarketCountdown } from './MarketCountdown.tsx';

interface MarketDetailDrawerProps {
  market: MarketWithDetails | null;
  onClose: () => void;
  onOpenRoom?: (marketId: string) => void;
}

export const MarketDetailDrawer: React.FC<MarketDetailDrawerProps> = ({
  market,
  onClose,
  onOpenRoom,
}) => {
  const [previewSide, setPreviewSide] = useState<OutcomeSide>(OutcomeSide.Yes);
  const [previewAmount, setPreviewAmount] = useState<string>('1.0');
  const [copiedUri, setCopiedUri] = useState<boolean>(false);

  const parsedZec = Number.parseFloat(previewAmount);
  const validZec = Number.isFinite(parsedZec) && parsedZec > 0 ? parsedZec : 1.0;

  const zip321Preview = useMemo(() => {
    if (!market) return null;
    try {
      return buildZip321Uri({
        address: market.shieldedPoolAddress,
        amountZec: validZec,
        marketId: market.id.slice(0, 8),
        side: previewSide,
        commitment: 'demo_commitment_sha256',
      });
    } catch {
      return null;
    }
  }, [market, previewSide, validZec]);

  const quote = useMemo(() => {
    if (!market) return null;
    const isYes = previewSide === OutcomeSide.Yes;
    return estimateSharesOut({
      amountZatoshis: zecToZatoshis(validZec),
      targetPoolZatoshis: isYes
        ? market.outcomes.yes.poolZatoshis
        : market.outcomes.no.poolZatoshis,
      oppositePoolZatoshis: isYes
        ? market.outcomes.no.poolZatoshis
        : market.outcomes.yes.poolZatoshis,
      creatorFeeBps: market.creatorFeeBps,
    });
  }, [market, previewSide, validZec]);

  const handleCopyUri = async () => {
    if (!zip321Preview) return;
    try {
      await navigator.clipboard.writeText(zip321Preview.uri);
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 1800);
    } catch {
      // Clipboard fallback ignored in restricted frames
    }
  };

  return (
    <AnimatePresence>
      {market && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 bg-slate-900/35 backdrop-blur-[1px]"
          />

          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            aria-label="Market details"
            className="relative z-10 w-full max-w-xl bg-white h-full border-l border-slate-200 overflow-y-auto flex flex-col"
          >
            <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-slate-200 flex items-start justify-between gap-3 sm:gap-4">
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{market.category}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">Created by {market.creator.displayName}</span>
                </div>
                <h2 className="font-display text-base sm:text-lg font-semibold text-slate-900 leading-snug">
                  {market.question}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close market drawer"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 sm:p-6 space-y-5 sm:space-y-6 flex-1">
              {/* Lock Period Countdown */}
              <MarketCountdown market={market} variant="drawer" />

              {/* CPMM Pool State */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-500">
                  CPMM Reserve State
                </h3>
                <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3 sm:gap-4">
                  <div className="p-3.5 sm:p-4 border border-slate-200 rounded-lg bg-slate-50/50">
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span className="font-semibold text-emerald-700">YES Pool</span>
                      <span className="font-mono tabular-nums">{market.yesProbability.toFixed(1)}%</span>
                    </div>
                    <p className="mt-1 font-mono text-base font-semibold text-slate-900 tabular-nums">
                      {formatZec(market.outcomes.yes.poolZatoshis, 2)}
                    </p>
                  </div>
                  <div className="p-3.5 sm:p-4 border border-slate-200 rounded-lg bg-slate-50/50">
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span className="font-semibold text-rose-700">NO Pool</span>
                      <span className="font-mono tabular-nums">{market.noProbability.toFixed(1)}%</span>
                    </div>
                    <p className="mt-1 font-mono text-base font-semibold text-slate-900 tabular-nums">
                      {formatZec(market.outcomes.no.poolZatoshis, 2)}
                    </p>
                  </div>
                </div>
              </section>

              {/* Recharts Sentiment Trend (YES vs NO probability over Firestore volume) */}
              <SentimentTrendChart market={market} />

              {/* Resolution Criteria */}
              <section className="space-y-2 pt-4 border-t border-slate-100">
                <h3 className="text-xs font-semibold text-slate-500">
                  Resolution Criteria
                </h3>
                <p className="text-sm text-slate-700 leading-relaxed">{market.resolutionCriteria}</p>
                <div className="pt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 font-mono tabular-nums">
                  <span>Creator Fee: {(market.creatorFeeBps / 100).toFixed(2)}%</span>
                  <span aria-hidden="true">·</span>
                  <span>Status: {market.status.toUpperCase()}</span>
                  {market.creationTxid && (
                    <>
                      <span aria-hidden="true">·</span>
                      <a
                        href={
                          getZcashTxExplorerUrls(
                            market.creationTxid,
                            market.shieldedPoolAddress
                          ).primaryUrl
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-900 underline underline-offset-2"
                      >
                        <span>Creation Tx: {formatShortTxid(market.creationTxid, 6, 4)}</span>
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                      </a>
                    </>
                  )}
                </div>
              </section>

              {/* Phase 1 ZIP-321 URI & Quote Preview */}
              <section className="space-y-3 pt-4 border-t border-slate-100">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-xs font-semibold text-slate-500">
                    ZIP-321 Request Preview
                  </h3>
                  {onOpenRoom && (
                    <button
                      type="button"
                      onClick={() => onOpenRoom(market.id)}
                      className="min-h-[36px] text-xs font-semibold text-amber-700 hover:text-amber-800 cursor-pointer whitespace-nowrap"
                    >
                      Open Betting Room →
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <div className="inline-flex p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setPreviewSide(OutcomeSide.Yes)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                        previewSide === OutcomeSide.Yes
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      YES
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewSide(OutcomeSide.No)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                        previewSide === OutcomeSide.No
                          ? 'bg-rose-600 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      NO
                    </button>
                  </div>

                  <div className="flex-1">
                    <label htmlFor="preview-zec-amount" className="sr-only">
                      Amount in ZEC
                    </label>
                    <input
                      id="preview-zec-amount"
                      type="number"
                      min="0.01"
                      step="0.1"
                      value={previewAmount}
                      onChange={(e) => setPreviewAmount(e.target.value)}
                      className="w-full px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-600"
                    />
                  </div>
                </div>

                {quote && (
                  <div className="text-xs text-slate-600 font-mono tabular-nums flex items-center justify-between">
                    <span>Est. Shares: {quote.sharesOut.toFixed(4)}</span>
                    <span>Fee: {formatZec(quote.feeZatoshis, 4)}</span>
                  </div>
                )}

                {zip321Preview && (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-600">Generated URI</span>
                      <button
                        type="button"
                        onClick={handleCopyUri}
                        className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:text-amber-700 cursor-pointer"
                      >
                        {copiedUri ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy URI</span>
                          </>
                        )}
                      </button>
                    </div>
                    <p className="font-mono text-xs text-slate-800 break-all select-all">
                      {zip321Preview.uri}
                    </p>
                    <p className="font-mono text-[11px] text-slate-500 break-all">
                      Decoded Memo: {zip321Preview.memoPayload}
                    </p>
                  </div>
                )}
              </section>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
};

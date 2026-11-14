/**
 * Zolymarket — Prediction Market Card Component
 *
 * Displays a binary Zcash creator market with CPMM implied YES/NO odds,
 * tabular ZEC volume, and clean unboxed metadata separators.
 */

import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Minus } from 'lucide-react';
import { MarketWithDetails } from '../types/database.ts';
import { formatZec } from '../lib/cpmm.ts';
import { MarketCountdown } from './MarketCountdown.tsx';

interface MarketCardProps {
  market: MarketWithDetails;
  onSelect: (market: MarketWithDetails) => void;
  onOpenRoom?: (marketId: string) => void;
}

export const MarketCard: React.FC<MarketCardProps> = ({ market, onSelect, onOpenRoom }) => {
  const change = market.change24hPct ?? 0;
  const isUp = change > 0;
  const isDown = change < 0;

  return (
    <article className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-5 transition-colors hover:border-slate-300">
      <div className="space-y-3">
        {/* Quiet unboxed metadata line */}
        <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-1.5 truncate">
            <span className="font-medium text-slate-700">{market.category}</span>
            <span aria-hidden="true">·</span>
            <span>@{market.creator.handle}</span>
          </div>
          <MarketCountdown market={market} variant="card" />
        </div>

        {/* Market question */}
        <button
          type="button"
          onClick={() => onSelect(market)}
          className="text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 rounded"
        >
          <h3 className="font-display text-base font-semibold text-slate-900 leading-snug group-hover:text-amber-700 transition-colors">
            {market.question}
          </h3>
        </button>
      </div>

      <div className="space-y-4">
        {/* CPMM Probability Split Bar */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2 text-xs font-medium">
            <div className="flex items-center gap-2 font-mono tabular-nums">
              <span className="text-emerald-700">
                YES {market.yesProbability.toFixed(1)}%
              </span>
              <span
                className={`inline-flex items-center gap-0.5 text-[11px] font-medium whitespace-nowrap ${
                  isUp
                    ? 'text-emerald-700'
                    : isDown
                    ? 'text-rose-700'
                    : 'text-slate-500'
                }`}
                title="24-hour market movement"
                aria-label={`24-hour market movement: ${isUp ? 'up' : isDown ? 'down' : 'unchanged'} ${Math.abs(change).toFixed(1)} percent`}
              >
                {isUp ? (
                  <ArrowUp className="w-3 h-3 shrink-0" aria-hidden="true" />
                ) : isDown ? (
                  <ArrowDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                ) : (
                  <Minus className="w-3 h-3 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {isUp ? '+' : isDown ? '-' : ''}
                  {Math.abs(change).toFixed(1)}%
                </span>
              </span>
            </div>
            <span className="text-rose-700 font-mono tabular-nums">
              NO {market.noProbability.toFixed(1)}%
            </span>
          </div>
          <div
            className="h-2 w-full bg-rose-100 rounded-sm overflow-hidden flex"
            role="img"
            aria-label={`YES probability ${market.yesProbability}% vs NO probability ${market.noProbability}%`}
          >
            <div
              className="h-full bg-emerald-600 transition-all duration-300"
              style={{ width: `${market.yesProbability}%` }}
            />
          </div>
        </div>

        {/* Footer metrics & action */}
        <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-3 font-mono tabular-nums">
            <span>Vol {formatZec(market.totalVolumeZatoshis, 1)}</span>
            <span aria-hidden="true">·</span>
            <span>Liq {formatZec(market.liquidityZatoshis, 1)}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => onSelect(market)}
              className="font-sans font-medium text-slate-600 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Inspect
            </button>
            {onOpenRoom && (
              <button
                type="button"
                onClick={() => onOpenRoom(market.id)}
                className="inline-flex items-center gap-1 font-sans font-semibold text-slate-900 hover:text-amber-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Bet</span>
                <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};

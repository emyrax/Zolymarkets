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
    <article className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg p-4 sm:p-5 flex flex-col justify-between gap-4 sm:gap-5 transition-colors hover:border-[var(--border-subtle)] hover-glow min-w-0">
      <div className="space-y-3 min-w-0">
        {/* Quiet unboxed metadata line */}
        <div className="flex items-center justify-between gap-2.5 text-xs var(--text-muted)">
          <div className="flex items-center gap-1.5 min-w-0 truncate">
            <span className="font-medium var(--text-secondary) truncate">{market.category}</span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="truncate">@{market.creator.handle}</span>
          </div>
          <MarketCountdown market={market} variant="card" />
        </div>

        {/* Market question */}
        <button
          type="button"
          onClick={() => onSelect(market)}
          className="w-full text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] rounded py-0.5 hover-glow"
        >
          <h3 className="font-display text-base font-semibold var(--text-primary) leading-snug group-hover:text-[var(--accent-blue)] transition-colors break-words">
            {market.question}
          </h3>
        </button>
      </div>

      <div className="space-y-4">
        {/* CPMM Probability Split Bar */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2 text-xs font-medium">
            <div className="flex items-center gap-1.5 sm:gap-2 font-mono tabular-nums min-w-0">
              <span className="var(--accent-cyan) whitespace-nowrap">
                YES {market.yesProbability.toFixed(1)}%
              </span>
              <span
                className={`inline-flex items-center gap-0.5 text-[11px] font-medium whitespace-nowrap ${
                  isUp
                    ? 'var(--accent-cyan)'
                    : isDown
                    ? 'var(--accent-yellow)'
                    : 'var(--text-muted)'
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
            <span className="var(--accent-yellow) font-mono tabular-nums whitespace-nowrap shrink-0">
              NO {market.noProbability.toFixed(1)}%
            </span>
          </div>
          <div
            className="h-2 w-full bg-[var(--border-subtle)] rounded-sm overflow-hidden flex"
            role="img"
            aria-label={`YES probability ${market.yesProbability}% vs NO probability ${market.noProbability}%`}
          >
            <div
              className="h-full bg-[var(--accent-blue)] transition-all duration-300"
              style={{ width: `${market.yesProbability}%` }}
            />
          </div>
        </div>

        {/* Footer metrics & action */}
        <div className="pt-2.5 border-t border var(--border-subtle) flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs var(--text-muted)">
          <div className="flex items-center gap-2 sm:gap-3 font-mono tabular-nums">
            <span>Vol {formatZec(market.totalVolumeZatoshis, 1)}</span>
            <span aria-hidden="true">·</span>
            <span>Liq {formatZec(market.liquidityZatoshis, 1)}</span>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0 ml-auto">
            <button
              type="button"
              onClick={() => onSelect(market)}
              className="min-h-[36px] px-2.5 py-1.5 font-sans font-medium var(--text-secondary) hover:text-[var(--text-primary)] rounded-md hover:bg-[var(--border-subtle)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Inspect
            </button>
            {onOpenRoom && (
              <button
                type="button"
                onClick={() => onOpenRoom(market.id)}
                className="min-h-[36px] px-2.5 py-1.5 inline-flex items-center gap-1 font-sans font-semibold var(--text-primary) hover:text-[var(--accent-blue)] rounded-md hover:bg-[rgba(59,130,246,0.1)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
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

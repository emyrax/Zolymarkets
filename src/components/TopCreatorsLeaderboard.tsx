/**
 * Zolymarket — Top Creators Leaderboard Component
 *
 * Ranks creators using live Cloud Firestore `creators` and `markets` streams
 * by total shielded betting volume (ZEC) and total markets successfully resolved.
 */

import React, { useMemo, useState } from 'react';
import { Trophy } from 'lucide-react';
import { formatZec } from '../lib/cpmm.ts';
import { Creator, MarketStatus, MarketWithDetails } from '../types/database.ts';

interface TopCreatorsLeaderboardProps {
  creators: Creator[];
  markets: MarketWithDetails[];
}

type SortMetric = 'volume' | 'resolved';

interface RankedCreatorRow {
  creator: Creator;
  resolvedCount: number;
  totalMarketsCount: number;
  totalVolumeZatoshis: number;
}

export const TopCreatorsLeaderboard: React.FC<TopCreatorsLeaderboardProps> = ({
  creators,
  markets,
}) => {
  const [sortBy, setSortBy] = useState<SortMetric>('volume');

  const rankedCreators = useMemo<RankedCreatorRow[]>(() => {
    const rows: RankedCreatorRow[] = creators.map((creator) => {
      const creatorMarkets = markets.filter((m) => m.creatorId === creator.id);
      const resolvedCount = creatorMarkets.filter(
        (m) => m.status === MarketStatus.Resolved
      ).length;
      const marketVolumeSum = creatorMarkets.reduce(
        (sum, m) => sum + m.totalVolumeZatoshis,
        0
      );

      return {
        creator,
        resolvedCount,
        totalMarketsCount: Math.max(creator.marketsCreatedCount, creatorMarkets.length),
        totalVolumeZatoshis: Math.max(creator.totalVolumeZatoshis, marketVolumeSum),
      };
    });

    rows.sort((a, b) => {
      if (sortBy === 'resolved') {
        if (b.resolvedCount !== a.resolvedCount) {
          return b.resolvedCount - a.resolvedCount;
        }
        return b.totalVolumeZatoshis - a.totalVolumeZatoshis;
      }
      if (b.totalVolumeZatoshis !== a.totalVolumeZatoshis) {
        return b.totalVolumeZatoshis - a.totalVolumeZatoshis;
      }
      return b.resolvedCount - a.resolvedCount;
    });

    return rows;
  }, [creators, markets, sortBy]);

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 sm:gap-4">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base font-semibold text-slate-900">
              Top Creators Leaderboard
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            Ranked by cumulative shielded ZEC volume and successfully resolved markets.
          </p>
        </div>

        <div
          role="group"
          aria-label="Sort leaderboard by"
          className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg max-w-full overflow-x-auto no-scrollbar"
        >
          <button
            type="button"
            onClick={() => setSortBy('volume')}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors duration-150 whitespace-nowrap cursor-pointer ${
              sortBy === 'volume'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Total Volume
          </button>
          <button
            type="button"
            onClick={() => setSortBy('resolved')}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors duration-150 whitespace-nowrap cursor-pointer ${
              sortBy === 'resolved'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Resolved Markets
          </button>
        </div>
      </div>

      {rankedCreators.length === 0 ? (
        <div className="p-6 sm:p-8 text-center text-xs text-slate-500">
          No creators indexed in Cloud Firestore yet. Launch a market above to appear on the
          leaderboard.
        </div>
      ) : (
        <>
          {/* Mobile Stacked Leaderboard */}
          <div className="md:hidden divide-y divide-slate-100">
            {rankedCreators.map((row, index) => {
              const rank = index + 1;
              return (
                <div key={row.creator.id} className="p-4 flex items-center justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <span
                      className={`font-mono tabular-nums text-sm font-semibold shrink-0 ${
                        rank === 1 ? 'text-amber-700' : 'text-slate-500'
                      }`}
                    >
                      #{rank}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-slate-900 truncate">
                        {row.creator.displayName}
                      </p>
                      <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-1.5">
                        <span>@{row.creator.handle}</span>
                        {row.creator.verified && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-emerald-700 font-medium">Verified</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right font-mono tabular-nums shrink-0">
                    <p className="text-sm font-semibold text-slate-900">
                      {formatZec(row.totalVolumeZatoshis, 2)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {row.resolvedCount}/{row.totalMarketsCount} resolved
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-500">
                  <th className="py-3 px-6 w-16">Rank</th>
                  <th className="py-3 px-4">Creator</th>
                  <th className="py-3 px-4 text-right">Markets Resolved</th>
                  <th className="py-3 px-4 text-right">Total Markets</th>
                  <th className="py-3 px-6 text-right">Total Volume</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {rankedCreators.map((row, index) => {
                  const rank = index + 1;
                  return (
                    <tr key={row.creator.id} className="hover:bg-slate-50/70 transition-colors">
                      <td
                        className={`py-3.5 px-6 font-mono tabular-nums font-semibold ${
                          rank === 1 ? 'text-amber-700' : 'text-slate-500'
                        }`}
                      >
                        #{rank}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-900">
                          {row.creator.displayName}
                        </div>
                        <div className="text-xs text-slate-500 flex items-center gap-1.5">
                          <span>@{row.creator.handle}</span>
                          {row.creator.verified && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-emerald-700 font-medium">Verified</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {row.resolvedCount}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-600">
                        {row.totalMarketsCount}
                      </td>
                      <td className="py-3.5 px-6 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {formatZec(row.totalVolumeZatoshis, 2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
};

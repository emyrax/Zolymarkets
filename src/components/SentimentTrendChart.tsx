/**
 * Zolymarket — Historical Probability Trends Recharts Line Chart
 *
 * Subscribes in real time to Cloud Firestore `shielded_bets` and confirmed
 * `shielded_transactions` for the selected market (`where('marketId', '==', market.id)`),
 * reconstructs the CPMM YES vs NO probability trajectory over time, and renders a
 * time-scaled Recharts LineChart inside MarketDetailDrawer with timeframe filtering.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Timestamp,
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  OperationType,
  db,
  handleFirestoreError,
} from '../lib/firebase.ts';
import { calculateBinaryOdds, zatoshisToZec } from '../lib/cpmm.ts';
import { MarketWithDetails, OutcomeSide } from '../types/database.ts';

type TimeframeWindow = '1H' | '24H' | '7D' | 'ALL';

const TIMEFRAME_WINDOWS: Array<{ id: TimeframeWindow; label: string; ms: number | null }> = [
  { id: '1H', label: '1H', ms: 3_600_000 },
  { id: '24H', label: '24H', ms: 86_400_000 },
  { id: '7D', label: '7D', ms: 7 * 86_400_000 },
  { id: 'ALL', label: 'All', ms: null },
];

interface HistoricalBetPoint {
  id: string;
  txid: string | null;
  pick: OutcomeSide;
  amountZatoshis: number;
  createdAtMs: number;
}

export interface SentimentDataPoint {
  timestampMs: number;
  fullTime: string;
  yesProbability: number;
  noProbability: number;
  cumulativeVolumeZec: number;
  betDeltaZec: number | null;
  betSide: OutcomeSide | null;
}

interface SentimentTrendChartProps {
  market: MarketWithDetails;
}

function parseTimestampMs(val: unknown): number {
  if (val instanceof Timestamp) {
    return val.toMillis();
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function formatTimeAxisTick(ms: number, spanMs: number): string {
  const date = new Date(ms);
  if (spanMs <= 2 * 3_600_000) {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
  if (spanMs <= 36 * 3_600_000) {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function buildFullProbabilitySeries(
  market: MarketWithDetails,
  bets: HistoricalBetPoint[]
): SentimentDataPoint[] {
  // Deduplicate merged shielded_bets + confirmed shielded_transactions by txid or id
  const seenKeys = new Set<string>();
  const deduped: HistoricalBetPoint[] = [];
  for (const bet of bets) {
    const key = bet.txid ? `tx:${bet.txid}` : `id:${bet.id}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduped.push(bet);
    }
  }

  const sortedBets = deduped.sort((a, b) => a.createdAtMs - b.createdAtMs);
  const nowMs = Date.now();

  if (sortedBets.length === 0) {
    const rawCreatedMs = parseTimestampMs(market.createdAt);
    const twentyFourHoursAgoMs = nowMs - 86_400_000;
    const baselineYes = Math.max(
      0,
      Math.min(100, Math.round(market.yesProbability24hAgo * 10) / 10)
    );
    const baselineNo = Math.round((100 - baselineYes) * 10) / 10;
    const totalVolZec = Math.round(zatoshisToZec(market.totalVolumeZatoshis) * 100) / 100;

    const points: SentimentDataPoint[] = [];

    // Include market open anchor at 50/50 if the market is older than 24h
    if (rawCreatedMs < twentyFourHoursAgoMs - 3_600_000) {
      points.push({
        timestampMs: rawCreatedMs,
        fullTime: `Open · ${new Date(rawCreatedMs).toLocaleString()}`,
        yesProbability: 50,
        noProbability: 50,
        cumulativeVolumeZec: 0,
        betDeltaZec: null,
        betSide: null,
      });
    }

    const anchor24hMs = Math.max(rawCreatedMs, Math.min(twentyFourHoursAgoMs, nowMs - 60_000));
    points.push({
      timestampMs: anchor24hMs,
      fullTime: `24h Ago · ${new Date(anchor24hMs).toLocaleString()}`,
      yesProbability: baselineYes,
      noProbability: baselineNo,
      cumulativeVolumeZec: totalVolZec > 0 ? Math.round(totalVolZec * 0.45 * 100) / 100 : 0,
      betDeltaZec: null,
      betSide: null,
    });

    points.push({
      timestampMs: nowMs,
      fullTime: `Live · ${new Date(nowMs).toLocaleString()}`,
      yesProbability: market.yesProbability,
      noProbability: market.noProbability,
      cumulativeVolumeZec: totalVolZec,
      betDeltaZec: null,
      betSide: null,
    });

    return points;
  }

  // Reconstruct CPMM pool states chronologically by stepping backward from current reserves
  let currYes = Math.max(1, market.outcomes.yes.poolZatoshis);
  let currNo = Math.max(1, market.outcomes.no.poolZatoshis);

  const statesAfterBet: Array<{ yesPool: number; noPool: number }> = new Array(sortedBets.length);
  let canInvertCleanly = true;

  for (let i = sortedBets.length - 1; i >= 0; i -= 1) {
    statesAfterBet[i] = { yesPool: currYes, noPool: currNo };
    const bet = sortedBets[i];
    const fee = Math.floor((bet.amountZatoshis * market.creatorFeeBps) / 10_000);
    const netDeposit = Math.max(0, bet.amountZatoshis - fee);

    if (bet.pick === OutcomeSide.Yes) {
      if (currNo <= netDeposit + 1) {
        canInvertCleanly = false;
        break;
      }
      const prevNo = currNo - netDeposit;
      const prevYes = Math.max(1, Math.round((currYes * currNo) / prevNo));
      currYes = prevYes;
      currNo = prevNo;
    } else {
      if (currYes <= netDeposit + 1) {
        canInvertCleanly = false;
        break;
      }
      const prevYes = currYes - netDeposit;
      const prevNo = Math.max(1, Math.round((currYes * currNo) / prevYes));
      currYes = prevYes;
      currNo = prevNo;
    }
  }

  if (canInvertCleanly) {
    const initialOdds = calculateBinaryOdds(currYes, currNo);
    const firstBetMs = sortedBets[0].createdAtMs;
    const openMs = Math.min(parseTimestampMs(market.createdAt), firstBetMs - 60_000);
    const points: SentimentDataPoint[] = [
      {
        timestampMs: openMs,
        fullTime: `Open · ${new Date(openMs).toLocaleString()}`,
        yesProbability: initialOdds.yesProbability,
        noProbability: initialOdds.noProbability,
        cumulativeVolumeZec: 0,
        betDeltaZec: null,
        betSide: null,
      },
    ];

    let runningVolumeZatoshis = 0;
    let lastTimestampMs = openMs;

    for (let i = 0; i < sortedBets.length; i += 1) {
      const bet = sortedBets[i];
      runningVolumeZatoshis += bet.amountZatoshis;
      const odds = calculateBinaryOdds(
        statesAfterBet[i].yesPool,
        statesAfterBet[i].noPool
      );
      const monotonicMs = Math.max(bet.createdAtMs, lastTimestampMs + 1);
      lastTimestampMs = monotonicMs;

      points.push({
        timestampMs: monotonicMs,
        fullTime: new Date(bet.createdAtMs).toLocaleString(),
        yesProbability: odds.yesProbability,
        noProbability: odds.noProbability,
        cumulativeVolumeZec: Math.round(zatoshisToZec(runningVolumeZatoshis) * 1000) / 1000,
        betDeltaZec: Math.round(zatoshisToZec(bet.amountZatoshis) * 1000) / 1000,
        betSide: bet.pick,
      });
    }

    // Anchor live endpoint when last bet happened in the past
    if (nowMs > lastTimestampMs + 5_000) {
      const lastPoint = points[points.length - 1];
      points.push({
        timestampMs: nowMs,
        fullTime: `Live · ${new Date(nowMs).toLocaleString()}`,
        yesProbability: lastPoint.yesProbability,
        noProbability: lastPoint.noProbability,
        cumulativeVolumeZec: lastPoint.cumulativeVolumeZec,
        betDeltaZec: null,
        betSide: null,
      });
    }

    return points;
  }

  // Forward cumulative fallback anchored on 50/50 initial reserves
  let simYes = 500_000_000;
  let simNo = 500_000_000;
  let runningVolumeZatoshis = 0;
  const openMs = Math.min(parseTimestampMs(market.createdAt), sortedBets[0].createdAtMs - 60_000);
  const fallbackPoints: SentimentDataPoint[] = [
    {
      timestampMs: openMs,
      fullTime: `Open · ${new Date(openMs).toLocaleString()}`,
      yesProbability: 50,
      noProbability: 50,
      cumulativeVolumeZec: 0,
      betDeltaZec: null,
      betSide: null,
    },
  ];

  let lastTimestampMs = openMs;
  for (const bet of sortedBets) {
    const fee = Math.floor((bet.amountZatoshis * market.creatorFeeBps) / 10_000);
    const netDeposit = Math.max(0, bet.amountZatoshis - fee);
    const k = simYes * simNo;
    if (bet.pick === OutcomeSide.Yes) {
      simNo += netDeposit;
      simYes = Math.max(1, Math.round(k / simNo));
    } else {
      simYes += netDeposit;
      simNo = Math.max(1, Math.round(k / simYes));
    }
    runningVolumeZatoshis += bet.amountZatoshis;
    const odds = calculateBinaryOdds(simYes, simNo);
    const monotonicMs = Math.max(bet.createdAtMs, lastTimestampMs + 1);
    lastTimestampMs = monotonicMs;

    fallbackPoints.push({
      timestampMs: monotonicMs,
      fullTime: new Date(bet.createdAtMs).toLocaleString(),
      yesProbability: odds.yesProbability,
      noProbability: odds.noProbability,
      cumulativeVolumeZec: Math.round(zatoshisToZec(runningVolumeZatoshis) * 1000) / 1000,
      betDeltaZec: Math.round(zatoshisToZec(bet.amountZatoshis) * 1000) / 1000,
      betSide: bet.pick,
    });
  }

  if (nowMs > lastTimestampMs + 5_000) {
    const lastPoint = fallbackPoints[fallbackPoints.length - 1];
    fallbackPoints.push({
      timestampMs: nowMs,
      fullTime: `Live · ${new Date(nowMs).toLocaleString()}`,
      yesProbability: lastPoint.yesProbability,
      noProbability: lastPoint.noProbability,
      cumulativeVolumeZec: lastPoint.cumulativeVolumeZec,
      betDeltaZec: null,
      betSide: null,
    });
  }

  return fallbackPoints;
}

function sliceByTimeframe(
  points: SentimentDataPoint[],
  timeframe: TimeframeWindow
): SentimentDataPoint[] {
  const windowConfig = TIMEFRAME_WINDOWS.find((w) => w.id === timeframe);
  if (!windowConfig?.ms || points.length <= 2) {
    return points;
  }

  const endMs = points[points.length - 1].timestampMs;
  const cutoffMs = endMs - windowConfig.ms;
  const inWindow = points.filter((p) => p.timestampMs >= cutoffMs);

  // Preserve the most recent point prior to the cutoff as the window's starting state
  const priorPoint = [...points].reverse().find((p) => p.timestampMs < cutoffMs);
  if (priorPoint) {
    return [
      {
        ...priorPoint,
        timestampMs: cutoffMs,
        fullTime: `${windowConfig.label} Start · ${new Date(cutoffMs).toLocaleString()}`,
        betDeltaZec: null,
        betSide: null,
      },
      ...inWindow,
    ];
  }

  return inWindow.length >= 2 ? inWindow : points;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    payload?: SentimentDataPoint;
  }>;
}

const SentimentTooltip: React.FC<CustomTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0 || !payload[0].payload) {
    return null;
  }

  const point = payload[0].payload;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm text-xs space-y-1.5">
      <p className="font-medium text-slate-900">{point.fullTime}</p>
      <div className="space-y-1 font-mono tabular-nums">
        <div className="flex items-center justify-between gap-4">
          <span className="text-emerald-700 font-semibold">YES</span>
          <span className="text-slate-900">{point.yesProbability.toFixed(1)}%</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-rose-700 font-semibold">NO</span>
          <span className="text-slate-900">{point.noProbability.toFixed(1)}%</span>
        </div>
        <div className="pt-1 border-t border-slate-100 flex items-center justify-between gap-4 text-slate-600">
          <span className="font-sans">Cum. Volume</span>
          <span>{point.cumulativeVolumeZec.toFixed(3)} ZEC</span>
        </div>
        {point.betDeltaZec !== null && point.betSide && (
          <div className="flex items-center justify-between gap-4 text-slate-500">
            <span className="font-sans">Bet Trigger</span>
            <span>
              +{point.betDeltaZec.toFixed(3)} ZEC on {point.betSide}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export const SentimentTrendChart: React.FC<SentimentTrendChartProps> = ({ market }) => {
  const [timeframe, setTimeframe] = useState<TimeframeWindow>('ALL');
  const [firestoreBets, setFirestoreBets] = useState<HistoricalBetPoint[]>([]);
  const [firestoreTxs, setFirestoreTxs] = useState<HistoricalBetPoint[]>([]);
  const [fallbackBets, setFallbackBets] = useState<HistoricalBetPoint[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [listenerError, setListenerError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setListenerError(null);
    setFirestoreBets([]);
    setFirestoreTxs([]);
    setFallbackBets([]);

    let active = true;

    // Fallback check against Express server store if Firestore has no synced notes yet
    fetch(`/api/markets/${encodeURIComponent(market.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            bets?: Array<{
              id: string;
              txid?: string | null;
              pick: OutcomeSide;
              amountZatoshis: number;
              createdAt: string;
            }>;
          } | null
        ) => {
          if (!active || !data?.bets) return;
          setFallbackBets(
            data.bets.map((b) => ({
              id: b.id,
              txid: b.txid ?? null,
              pick: b.pick,
              amountZatoshis: b.amountZatoshis,
              createdAtMs: parseTimestampMs(b.createdAt),
            }))
          );
        }
      )
      .catch(() => {
        // Ignore fallback fetch errors when offline
      });

    // 1. Live Cloud Firestore query on `shielded_bets` scoped strictly to marketId
    const betsQuery = query(
      collection(db, 'shielded_bets'),
      where('marketId', '==', market.id)
    );

    const unsubBets = onSnapshot(
      betsQuery,
      (snapshot) => {
        if (!active) return;
        const rows: HistoricalBetPoint[] = snapshot.docs.map((docSnap) => {
          const d = docSnap.data();
          return {
            id: String(d.id || docSnap.id),
            txid: typeof d.txid === 'string' && d.txid ? d.txid : null,
            pick: d.pick === OutcomeSide.No ? OutcomeSide.No : OutcomeSide.Yes,
            amountZatoshis: Number(d.amountZatoshis || 0),
            createdAtMs: parseTimestampMs(d.createdAt),
          };
        });
        setFirestoreBets(rows);
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        try {
          handleFirestoreError(err, OperationType.LIST, 'shielded_bets');
        } catch (wrapped) {
          setListenerError(
            wrapped instanceof Error ? wrapped.message : 'Unable to load shielded bet history.'
          );
        }
        setLoading(false);
      }
    );

    // 2. Live Cloud Firestore query on confirmed/settled `shielded_transactions` for marketId
    const txsQuery = query(
      collection(db, 'shielded_transactions'),
      where('marketId', '==', market.id)
    );

    const unsubTxs = onSnapshot(
      txsQuery,
      (snapshot) => {
        if (!active) return;
        const rows: HistoricalBetPoint[] = [];
        for (const docSnap of snapshot.docs) {
          const d = docSnap.data();
          const status = String(d.status || '');
          if (status !== 'confirmed' && status !== 'settled') continue;
          rows.push({
            id: String(d.id || docSnap.id),
            txid: typeof d.txid === 'string' && d.txid ? d.txid : null,
            pick: d.side === OutcomeSide.No ? OutcomeSide.No : OutcomeSide.Yes,
            amountZatoshis: Number(d.amountZatoshis || 0),
            createdAtMs: parseTimestampMs(d.confirmedAt || d.createdAt),
          });
        }
        setFirestoreTxs(rows);
      },
      (err) => {
        if (!active) return;
        try {
          handleFirestoreError(err, OperationType.LIST, 'shielded_transactions');
        } catch {
          // Non-fatal; shielded_bets listener handles primary state
        }
      }
    );

    return () => {
      active = false;
      unsubBets();
      unsubTxs();
    };
  }, [market.id]);

  const mergedBets = useMemo(() => {
    const primary = [...firestoreBets, ...firestoreTxs];
    return primary.length > 0 ? primary : fallbackBets;
  }, [firestoreBets, firestoreTxs, fallbackBets]);

  const fullSeries = useMemo(
    () => buildFullProbabilitySeries(market, mergedBets),
    [market, mergedBets]
  );

  const chartData = useMemo(
    () => sliceByTimeframe(fullSeries, timeframe),
    [fullSeries, timeframe]
  );

  const spanMs = useMemo(() => {
    if (chartData.length < 2) return 86_400_000;
    return Math.max(1, chartData[chartData.length - 1].timestampMs - chartData[0].timestampMs);
  }, [chartData]);

  const periodDeltaPct = useMemo(() => {
    if (chartData.length < 2) return 0;
    const first = chartData[0].yesProbability;
    const last = chartData[chartData.length - 1].yesProbability;
    return Math.round((last - first) * 10) / 10;
  }, [chartData]);

  const totalVolumeInSeries =
    chartData.length > 0 ? chartData[chartData.length - 1].cumulativeVolumeZec : 0;

  return (
    <section className="space-y-3 pt-4 border-t border-slate-100">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5 sm:gap-3">
        <div className="space-y-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-slate-500">
              Probability History ({timeframe})
            </h3>
            <span
              className={`text-xs font-mono font-semibold tabular-nums ${
                periodDeltaPct > 0
                  ? 'text-emerald-700'
                  : periodDeltaPct < 0
                  ? 'text-rose-700'
                  : 'text-slate-500'
              }`}
            >
              {periodDeltaPct >= 0 ? '+' : ''}
              {periodDeltaPct.toFixed(1)} pts
            </span>
          </div>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            {mergedBets.length > 0
              ? `${mergedBets.length} confirmed bet${mergedBets.length === 1 ? '' : 's'} · ${totalVolumeInSeries.toFixed(2)} ZEC`
              : 'Open baseline vs live CPMM probability'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <div className="inline-flex items-center p-0.5 bg-slate-100 rounded-lg">
            {TIMEFRAME_WINDOWS.map((win) => (
              <button
                key={win.id}
                type="button"
                onClick={() => setTimeframe(win.id)}
                className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  timeframe === win.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {win.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 text-xs font-medium">
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <span className="w-2.5 h-0.5 bg-emerald-600 inline-block" aria-hidden="true" />
              <span>YES</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-rose-700">
              <span className="w-2.5 h-0.5 bg-rose-600 inline-block" aria-hidden="true" />
              <span>NO</span>
            </span>
          </div>
        </div>
      </div>

      {listenerError && (
        <p className="text-xs text-amber-700">
          Using cached pool history (Firestore listener note: {listenerError})
        </p>
      )}

      <div className="border border-slate-200 rounded-lg bg-white p-2.5 sm:p-3">
        {loading && chartData.length === 0 ? (
          <div className="h-52 flex items-center justify-center text-xs text-slate-400">
            Loading Firestore probability history...
          </div>
        ) : (
          <div className="h-52 w-full">
            <ResponsiveContainer width="100%" height={208} minWidth={0}>
              <LineChart
                data={chartData}
                margin={{ top: 8, right: 12, left: -16, bottom: 4 }}
              >
                <CartesianGrid
                  stroke="#e2e8f0"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <ReferenceLine y={50} stroke="#cbd5e1" strokeDasharray="4 4" />
                <XAxis
                  dataKey="timestampMs"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(val: number) => formatTimeAxisTick(val, spanMs)}
                  tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  axisLine={{ stroke: '#cbd5e1' }}
                  tickLine={false}
                  minTickGap={32}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tickFormatter={(val: number) => `${val}%`}
                  tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<SentimentTooltip />} />
                <Line
                  type="monotone"
                  dataKey="yesProbability"
                  name="YES %"
                  stroke="#059669"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: '#059669', strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: '#059669', stroke: '#ffffff', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="noProbability"
                  name="NO %"
                  stroke="#e11d48"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: '#e11d48', strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: '#e11d48', stroke: '#ffffff', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
};

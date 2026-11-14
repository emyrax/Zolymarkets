/**
 * Zolymarket — Lock Period Countdown Timer Component
 *
 * Computes remaining time until the market lock period expires using
 * the Firestore `duration` field (in hours from `createdAt`, falling back
 * to `closesAt` when absent) and updates live every second.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Lock } from 'lucide-react';
import { MarketStatus, MarketWithDetails } from '../types/database.ts';

interface MarketCountdownProps {
  market: MarketWithDetails;
  variant?: 'card' | 'drawer';
}

function resolveLockDeadlineMs(market: MarketWithDetails): number {
  const createdMs = Date.parse(market.createdAt);
  if (
    typeof market.duration === 'number' &&
    Number.isFinite(market.duration) &&
    market.duration > 0 &&
    Number.isFinite(createdMs)
  ) {
    return createdMs + market.duration * 3_600_000;
  }
  const closesMs = Date.parse(market.closesAt);
  return Number.isFinite(closesMs) ? closesMs : Date.now();
}

function formatDurationLeft(remainingMs: number, showSecondsWhenDays: boolean): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (days > 0) {
    return showSecondsWhenDays
      ? `${days}d ${hh}h ${mm}m ${ss}s`
      : `${days}d ${hh}h ${mm}m`;
  }
  return `${hh}h ${mm}m ${ss}s`;
}

function formatDurationLabel(hours: number): string {
  const totalSeconds = Math.round(hours * 3600);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  if (totalSeconds < 3600) {
    return `${Math.round(totalSeconds / 60)}m`;
  }
  return `${Number(hours.toFixed(2))}h`;
}

export const MarketCountdown: React.FC<MarketCountdownProps> = ({
  market,
  variant = 'card',
}) => {
  const deadlineMs = useMemo(() => resolveLockDeadlineMs(market), [market]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    if (market.status !== MarketStatus.Open) {
      return undefined;
    }
    const intervalMs = deadlineMs - Date.now() <= 65_000 ? 250 : 1000;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [market.status, deadlineMs]);

  const remainingMs = Math.max(0, deadlineMs - nowMs);
  const isExpired = remainingMs <= 0;
  const isLockedOrTerminal = market.status !== MarketStatus.Open;
  const isUrgent = market.status === MarketStatus.Open && remainingMs > 0 && remainingMs <= 3_600_000;

  const statusText = useMemo(() => {
    if (market.status === MarketStatus.Resolved) {
      return `Resolved (${market.winningOutcome ?? 'Settled'})`;
    }
    if (market.status === MarketStatus.Locked) {
      return 'Betting Locked';
    }
    if (market.status === MarketStatus.Cancelled) {
      return 'Cancelled';
    }
    if (isExpired) {
      return 'Lock Expired';
    }
    return formatDurationLeft(remainingMs, variant === 'drawer');
  }, [market.status, market.winningOutcome, isExpired, remainingMs, variant]);

  if (variant === 'card') {
    return (
      <span
        className={`inline-flex items-center gap-1 font-mono tabular-nums whitespace-nowrap shrink-0 ${
          isLockedOrTerminal
            ? 'text-slate-600'
            : isExpired
            ? 'text-rose-700 font-medium'
            : isUrgent
            ? 'text-amber-700 font-medium'
            : 'text-slate-500'
        }`}
        title={
          typeof market.duration === 'number'
            ? `Lock period: ${formatDurationLabel(market.duration)} from creation`
            : `Closes ${new Date(deadlineMs).toLocaleString()}`
        }
      >
        {market.status === MarketStatus.Locked ? (
          <Lock className="w-3 h-3 shrink-0 text-amber-700" aria-hidden="true" />
        ) : (
          <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
        )}
        <span>{statusText}</span>
      </span>
    );
  }

  return (
    <section className="p-4 border border-slate-200 rounded-lg bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
          {market.status === MarketStatus.Locked ? (
            <Lock className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden="true" />
          ) : (
            <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
          )}
          <span>Lock Period Countdown</span>
        </div>
        <p className="text-xs text-slate-500 font-mono tabular-nums">
          {typeof market.duration === 'number'
            ? `${formatDurationLabel(market.duration)} lock duration · Expires ${new Date(deadlineMs).toLocaleString()}`
            : `Closes ${new Date(deadlineMs).toLocaleString()}`}
        </p>
      </div>

      <p
        className={`font-mono text-base font-semibold tabular-nums whitespace-nowrap ${
          isLockedOrTerminal
            ? 'text-slate-800'
            : isExpired
            ? 'text-rose-700'
            : isUrgent
            ? 'text-amber-700'
            : 'text-slate-900'
        }`}
      >
        {statusText}
      </p>
    </section>
  );
};

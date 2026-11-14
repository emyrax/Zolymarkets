/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Copy, Check, QrCode } from 'lucide-react';
import { Header, ActiveView } from './components/Header.tsx';
import { MarketCard } from './components/MarketCard.tsx';
import { MarketDetailDrawer } from './components/MarketDetailDrawer.tsx';
import { SchemaExplorer } from './components/SchemaExplorer.tsx';
import { ZingoSetupGuide } from './components/ZingoSetupGuide.tsx';
import { HostDashboard } from './components/HostDashboard.tsx';
import { PlayerRoom } from './components/PlayerRoom.tsx';
import { PollarWorkspace } from './components/PollarWorkspace.tsx';
import { Zip321RoomPrefill, Zip321ScannerModal } from './components/Zip321ScannerModal.tsx';
import { DualRailAuthModal } from './components/DualRailAuthModal.tsx';
import { DualRailFlowBar } from './components/DualRailFlowBar.tsx';
import { useRealtimeMarkets } from './hooks/useRealtimeMarkets.ts';
import { useAuth } from './contexts/AuthContext.tsx';
import { MarketCategory, MarketWithDetails } from './types/database.ts';
import { formatZec } from './lib/cpmm.ts';

function resolveInitialRoomId(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/room\/([^/]+)\/?$/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function resolveInitialView(): ActiveView {
  if (typeof window === 'undefined') return 'markets';
  const path = window.location.pathname.toLowerCase();
  if (path === '/host' || path.startsWith('/host/')) return 'host';
  if (path === '/pollar' || path.startsWith('/pollar/')) return 'pollar';
  if (path === '/creators') return 'creators';
  if (path === '/schema') return 'schema';
  if (path === '/setup') return 'setup';
  return 'markets';
}

const CATEGORIES: Array<'All' | MarketCategory> = [
  'All',
  MarketCategory.ZcashProtocol,
  MarketCategory.Ecosystem,
  MarketCategory.PrivacyCrypto,
  MarketCategory.Governance,
  MarketCategory.CreatorBets,
];

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>(() => resolveInitialView());
  const [activeRoomId, setActiveRoomId] = useState<string | null>(() => resolveInitialRoomId());
  const [selectedCategory, setSelectedCategory] = useState<'All' | MarketCategory>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedMarket, setSelectedMarket] = useState<MarketWithDetails | null>(null);
  const [scannerOpen, setScannerOpen] = useState<boolean>(false);
  const [roomPrefill, setRoomPrefill] = useState<Zip321RoomPrefill | null>(null);
  const [copiedAddressId, setCopiedAddressId] = useState<string | null>(null);
  const [deepLinkHandled, setDeepLinkHandled] = useState<boolean>(false);

  const { authError } = useAuth();
  const { markets, creators, loading, error, refresh } = useRealtimeMarkets();

  const navigateTo = useCallback((view: ActiveView) => {
    setActiveRoomId(null);
    setRoomPrefill(null);
    setActiveView(view);
    if (typeof window !== 'undefined') {
      const targetPath = view === 'markets' ? '/' : `/${view}`;
      if (window.location.pathname !== targetPath) {
        window.history.pushState({}, '', targetPath);
      }
    }
  }, []);

  const openRoom = useCallback((marketId: string, prefill?: Zip321RoomPrefill) => {
    setSelectedMarket(null);
    setScannerOpen(false);
    setRoomPrefill(prefill ?? null);
    setActiveRoomId(marketId);
    setActiveView('markets');
    if (typeof window !== 'undefined') {
      const targetPath = `/room/${encodeURIComponent(marketId)}`;
      if (window.location.pathname !== targetPath) {
        window.history.pushState({}, '', targetPath);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setActiveRoomId(resolveInitialRoomId());
      setActiveView(resolveInitialView());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Support scanning the QR join link (/?market=<idOrSlug>)
  useEffect(() => {
    if (deepLinkHandled || markets.length === 0 || typeof window === 'undefined') return;
    const marketParam = new URLSearchParams(window.location.search).get('market');
    if (marketParam) {
      const match = markets.find((m) => m.id === marketParam || m.slug === marketParam);
      if (match) {
        setSelectedMarket(match);
      }
      setDeepLinkHandled(true);
    }
  }, [markets, deepLinkHandled]);

  const filteredMarkets = useMemo(() => {
    return markets.filter((market) => {
      const matchesCategory =
        selectedCategory === 'All' || market.category === selectedCategory;
      const q = searchQuery.trim().toLowerCase();
      const matchesQuery =
        q.length === 0 ||
        market.question.toLowerCase().includes(q) ||
        market.creator.handle.toLowerCase().includes(q) ||
        market.category.toLowerCase().includes(q);
      return matchesCategory && matchesQuery;
    });
  }, [markets, selectedCategory, searchQuery]);

  const totalVolumeZatoshis = useMemo(
    () => markets.reduce((sum, m) => sum + m.totalVolumeZatoshis, 0),
    [markets]
  );

  const totalLiquidityZatoshis = useMemo(
    () => markets.reduce((sum, m) => sum + m.liquidityZatoshis, 0),
    [markets]
  );

  const firstOpenMarketId = useMemo(
    () => markets.find((m) => m.status === 'open')?.id ?? markets[0]?.id ?? null,
    [markets]
  );

  const handleCopyAddress = async (creatorId: string, address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddressId(creatorId);
      setTimeout(() => setCopiedAddressId(null), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <Header activeView={activeView} onNavigate={navigateTo} />

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-5 sm:py-8">
        {authError && (
          <div className="mb-6 p-4 bg-white border border-rose-200 rounded-xl text-sm text-rose-700">
            {authError}
          </div>
        )}

        {activeRoomId ? (
          <PlayerRoom
            key={activeRoomId}
            roomId={activeRoomId}
            markets={markets}
            creators={creators}
            initialPrefill={roomPrefill}
            onBackToMarkets={() => navigateTo('markets')}
            onOpenScanner={() => setScannerOpen(true)}
          />
        ) : (
          <>
            {activeView === 'markets' && (
          <div className="space-y-6 sm:space-y-8">
            {/* Hero / Overview Header */}
            <section className="flex flex-col md:flex-row md:items-end justify-between gap-5 sm:gap-6 pb-5 sm:pb-6 border-b border-slate-200">
              <div className="space-y-2 max-w-2xl">
                <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
                  Shielded prediction markets for Zcash creators
                </h1>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Powered by Cloud Firestore real-time synchronization, ZIP-321 shielded payment requests,
                  CPMM probability discovery, and local zingo-cli note ingestion.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3 sm:gap-6 w-full md:w-auto shrink-0 font-mono tabular-nums pt-1 md:pt-0">
                <div>
                  <p className="font-sans text-[11px] sm:text-xs text-slate-500">Active Markets</p>
                  <p className="text-base sm:text-lg font-semibold text-slate-900">{markets.length}</p>
                </div>
                <div>
                  <p className="font-sans text-[11px] sm:text-xs text-slate-500">Shielded Volume</p>
                  <p className="text-base sm:text-lg font-semibold text-slate-900">
                    {formatZec(totalVolumeZatoshis, 1)}
                  </p>
                </div>
                <div>
                  <p className="font-sans text-[11px] sm:text-xs text-slate-500">Pool Liquidity</p>
                  <p className="text-base sm:text-lg font-semibold text-slate-900">
                    {formatZec(totalLiquidityZatoshis, 1)}
                  </p>
                </div>
              </div>
            </section>

            {/* Interactive 4-Step Dual-Rail User Flow */}
            <DualRailFlowBar
              firstOpenMarketId={firstOpenMarketId}
              onNavigate={navigateTo}
              onOpenScanner={() => setScannerOpen(true)}
              onOpenRoom={openRoom}
            />

            {/* Filter & Search Toolbar */}
            <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 sm:gap-4">
              <div className="flex flex-nowrap sm:flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg overflow-x-auto no-scrollbar max-w-full">
                {CATEGORIES.map((category) => {
                  const isActive = selectedCategory === category;
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() => setSelectedCategory(category)}
                      className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        isActive
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {category}
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 w-full lg:w-auto">
                <div className="relative flex-1 sm:w-72">
                  <Search
                    className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter questions or creators..."
                    aria-label="Filter markets"
                    className="w-full min-h-[44px] sm:min-h-[40px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setScannerOpen(true)}
                  className="min-h-[44px] sm:min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <QrCode className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                  <span>Scan ZIP-321</span>
                </button>
              </div>
            </section>

            {/* Market Grid States */}
            {error && (
              <div className="p-5 bg-white border border-rose-200 rounded-xl flex items-center justify-between gap-4">
                <p className="text-sm text-rose-700">{error}</p>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  Retry
                </button>
              </div>
            )}

            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {Array.from({ length: 6 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="h-52 bg-white border border-slate-200 rounded-xl p-5 animate-pulse flex flex-col justify-between"
                  >
                    <div className="space-y-3">
                      <div className="h-3 w-36 bg-slate-200 rounded" />
                      <div className="h-5 w-full bg-slate-200 rounded" />
                      <div className="h-5 w-3/4 bg-slate-200 rounded" />
                    </div>
                    <div className="h-8 w-full bg-slate-100 rounded" />
                  </div>
                ))}
              </div>
            ) : filteredMarkets.length === 0 ? (
              <div className="p-10 bg-white border border-slate-200 rounded-xl text-center space-y-3">
                <p className="text-sm font-medium text-slate-800">
                  No markets match your current filter.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCategory('All');
                    setSearchQuery('');
                  }}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  Reset Filters
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {filteredMarkets.map((market) => (
                  <MarketCard
                    key={market.id}
                    market={market}
                    onSelect={setSelectedMarket}
                    onOpenRoom={openRoom}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {activeView === 'creators' && (
          <div className="space-y-6">
            <div className="space-y-1">
              <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
                Zcash Market Creators
              </h1>
              <p className="text-sm text-slate-600">
                Verified creators receive fee attribution directly to their Zcash Unified Address (u1...).
              </p>
            </div>

            {/* Mobile Card List */}
            <div className="md:hidden bg-white border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
              {creators.map((creator) => (
                <div key={creator.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {creator.displayName}
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-1.5">
                        <span>@{creator.handle}</span>
                        {creator.verified && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-emerald-700 font-medium">Verified</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums shrink-0">
                      <div className="text-sm font-semibold text-slate-900">
                        {formatZec(creator.totalVolumeZatoshis, 2)}
                      </div>
                      <div className="text-xs text-slate-500">
                        {creator.marketsCreatedCount} market{creator.marketsCreatedCount === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg">
                    <span className="font-mono text-xs text-slate-700 truncate">
                      {creator.zcashUnifiedAddress}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopyAddress(creator.id, creator.zcashUnifiedAddress)
                      }
                      aria-label={`Copy unified address for ${creator.displayName}`}
                      className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center text-slate-500 hover:text-slate-900 shrink-0 cursor-pointer"
                    >
                      {copiedAddressId === creator.id ? (
                        <Check className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop Table */}
            <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-500">
                      <th className="py-3 px-5">Creator</th>
                      <th className="py-3 px-4">Shielded Unified Address</th>
                      <th className="py-3 px-4 text-right">Markets</th>
                      <th className="py-3 px-5 text-right">Cumulative Volume</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {creators.map((creator) => (
                      <tr key={creator.id} className="hover:bg-slate-50/70">
                        <td className="py-3.5 px-5">
                          <div className="font-medium text-slate-900">
                            {creator.displayName}
                          </div>
                          <div className="text-xs text-slate-500 flex items-center gap-1.5">
                            <span>@{creator.handle}</span>
                            {creator.verified && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-emerald-700 font-medium">Verified</span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-2 font-mono text-xs text-slate-700">
                            <span className="truncate max-w-[240px]">
                              {creator.zcashUnifiedAddress}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                void handleCopyAddress(creator.id, creator.zcashUnifiedAddress)
                              }
                              aria-label={`Copy unified address for ${creator.displayName}`}
                              className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
                            >
                              {copiedAddressId === creator.id ? (
                                <Check className="w-3.5 h-3.5 text-emerald-600" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-800">
                          {creator.marketsCreatedCount}
                        </td>
                        <td className="py-3.5 px-5 text-right font-mono tabular-nums font-medium text-slate-900">
                          {formatZec(creator.totalVolumeZatoshis, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeView === 'host' && (
          <HostDashboard
            markets={markets}
            creators={creators}
            onOpenMarketModal={setSelectedMarket}
            onOpenRoom={openRoom}
            onRefresh={refresh}
          />
        )}

        {activeView === 'pollar' && <PollarWorkspace />}

        {activeView === 'schema' && <SchemaExplorer />}

        {activeView === 'setup' && <ZingoSetupGuide />}
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 text-xs text-slate-500">
          <span>Zolymarket — Creator-driven Zcash &amp; Pollar prediction market</span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={() => navigateTo('markets')}
              className="py-1 hover:text-slate-900 cursor-pointer whitespace-nowrap"
            >
              Markets
            </button>
            <button
              type="button"
              onClick={() => navigateTo('host')}
              className="py-1 hover:text-slate-900 cursor-pointer whitespace-nowrap"
            >
              Host Market
            </button>
            <button
              type="button"
              onClick={() => navigateTo('pollar')}
              className="py-1 hover:text-slate-900 cursor-pointer whitespace-nowrap"
            >
              Pollar Pay
            </button>
            <button
              type="button"
              onClick={() => navigateTo('schema')}
              className="py-1 hover:text-slate-900 cursor-pointer whitespace-nowrap"
            >
              Firestore Schema
            </button>
            <button
              type="button"
              onClick={() => navigateTo('setup')}
              className="py-1 hover:text-slate-900 cursor-pointer whitespace-nowrap"
            >
              Zingo Setup
            </button>
          </div>
        </div>
      </footer>

      <MarketDetailDrawer
        market={selectedMarket}
        onClose={() => setSelectedMarket(null)}
        onOpenRoom={openRoom}
      />

      <Zip321ScannerModal
        isOpen={scannerOpen}
        markets={markets}
        onClose={() => setScannerOpen(false)}
        onJoinRoom={openRoom}
        onBetUploaded={() => void refresh()}
      />

      <DualRailAuthModal
        onNavigate={navigateTo}
        onOpenScanner={() => setScannerOpen(true)}
      />
    </div>
  );
}

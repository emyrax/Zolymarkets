/**
 * Zolymarket — Dual-Rail User Flow Bar
 *
 * Interactive 4-step workflow strip ("From Live Bet to Flexible Checkout"):
 * 01. One-Click Entry (Zcash Wallet or Pollar / Polygon)
 * 02. Create or Place Bet (Creator Host vs Bettor Room)
 * 03. Scan to Upload (Scan QR bet to extract & upload payload)
 * 04. Choice Checkout (Cash out or settle via Zcash ZEC or Pollar / Polygon)
 */

import React from 'react';
import { ArrowRight, PlusCircle, QrCode, ShieldCheck, Wallet } from 'lucide-react';
import { usePollar } from '@pollar/react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { ActiveView } from './Header.tsx';

interface DualRailFlowBarProps {
  firstOpenMarketId: string | null;
  onNavigate: (view: ActiveView) => void;
  onOpenScanner: () => void;
  onOpenRoom: (marketId: string) => void;
}

export const DualRailFlowBar: React.FC<DualRailFlowBarProps> = ({
  firstOpenMarketId,
  onNavigate,
  onOpenScanner,
  onOpenRoom,
}) => {
  const { user, walletSession, userRole, setUserRole, openAuthModal } = useAuth();
  const { isAuthenticated: pollarAuthed } = usePollar();

  const isSignedIn = Boolean(walletSession || pollarAuthed || user);

  const identityText = walletSession
    ? `${walletSession.rail === 'zcash' ? 'Zcash' : 'Polygon'}: ${walletSession.address.slice(
        0,
        8
      )}...${walletSession.address.slice(-4)}`
    : pollarAuthed
    ? 'Pollar Wallet active'
    : user
    ? `Google: ${user.displayName?.split(' ')[0] || 'Linked'}`
    : 'Sign in via Zcash or Polygon / Pollar';

  return (
    <section
      aria-label="Dual-rail user workflow"
      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
        <div>
          <h2 className="font-display text-sm sm:text-base font-semibold text-slate-900">
            From Live Bet to Flexible Checkout
          </h2>
          <p className="text-xs text-slate-500">
            Sign in with Zcash or Pollar/Polygon, create or place a bet, and scan QR to upload &amp;
            check out.
          </p>
        </div>

        {/* Interactive Role Switcher */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto shrink-0">
          <button
            type="button"
            onClick={() => setUserRole('bettor')}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              userRole === 'bettor'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Bettor Mode
          </button>
          <button
            type="button"
            onClick={() => {
              setUserRole('creator');
              onNavigate('host');
            }}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              userRole === 'creator'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Creator Mode
          </button>
        </div>
      </div>

      {/* 4-Step Flow Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Step 01: One-Click Entry */}
        <button
          type="button"
          onClick={() => openAuthModal(walletSession?.rail === 'polygon' ? 'polygon' : 'zcash')}
          className="text-left p-3.5 rounded-lg border border-slate-200 hover:border-slate-300 bg-slate-50/70 hover:bg-slate-50 transition-colors flex flex-col justify-between gap-2 cursor-pointer min-h-[104px]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold text-slate-500">
              01 · One-Click Entry
            </span>
            <Wallet className="w-4 h-4 text-slate-700 shrink-0" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-900">
              {isSignedIn ? 'Switch or Manage Sign-In' : 'Zcash or Pollar / Polygon'}
            </p>
            <p className="text-[11px] text-slate-600 truncate mt-0.5 font-mono">
              {identityText}
            </p>
          </div>
        </button>

        {/* Step 02: Create or Place Bet */}
        <button
          type="button"
          onClick={() => {
            if (userRole === 'creator') {
              onNavigate('host');
            } else if (firstOpenMarketId) {
              onOpenRoom(firstOpenMarketId);
            } else {
              onNavigate('host');
            }
          }}
          className="text-left p-3.5 rounded-lg border border-slate-200 hover:border-slate-300 bg-slate-50/70 hover:bg-slate-50 transition-colors flex flex-col justify-between gap-2 cursor-pointer min-h-[104px]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold text-emerald-700">
              02 · Create / Place Bet
            </span>
            <PlusCircle className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-900">
              {userRole === 'creator' ? 'Create a Market Bet' : 'Place a Shielded Bet'}
            </p>
            <p className="text-[11px] text-slate-600 mt-0.5">
              {userRole === 'creator'
                ? 'Launch room & share ZIP-321 QR'
                : 'Pick YES/NO & lock shielded stake'}
            </p>
          </div>
        </button>

        {/* Step 03: Scan to Upload & Checkout */}
        <button
          type="button"
          onClick={onOpenScanner}
          className="text-left p-3.5 rounded-lg border border-slate-200 hover:border-slate-300 bg-slate-50/70 hover:bg-slate-50 transition-colors flex flex-col justify-between gap-2 cursor-pointer min-h-[104px]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold text-amber-700">
              03 · Scan to Checkout
            </span>
            <QrCode className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-900">Scan Bet QR &amp; Upload</p>
            <p className="text-[11px] text-slate-600 mt-0.5">
              Auto-extracts market, pick, stake &amp; payout
            </p>
          </div>
        </button>

        {/* Step 04: Choice Checkout */}
        <button
          type="button"
          onClick={() => {
            if (userRole === 'creator') {
              onNavigate('host');
            } else if (firstOpenMarketId) {
              onOpenRoom(firstOpenMarketId);
            } else {
              onNavigate('pollar');
            }
          }}
          className="text-left p-3.5 rounded-lg border border-slate-200 hover:border-slate-300 bg-slate-50/70 hover:bg-slate-50 transition-colors flex flex-col justify-between gap-2 cursor-pointer min-h-[104px]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold text-slate-600">
              04 · Choice Checkout
            </span>
            <ShieldCheck className="w-4 h-4 text-slate-700 shrink-0" aria-hidden="true" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-slate-900">Zcash ZEC or Pollar</p>
              <p className="text-[11px] text-slate-600 mt-0.5">
                Batch Zashi QR or Polygon/Stellar USDC
              </p>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
          </div>
        </button>
      </div>
    </section>
  );
};

/**
 * Zolymarket — Dual-Rail One-Click Entry Modal
 *
 * Implements Step 01 of the Dual-Rail User Flow:
 * - Sign in via Zcash Protocol (Unified / Sapling shielded wallet u1.../utest1.../zs1...)
 * - Sign in via Pollar & Polygon Protocol (@pollar/react social/embedded wallet or Polygon 0x...)
 * - Optional Google Auth (Firebase Cloud Firestore account option)
 * - Role selector: Bettor (place bets / scan to checkout) or Creator (host a market)
 */

import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  KeyRound,
  LogOut,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import { useChains, usePollar } from '@pollar/react';
import { useAuth, UserRole } from '../contexts/AuthContext.tsx';
import { usePollarBridge } from '../contexts/PollarBridgeProvider.tsx';
import { ActiveView } from './Header.tsx';

interface DualRailAuthModalProps {
  onNavigate: (view: ActiveView) => void;
  onOpenScanner: () => void;
}

function generateTestnetUnifiedPreview(): string {
  const chars = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let body = '';
  for (let i = 0; i < 52; i += 1) {
    body += chars[Math.floor(Math.random() * chars.length)];
  }
  return `utest1${body}`;
}

export const DualRailAuthModal: React.FC<DualRailAuthModalProps> = ({
  onNavigate,
  onOpenScanner,
}) => {
  const {
    user,
    authModalOpen,
    authModalTab,
    closeAuthModal,
    openAuthModal,
    walletSession,
    userRole,
    setUserRole,
    connectZcashWallet,
    connectPolygonWallet,
    connectPolygonAddress,
    disconnectWalletSession,
    signInWithGoogle,
    signOutUser,
  } = useAuth();

  const {
    publishableConfigured,
    pollarAuthError,
    clearPollarAuthError,
  } = usePollarBridge();
  const {
    isAuthenticated: pollarAuthed,
    wallet: pollarWallet,
    login: pollarLogin,
    logout: pollarLogout,
    openLoginModal: openPollarLogin,
  } = usePollar();
  const { primaryAddress: pollarPrimaryAddress } = useChains();

  const [zcashInput, setZcashInput] = useState<string>(() =>
    walletSession?.rail === 'zcash' ? walletSession.address : ''
  );
  const [polygonInput, setPolygonInput] = useState<string>(() =>
    walletSession?.rail === 'polygon' ? walletSession.address : ''
  );
  const [connectingPolygon, setConnectingPolygon] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!authModalOpen) {
      setLocalError(null);
      setStatusMessage(null);
      clearPollarAuthError();
      return;
    }
    if (walletSession?.rail === 'zcash') {
      setZcashInput(walletSession.address);
    } else if (walletSession?.rail === 'polygon') {
      setPolygonInput(walletSession.address);
    }
  }, [authModalOpen, walletSession]);

  useEffect(() => {
    if (!authModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeAuthModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authModalOpen, closeAuthModal]);

  if (!authModalOpen) return null;

  const activeTab = authModalTab === 'google' ? 'polygon' : authModalTab;

  const routeAfterConnect = (role: UserRole) => {
    closeAuthModal();
    if (role === 'creator') {
      onNavigate('host');
    }
  };

  const handleZcashSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setStatusMessage(null);
    try {
      connectZcashWallet(zcashInput, 'Zcash Shielded Wallet');
      setStatusMessage('Connected with Zcash shielded identity.');
      routeAfterConnect(userRole);
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Unable to validate Zcash shielded address.'
      );
    }
  };

  const handlePolygonExtensionConnect = async () => {
    setLocalError(null);
    setStatusMessage(null);
    setConnectingPolygon(true);
    try {
      const session = await connectPolygonWallet();
      setPolygonInput(session.address);
      setStatusMessage('Connected Polygon wallet.');
      routeAfterConnect(userRole);
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Unable to connect Polygon browser wallet.'
      );
    } finally {
      setConnectingPolygon(false);
    }
  };

  const handlePolygonManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setStatusMessage(null);
    try {
      connectPolygonAddress(polygonInput, 'Polygon Address');
      setStatusMessage('Connected Polygon address.');
      routeAfterConnect(userRole);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Invalid Polygon address.');
    }
  };

  const handleSelectRole = (nextRole: UserRole) => {
    setUserRole(nextRole);
  };

  const handlePollarGoogle = () => {
    setLocalError(null);
    clearPollarAuthError();
    if (!publishableConfigured) {
      setLocalError(
        'Pollar live login requires VITE_POLLAR_PUBLISHABLE_KEY. Use Polygon Wallet connect or optional Google Auth below.'
      );
      return;
    }
    pollarLogin({ provider: 'google' });
  };

  const handlePollarEmailPasskey = () => {
    setLocalError(null);
    clearPollarAuthError();
    if (!publishableConfigured) {
      setLocalError(
        'Pollar live modal requires VITE_POLLAR_PUBLISHABLE_KEY. Use Polygon Wallet connect or optional Google Auth below.'
      );
      return;
    }
    openPollarLogin();
  };

  const pollarResolvedAddress =
    pollarPrimaryAddress || pollarWallet?.address || '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dual-rail-auth-title"
      onClick={closeAuthModal}
    >
      <div
        className="w-full max-w-lg max-h-[92dvh] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 sm:px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2
              id="dual-rail-auth-title"
              className="font-display text-lg font-bold text-slate-900 truncate"
            >
              One-Click Dual-Rail Entry
            </h2>
            <p className="text-xs text-slate-500">
              Sign in with Zcash shielded protocol or Pollar &amp; Polygon to create or place bets.
            </p>
          </div>
          <button
            type="button"
            onClick={closeAuthModal}
            aria-label="Close sign-in modal"
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-5">
          {/* Role Selection: Creator vs Bettor */}
          <div className="space-y-2">
            <span className="block text-xs font-semibold text-slate-700">
              Choose Your Role
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleSelectRole('bettor')}
                className={`min-h-[48px] px-3 py-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  userRole === 'bettor'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                }`}
              >
                <span className="block text-xs font-semibold">Place a Bet</span>
                <span
                  className={`block text-[11px] ${
                    userRole === 'bettor' ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  Scan QR &amp; checkout
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleSelectRole('creator')}
                className={`min-h-[48px] px-3 py-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  userRole === 'creator'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                }`}
              >
                <span className="block text-xs font-semibold">Create a Bet</span>
                <span
                  className={`block text-[11px] ${
                    userRole === 'creator' ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  Host live market room
                </span>
              </button>
            </div>
          </div>

          {/* Active Session Banner if already connected */}
          {(walletSession || pollarAuthed || user) && (
            <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-lg space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-emerald-900 inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                  <span>Active Identity Connected</span>
                </span>
                <div className="flex items-center gap-2">
                  {walletSession && (
                    <button
                      type="button"
                      onClick={disconnectWalletSession}
                      className="text-slate-600 hover:text-slate-900 font-medium cursor-pointer"
                    >
                      Disconnect Wallet
                    </button>
                  )}
                </div>
              </div>

              {walletSession && (
                <div className="font-mono text-[11px] text-emerald-900 truncate">
                  {walletSession.label}: {walletSession.address}
                </div>
              )}
              {pollarAuthed && (
                <div className="font-mono text-[11px] text-emerald-900 truncate">
                  Pollar Session: {pollarResolvedAddress || 'Active'}
                </div>
              )}
              {user && (
                <div className="text-[11px] text-emerald-800 truncate">
                  Google Sync: {user.email || user.displayName || user.uid}
                </div>
              )}
            </div>
          )}

          {/* Protocol Tabs: Zcash Protocol vs Pollar / Polygon Protocol */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                openAuthModal('zcash');
              }}
              className={`min-h-[40px] px-3 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                activeTab === 'zcash'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
              <span>Zcash Protocol</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                openAuthModal('polygon');
              }}
              className={`min-h-[40px] px-3 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                activeTab === 'polygon'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Wallet className="w-4 h-4 text-slate-700 shrink-0" aria-hidden="true" />
              <span>Pollar &amp; Polygon</span>
            </button>
          </div>

          {(localError || pollarAuthError) && (
            <div
              role="alert"
              className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 break-words"
            >
              {localError || pollarAuthError}
            </div>
          )}

          {statusMessage && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900">
              {statusMessage}
            </div>
          )}

          {/* Tab 1: Zcash Shielded Wallet Sign-In */}
          {activeTab === 'zcash' ? (
            <form onSubmit={handleZcashSubmit} className="space-y-3.5">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="zcash-signin-address"
                    className="text-xs font-semibold text-slate-800"
                  >
                    Zashi / Zcash Unified or Sapling Address
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setLocalError(null);
                      setZcashInput(generateTestnetUnifiedPreview());
                    }}
                    className="text-xs font-medium text-amber-700 hover:text-amber-800 cursor-pointer"
                  >
                    Generate Testnet UA
                  </button>
                </div>
                <input
                  id="zcash-signin-address"
                  type="text"
                  value={zcashInput}
                  onChange={(e) => setZcashInput(e.target.value)}
                  placeholder="u1... or utest1... or zs1..."
                  className="w-full min-h-[44px] px-3.5 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                />
                <p className="text-[11px] text-slate-500">
                  Used automatically as your shielded return address when placing bets or as your
                  payout address when creating a market.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="submit"
                  className="flex-1 min-h-[44px] px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                >
                  {userRole === 'creator'
                    ? 'Sign in with Zcash & Create Bet'
                    : 'Sign in with Zcash Wallet'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeAuthModal();
                    onOpenScanner();
                  }}
                  className="min-h-[44px] px-4 py-2.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:border-slate-300 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                >
                  Scan Bet QR
                </button>
              </div>
            </form>
          ) : (
            /* Tab 2: Pollar Social + Polygon Wallet Sign-In */
            <div className="space-y-4">
              {/* Polygon Direct Wallet */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800">
                    Polygon Wallet (PoS / Amoy EVM)
                  </span>
                  <button
                    type="button"
                    disabled={connectingPolygon}
                    onClick={() => void handlePolygonExtensionConnect()}
                    className="min-h-[36px] px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    {connectingPolygon ? 'Connecting...' : 'Connect Browser Wallet'}
                  </button>
                </div>

                <form onSubmit={handlePolygonManualSubmit} className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={polygonInput}
                    onChange={(e) => setPolygonInput(e.target.value)}
                    placeholder="Or paste 0x... Polygon address"
                    aria-label="Polygon wallet address"
                    className="flex-1 min-h-[44px] px-3.5 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                  />
                  <button
                    type="submit"
                    className="min-h-[44px] px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    {userRole === 'creator' ? 'Use & Create Bet' : 'Sign in Polygon'}
                  </button>
                </form>
              </div>

              {/* Pollar SDK Social & Embedded Polygon/Stellar/Solana Wallets */}
              <div className="pt-3.5 border-t border-slate-100 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="text-xs font-semibold text-slate-800 block">
                      Pollar Social Entry (Polygon, Stellar, Solana)
                    </span>
                    <span className="text-[11px] text-slate-500">
                      One-click embedded wallet + fiat QR/Pix ramps via @pollar/react.
                    </span>
                  </div>
                  {pollarAuthed && (
                    <button
                      type="button"
                      onClick={() => void pollarLogout()}
                      className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer shrink-0"
                    >
                      Disconnect Pollar
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handlePollarGoogle}
                    className="min-h-[44px] px-3.5 py-2 text-xs font-semibold text-slate-900 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-amber-700" aria-hidden="true" />
                    <span>Pollar Social Login</span>
                  </button>
                  <button
                    type="button"
                    onClick={handlePollarEmailPasskey}
                    className="min-h-[44px] px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
                  >
                    <KeyRound className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                    <span>Pollar Email / Passkey</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Optional Google Firebase Auth Rail */}
          <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-700">
                Optional: Google Account Sync
              </p>
              <p className="text-[11px] text-slate-500">
                {user
                  ? `Linked as ${user.email || user.displayName}`
                  : 'Optional Cloud Firestore sync for Creator publishing & cross-device positions.'}
              </p>
            </div>
            {user ? (
              <button
                type="button"
                onClick={() => void signOutUser()}
                className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer shrink-0 whitespace-nowrap"
              >
                <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Sign out Google</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer shrink-0 whitespace-nowrap"
              >
                <span>Sign in with Google</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

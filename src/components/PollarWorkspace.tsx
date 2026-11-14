/**
 * Zolymarket — Pollar 0.12 Zero-VPS Onboarding & Multichain Payment Hub
 *
 * Integrates `@pollar/react` (`WalletButton`, `usePollar`, `useChains`, and pre-built
 * Send / Receive / Swap / Ramp / KYC / Recovery / History modals), `@pollar/core`
 * (`sendPayment`, `toBaseUnits`), and Express Server API v3 proxy routes (`/api/pollar/*`)
 * for Stellar, Solana, and Polygon.
 */

import React, { useMemo, useState } from 'react';
import { WalletChain } from '@pollar/core';
import {
  WalletButton,
  useChains,
  usePollar,
  walletNotReadyReason,
} from '@pollar/react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  History,
  KeyRound,
  Landmark,
  RefreshCw,
  Send,
  ShieldCheck,
  UserCheck,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { usePollarBridge } from '../contexts/PollarBridgeProvider.tsx';
import {
  PollarAssetSymbol,
  buildPollarPaymentParams,
  getChainAssetOptions,
} from '../lib/pollar-assets.ts';

const CHAINS_LIST: WalletChain[] = ['STELLAR', 'SOLANA', 'POLYGON'];

export const PollarWorkspace: React.FC = () => {
  const { user: firebaseUser } = useAuth();
  const {
    publishableConfigured,
    targetNetwork,
    storageDegraded,
    serverStatus,
    statusLoading,
    pollarAuthError,
    clearPollarAuthError,
    refreshServerStatus,
  } = usePollarBridge();

  const {
    isAuthenticated,
    verified,
    hasWallet,
    wallet,
    wallets,
    walletBalance,
    tx,
    network,
    recoveryLocked,
    configStatus,
    login,
    logout,
    createWallet,
    refreshWalletBalance,
    sendPayment,
    openLoginModal,
    openWalletBalanceModal,
    openSendModal,
    openReceiveModal,
    openSwapModal,
    openRampModal,
    openKycModal,
    openTxHistoryModal,
    openRecoveryModal,
    openSessionsModal,
    openEarnModal,
    openCardModal,
    openDistributionRulesModal,
  } = usePollar();

  const { chains: activeChains, primaryChain, primaryAddress } = useChains();

  const [selectedChain, setSelectedChain] = useState<WalletChain>('SOLANA');
  const [assetKind, setAssetKind] = useState<PollarAssetSymbol>('USDC');
  const [destination, setDestination] = useState<string>('');
  const [amount, setAmount] = useState<string>('1.00');
  const [memoText, setMemoText] = useState<string>('');
  const [sendingTx, setSendingTx] = useState<boolean>(false);
  const [txOutcome, setTxOutcome] = useState<{
    status: 'success' | 'pending' | 'cosign_pending' | 'error';
    message: string;
    hash?: string;
  } | null>(null);

  const [creatingWallet, setCreatingWallet] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Server API v3 Provisioning State
  const [externalUserId, setExternalUserId] = useState<string>(
    () => firebaseUser?.uid || 'creator_demo_01'
  );
  const [serverBusy, setServerBusy] = useState<boolean>(false);
  const [serverResult, setServerResult] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const currentOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  const assetOptions = useMemo(
    () => getChainAssetOptions(selectedChain, network || targetNetwork),
    [selectedChain, network, targetNetwork]
  );

  const selectedAssetOption =
    assetOptions.find((opt) =>
      assetKind === 'NATIVE' ? opt.isNative : !opt.isNative
    ) ?? assetOptions[0];

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleCreateOnDemandWallet = async () => {
    setCreatingWallet(true);
    setTxOutcome(null);
    try {
      await createWallet();
      await refreshWalletBalance();
    } catch (err) {
      setTxOutcome({
        status: 'error',
        message: err instanceof Error ? err.message : 'Unable to create Pollar wallet.',
      });
    } finally {
      setCreatingWallet(false);
    }
  };

  const handleSendPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setTxOutcome(null);

    if (!publishableConfigured) {
      setTxOutcome({
        status: 'error',
        message:
          'Configure VITE_POLLAR_PUBLISHABLE_KEY in your environment before submitting live payments.',
      });
      return;
    }

    if (!isAuthenticated) {
      openLoginModal();
      return;
    }

    if (!destination.trim()) {
      setTxOutcome({
        status: 'error',
        message: 'Enter a recipient address on the selected chain.',
      });
      return;
    }

    setSendingTx(true);
    try {
      const params = buildPollarPaymentParams({
        chain: selectedChain,
        network: network || targetNetwork,
        destination,
        amount,
        assetKind,
        memoText,
      });

      const outcome = await sendPayment(params);
      if (outcome.status === 'success') {
        setTxOutcome({
          status: 'success',
          message: `Confirmed on ${selectedChain}.`,
          hash: outcome.hash,
        });
        void refreshWalletBalance();
      } else if (outcome.status === 'pending') {
        setTxOutcome({
          status: 'pending',
          message: `Submitted to ${selectedChain}; awaiting finality.`,
          hash: outcome.hash,
        });
      } else if (outcome.status === 'cosign_pending') {
        setTxOutcome({
          status: 'cosign_pending',
          message: 'Awaiting Turnkey co-sign device approval in the Pollar confirmation modal.',
        });
      } else {
        setTxOutcome({
          status: 'error',
          message:
            outcome.message ||
            outcome.details ||
            outcome.resultCode ||
            'Payment could not be completed.',
          hash: outcome.hash,
        });
      }
    } catch (err) {
      setTxOutcome({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to execute multichain transfer.',
      });
    } finally {
      setSendingTx(false);
    }
  };

  const handleServerProvision = async () => {
    const cleanId = (externalUserId || firebaseUser?.uid || '').trim();
    if (!cleanId) return;

    setServerBusy(true);
    setServerError(null);
    setServerResult(null);
    try {
      const res = await fetch('/api/pollar/users/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalUserId: cleanId,
          email: firebaseUser?.email || undefined,
          name: firebaseUser?.displayName || undefined,
        }),
      });
      const json = (await res.json()) as { data?: unknown; error?: string };
      if (!res.ok) {
        setServerError(json.error || `Server returned HTTP ${res.status}`);
      } else {
        setServerResult(JSON.stringify(json.data, null, 2));
      }
    } catch {
      setServerError('Unable to reach /api/pollar/users/provision.');
    } finally {
      setServerBusy(false);
    }
  };

  const handleServerFetchWallets = async () => {
    const cleanId = (externalUserId || firebaseUser?.uid || '').trim();
    if (!cleanId) return;

    setServerBusy(true);
    setServerError(null);
    setServerResult(null);
    try {
      const res = await fetch(
        `/api/pollar/users/${encodeURIComponent(cleanId)}/wallets`
      );
      const json = (await res.json()) as { data?: unknown; error?: string };
      if (!res.ok) {
        setServerError(json.error || `Server returned HTTP ${res.status}`);
      } else {
        setServerResult(JSON.stringify(json.data, null, 2));
      }
    } catch {
      setServerError('Unable to reach /api/pollar/users/:id/wallets.');
    } finally {
      setServerBusy(false);
    }
  };

  const envSnippet = `# Client (Vite SPA)
VITE_POLLAR_PUBLISHABLE_KEY="pub_testnet_..."
VITE_POLLAR_STELLAR_NETWORK="testnet"

# Server-Only (Express /api/pollar/* -> https://server.api.pollar.xyz)
POLLAR_API_URL="https://server.api.pollar.xyz"
POLLAR_SECRET_KEY="sec_testnet_..."`;

  const balances = walletBalance.step === 'loaded' ? walletBalance.data.balances : [];

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header & Official Pollar Wallet Widget */}
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 sm:gap-6 pb-5 sm:pb-6 border-b border-slate-200">
        <div className="space-y-2 max-w-2xl min-w-0">
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
            Pollar Zero-VPS Multichain Layer
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            Social login to instant Stellar, Solana, and Polygon wallets with fee-sponsored USDC
            payments, fiat cash-in/cash-out ramps, swaps, and Turnkey co-signed custody—zero VPS required.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 pt-1">
            <span>SDK 0.12.0</span>
            <span aria-hidden="true">·</span>
            <span>Network: {network || targetNetwork}</span>
            <span aria-hidden="true">·</span>
            <span>Config: {configStatus}</span>
            <span aria-hidden="true">·</span>
            <span>
              Publishable key: {publishableConfigured ? 'Configured' : 'Not set'}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Server secret: {serverStatus?.secretKeyConfigured ? 'Configured' : 'Not set'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {publishableConfigured ? (
            <WalletButton />
          ) : (
            <a
              href="https://dashboard.pollar.xyz"
              target="_blank"
              rel="noreferrer"
              className="min-h-[44px] inline-flex items-center px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150 whitespace-nowrap"
            >
              Get Keys at dashboard.pollar.xyz
            </a>
          )}
        </div>
      </section>

      {/* Configuration Readiness Banner */}
      {(!publishableConfigured || !serverStatus?.secretKeyConfigured) && (
        <section className="bg-white border border-amber-300 rounded-xl p-4 sm:p-5 flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-slate-900">
                Add Pollar API keys in your AI Studio Secrets or environment to enable live transactions
              </p>
              <p className="text-xs text-slate-600 leading-relaxed">
                Create an app at <span className="font-mono">dashboard.pollar.xyz</span>, add{' '}
                <span className="font-mono">{currentOrigin}</span> under{' '}
                <span className="font-medium">Developers → Websites (Allowed Origins)</span>, enable{' '}
                <span className="font-medium">Stellar / Solana / Polygon</span>, and set{' '}
                <span className="font-mono">VITE_POLLAR_PUBLISHABLE_KEY</span> and{' '}
                <span className="font-mono">POLLAR_SECRET_KEY</span>.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void refreshServerStatus()}
            disabled={statusLoading}
            className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:border-slate-300 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>Refresh Status</span>
          </button>
        </section>
      )}

      {storageDegraded && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
          Browser storage degraded to in-memory mode; Pollar DPoP session tokens will reset on reload.
        </div>
      )}

      {/* Session & Multi-Chain Wallets */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
        {/* Left: Connected Session, Wallets & Live Balances */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
            <div className="space-y-1 min-w-0">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                01. Social Login & Embedded Wallets
              </h2>
              <p className="text-xs text-slate-500">
                One sign-in provisions Stellar, Solana, and Polygon addresses with DPoP-bound tokens.
              </p>
            </div>

            {isAuthenticated && (
              <button
                type="button"
                onClick={() => void logout()}
                className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                Disconnect Pollar
              </button>
            )}
          </div>

          {!isAuthenticated ? (
            <div className="p-4 sm:p-5 bg-slate-50 border border-slate-200 rounded-xl space-y-4">
              {pollarAuthError && (
                <div
                  role="alert"
                  className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 break-words"
                >
                  {pollarAuthError}
                </div>
              )}
              <p className="text-xs text-slate-600 leading-relaxed">
                Authenticate via Google OAuth, Email OTP, Passkey Smart Wallet, or external Stellar /
                Solana adapters.
              </p>
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={!publishableConfigured}
                  onClick={() => {
                    clearPollarAuthError();
                    login({ provider: 'google' });
                  }}
                  className="min-h-[44px] px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors duration-150 cursor-pointer"
                >
                  Continue with Google (Pollar)
                </button>
                <button
                  type="button"
                  disabled={!publishableConfigured}
                  onClick={() => {
                    clearPollarAuthError();
                    openLoginModal();
                  }}
                  className="min-h-[44px] px-4 py-2.5 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:border-slate-300 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors duration-150 cursor-pointer"
                >
                  Open Email / Passkey / Wallet Modal
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800">
                    Active Pollar Session ({verified ? 'Server Verified' : 'Resuming'})
                  </span>
                  <span className="font-mono text-slate-600">
                    Custody: {wallet?.custody ?? 'pending'}
                  </span>
                </div>
                {primaryChain && primaryAddress && (
                  <p className="font-mono text-slate-700 break-all">
                    Primary ({primaryChain}): {primaryAddress}
                  </p>
                )}
                {recoveryLocked && (
                  <div className="pt-2 flex items-center justify-between gap-2 text-amber-800">
                    <span>Add a passkey or email recovery method before signing.</span>
                    <button
                      type="button"
                      onClick={() => openRecoveryModal()}
                      className="px-2.5 py-1 bg-amber-100 hover:bg-amber-200 text-amber-950 font-semibold rounded cursor-pointer"
                    >
                      Set up recovery
                    </button>
                  </div>
                )}
              </div>

              {!hasWallet && (
                <button
                  type="button"
                  disabled={creatingWallet}
                  onClick={() => void handleCreateOnDemandWallet()}
                  className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  {creatingWallet ? 'Provisioning Multichain Wallets...' : 'Create On-Demand Wallets'}
                </button>
              )}

              {/* Per-chain wallet addresses */}
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                {(wallets.length > 0 ? wallets : []).map((w, index) => {
                  const chain = w.chain ?? 'STELLAR';
                  const notReady = walletNotReadyReason(w, chain);
                  const copyId = `wallet-${chain}-${index}`;
                  return (
                    <div
                      key={copyId}
                      className="p-3.5 flex items-center justify-between gap-3 text-xs bg-white"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{chain}</span>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="text-slate-500">{w.custody}</span>
                          {notReady && (
                            <>
                              <span aria-hidden="true" className="text-slate-300">
                                ·
                              </span>
                              <span className="text-amber-700">{notReady}</span>
                            </>
                          )}
                        </div>
                        <p className="font-mono text-slate-600 truncate">{w.address}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleCopy(copyId, w.address)}
                        aria-label={`Copy ${chain} address`}
                        className="p-2 text-slate-500 hover:text-slate-900 shrink-0 cursor-pointer"
                      >
                        {copiedKey === copyId ? (
                          <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                        ) : (
                          <Copy className="w-4 h-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  );
                })}
                {wallets.length === 0 && (
                  <div className="p-4 text-xs text-slate-500">
                    No chain wallets provisioned yet.
                    {activeChains.length > 0 && ` Enabled chains: ${activeChains.join(', ')}.`}
                  </div>
                )}
              </div>

              {/* Balances Strip */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">Live Balances</span>
                  <button
                    type="button"
                    onClick={() => void refreshWalletBalance()}
                    className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Refresh</span>
                  </button>
                </div>
                {balances.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    {walletBalance.step === 'loading'
                      ? 'Fetching balances...'
                      : 'Open Balances or Fund via Cash In to inspect token holdings.'}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 font-mono tabular-nums">
                    {balances.map((b, idx) => (
                      <div
                        key={`${b.code}-${b.chain ?? 'STELLAR'}-${idx}`}
                        className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                      >
                        <div className="text-slate-500 font-sans">
                          {b.chain ?? 'STELLAR'} · {b.code}
                        </div>
                        <div className="text-sm font-semibold text-slate-900 mt-0.5">
                          {b.balance}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Pre-Built @pollar/react Modals */}
          <div className="pt-4 border-t border-slate-100 space-y-2.5">
            <h3 className="text-xs font-semibold text-slate-500">
              Pre-Built @pollar/react Workflows
            </h3>
            <div className="grid grid-cols-1 min-[360px]:grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                { label: 'Balances', icon: Wallet, action: openWalletBalanceModal },
                { label: 'Send Modal', icon: Send, action: openSendModal },
                { label: 'Receive QR', icon: CheckCircle2, action: openReceiveModal },
                { label: 'Swap Tokens', icon: ArrowRightLeft, action: openSwapModal },
                { label: 'Cash In / Out', icon: Landmark, action: openRampModal },
                { label: 'KYC Checks', icon: UserCheck, action: () => openKycModal() },
                { label: 'Tx History', icon: History, action: openTxHistoryModal },
                { label: 'Recovery', icon: KeyRound, action: openRecoveryModal },
                { label: 'Sessions', icon: ShieldCheck, action: openSessionsModal },
                { label: 'Earn / Vaults', icon: Landmark, action: openEarnModal },
                { label: 'Issued Cards', icon: CreditCard, action: openCardModal },
                { label: 'Claims / Drops', icon: CheckCircle2, action: openDistributionRulesModal },
              ].map((item) => {
                const Icon = item.icon;
                const disabled = !publishableConfigured || !isAuthenticated;
                return (
                  <button
                    key={item.label}
                    type="button"
                    disabled={disabled}
                    onClick={item.action}
                    className="min-h-[44px] px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 hover:text-slate-900 disabled:opacity-45 disabled:cursor-not-allowed inline-flex items-center gap-1.5 whitespace-nowrap transition-colors duration-150 cursor-pointer"
                  >
                    <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Right: Programmatic Multichain Payment (`sendPayment` + `toBaseUnits`) */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-semibold text-slate-900">
              02. Sponsored Multichain Payment (`sendPayment`)
            </h2>
            <p className="text-xs text-slate-500">
              Executes `usePollar().sendPayment` across Stellar, Solana, and Polygon with automatic
              integer base-unit conversion via `@pollar/core` `toBaseUnits`.
            </p>
          </div>

          <form onSubmit={(e) => void handleSendPayment(e)} className="space-y-4">
            {/* Chain Selector */}
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-slate-700">Target Chain</span>
              <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
                {CHAINS_LIST.map((chain) => {
                  const active = selectedChain === chain;
                  return (
                    <button
                      key={chain}
                      type="button"
                      onClick={() => setSelectedChain(chain)}
                      className={`min-h-[40px] py-2 px-1.5 sm:px-3 text-xs font-semibold rounded-lg border truncate transition-colors duration-150 cursor-pointer ${
                        active
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {chain}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Asset Toggle */}
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-slate-700">Settlement Asset</span>
              <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-2">
                {(['USDC', 'NATIVE'] as PollarAssetSymbol[]).map((kind) => {
                  const opt = assetOptions.find((a) =>
                    kind === 'NATIVE' ? a.isNative : !a.isNative
                  );
                  const active = assetKind === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setAssetKind(kind)}
                      className={`min-h-[40px] py-2 px-3 text-xs font-medium rounded-lg border text-left transition-colors duration-150 cursor-pointer ${
                        active
                          ? 'bg-amber-50 text-amber-950 border-amber-400 font-semibold'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {opt?.label || kind}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Destination Address */}
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-slate-700">
                Recipient {selectedChain} Address
              </span>
              <input
                type="text"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder={
                  selectedChain === 'STELLAR'
                    ? 'G... or C...'
                    : selectedChain === 'SOLANA'
                    ? 'Base58 Solana public key...'
                    : '0x... Polygon address'
                }
                className="w-full px-3.5 py-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              />
            </label>

            {/* Amount & Memo */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-slate-700">
                  Amount ({selectedAssetOption.symbol})
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                />
              </label>

              {selectedChain === 'STELLAR' && (
                <label className="block space-y-1.5">
                  <span className="block text-xs font-medium text-slate-700">
                    Stellar Text Memo (Optional)
                  </span>
                  <input
                    type="text"
                    maxLength={28}
                    value={memoText}
                    onChange={(e) => setMemoText(e.target.value)}
                    placeholder="Market ID / reference"
                    className="w-full px-3.5 py-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                  />
                </label>
              )}
            </div>

            <button
              type="submit"
              disabled={sendingTx}
              className="w-full py-3 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors duration-150 inline-flex items-center justify-center gap-2 cursor-pointer"
            >
              <Send className="w-4 h-4" aria-hidden="true" />
              <span>
                {sendingTx
                  ? `Processing (${tx.step})...`
                  : isAuthenticated
                  ? `Send ${amount || '0'} ${selectedAssetOption.symbol} via Pollar`
                  : 'Sign In with Pollar to Send'}
              </span>
            </button>
          </form>

          {txOutcome && (
            <div
              className={`p-3.5 rounded-lg border text-xs space-y-1 ${
                txOutcome.status === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : txOutcome.status === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              <p className="font-semibold">{txOutcome.message}</p>
              {txOutcome.hash && (
                <p className="font-mono break-all text-[11px]">Hash: {txOutcome.hash}</p>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Server API v3 Proxy & Environment Setup */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-semibold text-slate-900">
              03. Backend Server API v3 Bridge (`/api/pollar/*`)
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Provision managed users and inspect wallets server-side against{' '}
              <span className="font-mono">https://server.api.pollar.xyz/v3</span> with{' '}
              <span className="font-mono">x-pollar-api-key</span> kept strictly inside{' '}
              <span className="font-mono">server.ts</span>.
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="block text-xs font-medium text-slate-700">
              External User ID (`x-pollar-external-user-id`)
            </span>
            <input
              type="text"
              value={externalUserId}
              onChange={(e) => setExternalUserId(e.target.value)}
              placeholder="Firebase UID or app user ID"
              className="w-full min-h-[44px] px-3.5 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={serverBusy}
              onClick={() => void handleServerProvision()}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg cursor-pointer"
            >
              {serverBusy ? 'Calling Server API...' : 'Provision User + Wallets'}
            </button>
            <button
              type="button"
              disabled={serverBusy}
              onClick={() => void handleServerFetchWallets()}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:border-slate-300 disabled:opacity-50 rounded-lg cursor-pointer"
            >
              Fetch Server Wallets
            </button>
          </div>

          {serverError && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
              {serverError}
            </div>
          )}

          {serverResult && (
            <pre className="p-3.5 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto max-h-56">
              {serverResult}
            </pre>
          )}
        </section>

        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                04. Environment Variables (`.env`)
              </h2>
              <p className="text-xs text-slate-500">
                Copy keys from <span className="font-mono">dashboard.pollar.xyz</span> into your
                environment secrets. Never place <span className="font-mono">sec_*</span> keys in{' '}
                <span className="font-mono">VITE_*</span> variables.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCopy('env-snippet', envSnippet)}
              className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:border-slate-300 inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              {copiedKey === 'env-snippet' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>

          <pre className="p-4 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed">
            {envSnippet}
          </pre>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1 text-xs text-slate-600">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-800">Allowed Origin for Pollar Dashboard</span>
              <button
                type="button"
                onClick={() => void handleCopy('origin', currentOrigin)}
                className="text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 cursor-pointer"
              >
                <Copy className="w-3 h-3" aria-hidden="true" />
                <span>{copiedKey === 'origin' ? 'Copied' : 'Copy URL'}</span>
              </button>
            </div>
            <p className="font-mono text-slate-800 break-all">{currentOrigin}</p>
          </div>
        </section>
      </div>
    </div>
  );
};

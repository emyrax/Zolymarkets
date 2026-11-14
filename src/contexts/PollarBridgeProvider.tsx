/**
 * Zolymarket — Pollar 0.12 Provider Bridge
 *
 * Initializes a singleton `PollarClient` from `@pollar/core` and wraps the app in
 * `@pollar/react`'s `PollarProvider`. When `VITE_POLLAR_PUBLISHABLE_KEY` is configured,
 * `PollarProvider` loads live branding, auth providers, and enabled chains directly
 * from Pollar. When unconfigured, it supplies a deterministic local fallback config
 * so the app boots with zero failed network calls while surfacing `.env` readiness.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { PollarClient, PollarLogger, StellarNetwork } from '@pollar/core';
import { PollarConfig, PollarProvider } from '@pollar/react';

export interface PollarServerStatus {
  publishableKeyConfigured: boolean;
  secretKeyConfigured: boolean;
  network: 'testnet' | 'mainnet';
  serverApiUrl: string;
  sdkVersion: string;
  supportedChains: ('STELLAR' | 'SOLANA' | 'POLYGON')[];
}

interface PollarBridgeContextValue {
  publishableConfigured: boolean;
  targetNetwork: StellarNetwork;
  storageDegraded: boolean;
  serverStatus: PollarServerStatus | null;
  statusLoading: boolean;
  pollarAuthError: string | null;
  clearPollarAuthError: () => void;
  refreshServerStatus: () => Promise<void>;
}

const PollarBridgeContext = createContext<PollarBridgeContextValue | null>(null);

const rawPublishableKey = (
  import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY as string | undefined
)?.trim() || '';

const rawNetwork = (
  import.meta.env.VITE_POLLAR_STELLAR_NETWORK as string | undefined
)?.trim().toLowerCase();

const TARGET_NETWORK: StellarNetwork = rawNetwork === 'mainnet' ? 'mainnet' : 'testnet';

const PUBLISHABLE_CONFIGURED =
  rawPublishableKey.length > 0 && !rawPublishableKey.startsWith('MY_');

const POLLAR_SDK_BASE_URL =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname.endsWith('.run.app'))
    ? `${window.location.origin}/api/pollar-sdk`
    : undefined;

const FALLBACK_POLLAR_CONFIG: PollarConfig = {
  application: {
    name: 'Zolymarket',
    network: TARGET_NETWORK,
    chains: ['STELLAR', 'SOLANA', 'POLYGON'],
    walletProvisioning: 'AT_LOGIN',
    walletCustodyMode: 'COSIGNED',
    signConfirmation: {
      mode: 'PROMPT',
      windowSeconds: 300,
      maxUsd: '100',
    },
  },
  styles: {
    theme: 'light',
    accentColor: '#d97706',
    modalTitle: 'Zolymarket Wallet',
    emailEnabled: true,
    embeddedWallets: true,
    smartWallet: true,
    providers: {
      google: true,
      github: false,
      discord: false,
      x: false,
      apple: false,
    },
  },
};

function formatPollarErrorMessage(rawMessage?: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'this URL';
  const detail = rawMessage ? ` (${rawMessage})` : '';
  return `Pollar social sign-in could not start${detail}. Verify VITE_POLLAR_PUBLISHABLE_KEY and add ${origin} to Allowed Origins in dashboard.pollar.xyz — or sign in with Polygon Browser Wallet or Zcash right below.`;
}

const authErrorListeners = new Set<(message: string) => void>();

const safePollarLogger: PollarLogger = {
  error: (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    const errArg = args.find((a) => a instanceof Error) as Error | undefined;
    const isAuthOrFetchFailure =
      first.includes('auth flow') ||
      first.includes('/auth/') ||
      (errArg?.message && errArg.message.toLowerCase().includes('fetch'));

    if (isAuthOrFetchFailure) {
      const msg = formatPollarErrorMessage(errArg?.message || first);
      authErrorListeners.forEach((cb) => cb(msg));
      console.warn(...args);
      return;
    }
    console.warn(...args);
  },
  warn: (...args: unknown[]) => console.warn(...args),
  info: (...args: unknown[]) => console.info(...args),
  debug: (...args: unknown[]) => console.debug(...args),
};

const pollarClientSingleton = new PollarClient({
  apiKey: PUBLISHABLE_CONFIGURED ? rawPublishableKey : 'pollar_unconfigured_local',
  baseUrl: POLLAR_SDK_BASE_URL,
  stellarNetwork: TARGET_NETWORK,
  confirmation: 'prompt',
  logLevel: PUBLISHABLE_CONFIGURED ? 'warn' : 'silent',
  logger: safePollarLogger,
});

export const PollarBridgeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [storageDegraded, setStorageDegraded] = useState<boolean>(false);
  const [serverStatus, setServerStatus] = useState<PollarServerStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(true);
  const [pollarAuthError, setPollarAuthError] = useState<string | null>(null);

  const clearPollarAuthError = useCallback(() => {
    setPollarAuthError(null);
  }, []);

  const refreshServerStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await fetch('/api/pollar/status');
      if (res.ok) {
        const data = (await res.json()) as PollarServerStatus;
        setServerStatus(data);
      }
    } catch {
      // Ignore network errors while server is restarting
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshServerStatus();
  }, [refreshServerStatus]);

  useEffect(() => {
    const onLoggerError = (msg: string) => setPollarAuthError(msg);
    authErrorListeners.add(onLoggerError);

    const unsubAuth = pollarClientSingleton.onAuthStateChange((state) => {
      if (state.step === 'error') {
        setPollarAuthError(formatPollarErrorMessage(state.message));
      } else if (state.step === 'authenticated' || state.step === 'creating_session') {
        setPollarAuthError(null);
      }
    });

    return () => {
      authErrorListeners.delete(onLoggerError);
      unsubAuth();
    };
  }, []);

  return (
    <PollarBridgeContext.Provider
      value={{
        publishableConfigured: PUBLISHABLE_CONFIGURED,
        targetNetwork: TARGET_NETWORK,
        storageDegraded,
        serverStatus,
        statusLoading,
        pollarAuthError,
        clearPollarAuthError,
        refreshServerStatus,
      }}
    >
      <PollarProvider
        client={pollarClientSingleton}
        appConfig={PUBLISHABLE_CONFIGURED ? undefined : FALLBACK_POLLAR_CONFIG}
        onStorageDegrade={() => setStorageDegraded(true)}
      >
        {children}
      </PollarProvider>
    </PollarBridgeContext.Provider>
  );
};

export function usePollarBridge(): PollarBridgeContextValue {
  const ctx = useContext(PollarBridgeContext);
  if (!ctx) {
    throw new Error('usePollarBridge must be used inside PollarBridgeProvider.');
  }
  return ctx;
}

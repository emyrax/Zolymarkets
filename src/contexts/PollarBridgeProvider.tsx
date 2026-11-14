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
import { PollarClient, StellarNetwork } from '@pollar/core';
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

const pollarClientSingleton = new PollarClient({
  apiKey: PUBLISHABLE_CONFIGURED ? rawPublishableKey : 'pollar_unconfigured_local',
  stellarNetwork: TARGET_NETWORK,
  confirmation: 'prompt',
  logLevel: PUBLISHABLE_CONFIGURED ? 'warn' : 'silent',
});

export const PollarBridgeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [storageDegraded, setStorageDegraded] = useState<boolean>(false);
  const [serverStatus, setServerStatus] = useState<PollarServerStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(true);

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

  return (
    <PollarBridgeContext.Provider
      value={{
        publishableConfigured: PUBLISHABLE_CONFIGURED,
        targetNetwork: TARGET_NETWORK,
        storageDegraded,
        serverStatus,
        statusLoading,
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

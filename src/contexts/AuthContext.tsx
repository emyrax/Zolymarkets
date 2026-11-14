/**
 * Zolymarket — Dual-Rail Authentication & Identity Context
 *
 * Supports One-Click Entry via:
 * - Zcash Shielded Wallet (`u1...` / `utest1...` / `zs1...`)
 * - Polygon EVM Wallet (`window.ethereum` / `0x...`) & Pollar Social
 * - Google Account (Firebase Auth + Cloud Firestore sync)
 *
 * Tracks the active role (`creator` vs `bettor`) and persists wallet session
 * state in `localStorage` so users can immediately create or place bets.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  OperationType,
  auth,
  db,
  googleAuthProvider,
  handleFirestoreError,
} from '../lib/firebase.ts';

export type WalletRail = 'zcash' | 'polygon';
export type UserRole = 'creator' | 'bettor';
export type AuthModalTab = 'zcash' | 'polygon' | 'google';

export interface DualRailSession {
  rail: WalletRail;
  address: string;
  label: string;
  chainId?: string;
  network?: 'testnet' | 'mainnet';
  authTxid?: string;
  ufvkFingerprint?: string;
  verifiedOnChain?: boolean;
  connectedAt: string;
}

interface EthereumProviderLike {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

export interface ZcashSignInOptions {
  authTxid?: string;
  ufvkFingerprint?: string;
  verifiedOnChain?: boolean;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  authError: string | null;
  walletSession: DualRailSession | null;
  userRole: UserRole;
  authModalOpen: boolean;
  authModalTab: AuthModalTab;
  openAuthModal: (tab?: AuthModalTab) => void;
  closeAuthModal: () => void;
  setUserRole: (role: UserRole) => void;
  connectZcashWallet: (
    address: string,
    label?: string,
    options?: ZcashSignInOptions
  ) => DualRailSession;
  verifyZcashSignIn: (params: {
    address: string;
    challengeId?: string;
    txid?: string;
    ufvk?: string;
  }) => Promise<{ session: DualRailSession; message: string; explorerUrl: string | null }>;
  connectPolygonWallet: () => Promise<DualRailSession>;
  connectPolygonAddress: (address: string, label?: string) => DualRailSession;
  disconnectWalletSession: () => void;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
}

const WALLET_SESSION_STORAGE_KEY = 'zolymarket_dual_rail_session_v1';
const USER_ROLE_STORAGE_KEY = 'zolymarket_user_role_v1';
const ZCASH_SHIELDED_REGEX = /^(u1|utest1|uregtest1|zs1)[0-9a-zA-Z]{16,252}$/;
const POLYGON_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

const AuthContext = createContext<AuthContextValue | null>(null);

async function syncUserProfileToFirestore(firebaseUser: User): Promise<void> {
  const publicPath = `users/${firebaseUser.uid}`;
  const privatePath = `users/${firebaseUser.uid}/private/info`;

  try {
    const publicRef = doc(db, 'users', firebaseUser.uid);
    const existingPublic = await getDoc(publicRef);

    const displayName = (firebaseUser.displayName || 'Zcash Trader').slice(0, 80);
    const photoUrl = firebaseUser.photoURL ? firebaseUser.photoURL.slice(0, 512) : '';

    if (!existingPublic.exists()) {
      await setDoc(publicRef, {
        uid: firebaseUser.uid,
        displayName,
        ...(photoUrl ? { photoUrl } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(
        publicRef,
        {
          displayName,
          ...(photoUrl ? { photoUrl } : {}),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, publicPath);
  }

  if (firebaseUser.email) {
    try {
      const privateRef = doc(db, 'users', firebaseUser.uid, 'private', 'info');
      const existingPrivate = await getDoc(privateRef);
      if (!existingPrivate.exists()) {
        await setDoc(privateRef, {
          uid: firebaseUser.uid,
          email: firebaseUser.email.slice(0, 254),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(
          privateRef,
          {
            email: firebaseUser.email.slice(0, 254),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, privatePath);
    }
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authModalTab, setAuthModalTab] = useState<AuthModalTab>('zcash');

  const [walletSession, setWalletSession] = useState<DualRailSession | null>(() => {
    try {
      const raw = localStorage.getItem(WALLET_SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<DualRailSession>;
      if (
        (parsed.rail === 'zcash' || parsed.rail === 'polygon') &&
        typeof parsed.address === 'string' &&
        parsed.address.trim().length > 0
      ) {
        return {
          rail: parsed.rail,
          address: parsed.address.trim(),
          label: parsed.label || (parsed.rail === 'zcash' ? 'Zcash Shielded' : 'Polygon Wallet'),
          chainId: parsed.chainId,
          network: parsed.network,
          authTxid: parsed.authTxid,
          ufvkFingerprint: parsed.ufvkFingerprint,
          verifiedOnChain: parsed.verifiedOnChain,
          connectedAt: parsed.connectedAt || new Date().toISOString(),
        };
      }
    } catch {
      // Ignore invalid local storage state
    }
    return null;
  });

  const [userRole, setUserRoleState] = useState<UserRole>(() => {
    try {
      const stored = localStorage.getItem(USER_ROLE_STORAGE_KEY);
      return stored === 'creator' ? 'creator' : 'bettor';
    } catch {
      return 'bettor';
    }
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setLoading(false);
      if (nextUser) {
        void syncUserProfileToFirestore(nextUser).catch((err) => {
          console.error('Profile sync error:', err);
        });
      }
    });
    return () => unsubscribe();
  }, []);

  const persistWalletSession = useCallback((next: DualRailSession | null) => {
    setWalletSession(next);
    try {
      if (next) {
        localStorage.setItem(WALLET_SESSION_STORAGE_KEY, JSON.stringify(next));
        if (next.rail === 'zcash') {
          localStorage.setItem('zolymarket_player_return_addr_v1', next.address);
        }
      } else {
        localStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures
    }
  }, []);

  const setUserRole = useCallback((role: UserRole) => {
    setUserRoleState(role);
    try {
      localStorage.setItem(USER_ROLE_STORAGE_KEY, role);
    } catch {
      // Ignore storage failures
    }
  }, []);

  const openAuthModal = useCallback((tab: AuthModalTab = 'zcash') => {
    setAuthError(null);
    setAuthModalTab(tab);
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
  }, []);

  const connectZcashWallet = useCallback(
    (
      address: string,
      label = 'Zcash Unified Wallet',
      options?: ZcashSignInOptions
    ): DualRailSession => {
      const clean = address.trim();
      if (!ZCASH_SHIELDED_REGEX.test(clean)) {
        throw new Error(
          'Enter a valid Zcash shielded address starting with u1, utest1, uregtest1, or zs1.'
        );
      }
      const detectedNetwork: 'testnet' | 'mainnet' =
        clean.startsWith('u1') || clean.startsWith('zs1') ? 'mainnet' : 'testnet';
      const session: DualRailSession = {
        rail: 'zcash',
        address: clean,
        label,
        network: detectedNetwork,
        authTxid: options?.authTxid,
        ufvkFingerprint: options?.ufvkFingerprint,
        verifiedOnChain: options?.verifiedOnChain,
        connectedAt: new Date().toISOString(),
      };
      setAuthError(null);
      persistWalletSession(session);
      return session;
    },
    [persistWalletSession]
  );

  const verifyZcashSignIn = useCallback(
    async (params: {
      address: string;
      challengeId?: string;
      txid?: string;
      ufvk?: string;
    }): Promise<{ session: DualRailSession; message: string; explorerUrl: string | null }> => {
      setAuthError(null);
      const res = await fetch('/api/zcash/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const json = (await res.json()) as {
        verified?: boolean;
        verifiedOnChain?: boolean;
        address?: string;
        txid?: string | null;
        ufvkFingerprint?: string | null;
        explorerUrl?: string | null;
        message?: string;
        error?: string;
      };
      if (!res.ok || !json.verified || !json.address) {
        const errMsg = json.error || 'Unable to verify Zcash protocol sign-in proof.';
        setAuthError(errMsg);
        throw new Error(errMsg);
      }

      // Store read-only UFVK only inside browser localStorage if supplied
      if (params.ufvk && params.ufvk.trim()) {
        try {
          localStorage.setItem('zolymarket_auth_ufvk_v1', params.ufvk.trim());
        } catch {
          // Ignore storage quota errors
        }
      }

      const session = connectZcashWallet(
        json.address,
        json.verifiedOnChain
          ? 'Zcash Verified Node'
          : json.ufvkFingerprint
          ? 'Zcash UFVK Verified'
          : 'Zcash Unified Wallet',
        {
          authTxid: json.txid ?? undefined,
          ufvkFingerprint: json.ufvkFingerprint ?? undefined,
          verifiedOnChain: Boolean(json.verifiedOnChain),
        }
      );

      return {
        session,
        message: json.message || 'Verified Zcash protocol sign-in.',
        explorerUrl: json.explorerUrl ?? null,
      };
    },
    [connectZcashWallet]
  );

  const connectPolygonAddress = useCallback(
    (address: string, label = 'Polygon Wallet'): DualRailSession => {
      const clean = address.trim();
      if (!POLYGON_ADDRESS_REGEX.test(clean)) {
        throw new Error('Enter a valid Polygon EVM address starting with 0x (42 characters).');
      }
      const session: DualRailSession = {
        rail: 'polygon',
        address: clean,
        label,
        chainId: '0x89',
        connectedAt: new Date().toISOString(),
      };
      setAuthError(null);
      persistWalletSession(session);
      return session;
    },
    [persistWalletSession]
  );

  const connectPolygonWallet = useCallback(async (): Promise<DualRailSession> => {
    setAuthError(null);
    const eth = (
      typeof window !== 'undefined'
        ? (window as unknown as { ethereum?: EthereumProviderLike }).ethereum
        : undefined
    );

    if (!eth?.request) {
      throw new Error(
        'No Polygon browser wallet extension detected. Paste your 0x... Polygon address or sign in with Pollar Social below.'
      );
    }

    const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
    const primary = Array.isArray(accounts) ? accounts[0] : '';
    if (!primary || !POLYGON_ADDRESS_REGEX.test(primary)) {
      throw new Error('No Polygon account returned from wallet.');
    }

    let chainId = '0x89';
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x89' }],
      });
    } catch {
      try {
        const currentChain = (await eth.request({ method: 'eth_chainId' })) as string;
        if (typeof currentChain === 'string' && currentChain) {
          chainId = currentChain;
        }
      } catch {
        // Keep default Polygon chainId tag
      }
    }

    const session: DualRailSession = {
      rail: 'polygon',
      address: primary,
      label: chainId === '0x89' ? 'Polygon PoS' : `Polygon EVM (${chainId})`,
      chainId,
      connectedAt: new Date().toISOString(),
    };
    persistWalletSession(session);
    return session;
  }, [persistWalletSession]);

  const disconnectWalletSession = useCallback(() => {
    persistWalletSession(null);
  }, [persistWalletSession]);

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : 'Unable to sign in with Google.'
      );
    }
  };

  const signOutUser = async () => {
    setAuthError(null);
    persistWalletSession(null);
    try {
      await signOut(auth);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to sign out.');
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authError,
        walletSession,
        userRole,
        authModalOpen,
        authModalTab,
        openAuthModal,
        closeAuthModal,
        setUserRole,
        connectZcashWallet,
        verifyZcashSignIn,
        connectPolygonWallet,
        connectPolygonAddress,
        disconnectWalletSession,
        signInWithGoogle,
        signOutUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }
  return ctx;
}

/**
 * Zolymarket — Firebase Authentication Context
 *
 * Uses `signInWithPopup` with GoogleAuthProvider and synchronizes
 * split public (`/users/{uid}`) and private PII (`/users/{uid}/private/info`)
 * documents in Cloud Firestore.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
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

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
}

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
    try {
      await signOut(auth);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to sign out.');
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, authError, signInWithGoogle, signOutUser }}
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

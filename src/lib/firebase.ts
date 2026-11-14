/**
 * Zolymarket — Firebase Client SDK Initialization & Error Handling
 *
 * Connects to the provisioned Cloud Firestore database (`firestoreDatabaseId`)
 * and Firebase Authentication (Google Sign-In) via `firebase-applet-config.json`.
 */

import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  Firestore,
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

function createFirestoreClient(): Firestore {
  if (typeof window !== 'undefined') {
    try {
      return initializeFirestore(
        app,
        { experimentalForceLongPolling: true },
        firebaseConfig.firestoreDatabaseId
      );
    } catch {
      // Fallback if Firestore instance was already initialized (e.g., HMR)
    }
  }
  return getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export const db = createFirestoreClient();
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

/**
 * Wraps Firestore permission/runtime errors with structured auth & path context
 * before rethrowing so rule issues can be diagnosed deterministically.
 */
export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * Validates Cloud Firestore connectivity against the server on application boot.
 */
async function testConnection(): Promise<void> {
  if (typeof window !== 'undefined' && navigator.onLine === false) {
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      const isTransientOffline =
        msg.includes('the client is offline') || msg.includes('unavailable');

      if (isTransientOffline && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        continue;
      }

      if (isTransientOffline) {
        console.error('Please check your Firebase configuration.');
      }
      return;
    }
  }
}

void testConnection();

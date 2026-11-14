/**
 * Zolymarket — Firebase Admin SDK Initialization (Server-Side)
 *
 * Reads `projectId` and `firestoreDatabaseId` from `firebase-applet-config.json`
 * via static JSON import. Used by backend routes and `lib/zcash-service.ts` to
 * write `shielded_bets` and update market CPMM reserves in Cloud Firestore.
 */

import { getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

let cachedAdminDb: Firestore | null = null;

export function getAdminFirestore(): Firestore | null {
  if (cachedAdminDb) return cachedAdminDb;
  try {
    cachedAdminDb = getFirestore(firebaseConfig.firestoreDatabaseId);
    return cachedAdminDb;
  } catch (error) {
    console.warn('Firebase Admin Firestore unavailable in current runtime:', error);
    return null;
  }
}

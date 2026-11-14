/**
 * Zolymarket — Dirty Dozen Adversarial Security Rules Specification Tests
 *
 * Documents the 12 adversarial payloads validated against `firestore.rules`.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email?: string; email_verified?: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Shadow field injection on Creator create',
    operation: 'create',
    path: '/creators/c_shadow',
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      id: 'c_shadow',
      ownerUid: 'user_1',
      handle: 'shadow_user',
      displayName: 'Shadow',
      bio: 'Test',
      zcashUnifiedAddress: 'u1q8w9x2e4r6t8y0u2i4o6p8a0s2d4f6g8h0j2k4l6',
      verified: false,
      marketsCreatedCount: 0,
      totalVolumeZatoshis: 0,
      isAdmin: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Verified creator badge spoofing by non-admin',
    operation: 'create',
    path: '/creators/c_spoof',
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      id: 'c_spoof',
      ownerUid: 'user_1',
      handle: 'spoof_user',
      displayName: 'Spoof',
      bio: 'Test',
      zcashUnifiedAddress: 'u1q8w9x2e4r6t8y0u2i4o6p8a0s2d4f6g8h0j2k4l6',
      verified: true,
      marketsCreatedCount: 99,
      totalVolumeZatoshis: 1000000000,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Owner UID spoofing on Market create',
    operation: 'create',
    path: '/markets/m_spoof',
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      id: 'm_spoof',
      ownerUid: 'user_victim',
      creatorId: 'c1',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Orphan market referencing missing creatorId',
    operation: 'create',
    path: '/markets/m_orphan',
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      id: 'm_orphan',
      ownerUid: 'user_1',
      creatorId: 'nonexistent_creator_id',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Client timestamp forgery on Market create',
    operation: 'create',
    path: '/markets/m_backdate',
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      id: 'm_backdate',
      createdAt: '2020-01-01T00:00:00Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Resource exhaustion via oversized ID and question',
    operation: 'create',
    path: `/markets/${'x'.repeat(300)}`,
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      question: 'a'.repeat(5000),
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Post-resolution outcome tampering by market owner',
    operation: 'update',
    path: '/markets/m_resolved',
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      winningOutcome: 'NO',
      status: 'open',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Unverified email spoofing admin privilege',
    operation: 'create',
    path: '/shielded_bets/b_spoof',
    auth: { uid: 'attacker', email: 'ekwuemesat@gmail.com', email_verified: false },
    payload: {
      id: 'b_spoof',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Cross-user PII read on /users/{userId}/private/info',
    operation: 'get',
    path: '/users/user_victim/private/info',
    auth: { uid: 'user_attacker', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Non-admin direct write to /shielded_bets',
    operation: 'create',
    path: '/shielded_bets/b_fake',
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      id: 'b_fake',
      marketId: 'm1',
      amountZatoshis: 500000000,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Trader self-modifying position shares and claimed status',
    operation: 'update',
    path: '/positions/pos_1',
    auth: { uid: 'user_1', email: 'u1@example.com', email_verified: true },
    payload: {
      shares: 999999,
      claimed: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unscoped list query scraping /positions',
    operation: 'list',
    path: '/positions',
    auth: { uid: 'user_attacker', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
];

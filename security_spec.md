# Zolymarket Firestore Security Specification

## 1. Data Invariants
1. **Default-Deny Baseline**: Every path in `/databases/{database}/documents` is denied unless explicitly permitted by a matching rule block.
2. **PII Isolation**: User email addresses are stored exclusively in `/users/{userId}/private/info` and are readable/writable only by the owning UID or a verified admin (`email_verified == true`).
3. **Market Referential Integrity**: Every `/markets/{marketId}` document must reference an existing `/creators/{creatorId}` document verified via `exists()`. Every `/shielded_bets/{betId}`, `/shielded_transactions/{txId}`, and `/positions/{positionId}` must reference an existing `/markets/{marketId}` document.
4. **Immutable Audit Fields & Server Timestamps**: `createdAt` must equal `request.time` on creation and remain unchanged on updates; `updatedAt` must equal `request.time` on both creation and updates. `creatorId`, `ownerUid`, and `marketId` are immutable after creation.
5. **Terminal State Locking**: Once a market reaches `status == 'resolved'` or `status == 'cancelled'`, only a verified admin may alter it.
6. **Privilege Escalation Prevention**: Non-admin creators cannot self-assign `verified: true` or fabricate `marketsCreatedCount` / `totalVolumeZatoshis`, and no client may write to `/admins/{userId}`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Shadow Field Injection on Creator**: `POST /creators/c1` with valid fields + `{ "isAdmin": true }` -> **PERMISSION_DENIED** (`hasOnly` rejects unknown keys).
2. **Verified Badge Spoofing**: Non-admin `POST /creators/c2` with `{ "verified": true, "marketsCreatedCount": 99 }` -> **PERMISSION_DENIED**.
3. **Identity Spoofing on Market Create**: Signed-in user `uid_a` creates `/markets/m1` with `ownerUid: "uid_b"` -> **PERMISSION_DENIED**.
4. **Orphan Market Creation**: Create `/markets/m_orphan` with `creatorId: "nonexistent_creator"` -> **PERMISSION_DENIED** (`exists()` fails).
5. **Client Timestamp Forgery**: Create `/markets/m1` with `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time` -> **PERMISSION_DENIED**.
6. **Resource Exhaustion (1MB Question)**: Create `/markets/m1` with `question` length > 280 chars or `id` > 128 chars -> **PERMISSION_DENIED**.
7. **Post-Resolution Outcome Tampering**: Non-admin or creator updates `winningOutcome` or `yesPoolZatoshis` on a `resolved` market -> **PERMISSION_DENIED**.
8. **Email Spoofing Admin Bypass**: Token has `email: "ekwuemesat@gmail.com"` with `email_verified: false` -> **PERMISSION_DENIED**.
9. **PII Leak Attempt**: Signed-in `uid_b` calls `get` on `/users/uid_a/private/info` -> **PERMISSION_DENIED**.
10. **Unauthorized Shielded Bet Injection**: Regular signed-in user writes directly to `/shielded_bets/b1` -> **PERMISSION_DENIED** (admin-only ingestion).
11. **Position Claim Self-Grant**: Position owner updates `claimed: true` or `shares: 999999` -> **PERMISSION_DENIED**.
12. **Query Scraping Private Positions**: Signed-in `uid_b` executes `list` on `/positions` without scoping `ownerUid == uid_b` -> **PERMISSION_DENIED**.

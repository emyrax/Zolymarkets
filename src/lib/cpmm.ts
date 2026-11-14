/**
 * Zolymarket — Constant Product Market Maker (CPMM) & ZEC Unit Utilities
 *
 * Uses integer zatoshis (10^8 zatoshis = 1 ZEC) for reserve math and
 * provides deterministic YES/NO implied probabilities from pool balances.
 */

export const ZATOSHIS_PER_ZEC = 100_000_000;

/**
 * Converts integer zatoshis to floating-point ZEC for display.
 */
export function zatoshisToZec(zatoshis: number): number {
  return zatoshis / ZATOSHIS_PER_ZEC;
}

/**
 * Converts a ZEC decimal amount into rounded integer zatoshis.
 */
export function zecToZatoshis(zec: number): number {
  return Math.round(zec * ZATOSHIS_PER_ZEC);
}

/**
 * Formats zatoshis as a concise ZEC string (e.g., "14.25 ZEC").
 */
export function formatZec(zatoshis: number, decimals = 2): string {
  const zec = zatoshisToZec(zatoshis);
  return `${zec.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} ZEC`;
}

/**
 * Calculates implied YES / NO probabilities (0–100) from CPMM pool reserves.
 * In a binary CPMM where k = yesPool * noPool:
 *   P(YES) = noPool / (yesPool + noPool)
 *   P(NO)  = yesPool / (yesPool + noPool)
 */
export function calculateBinaryOdds(
  yesPoolZatoshis: number,
  noPoolZatoshis: number
): { yesProbability: number; noProbability: number } {
  const total = yesPoolZatoshis + noPoolZatoshis;
  if (total <= 0) {
    return { yesProbability: 50, noProbability: 50 };
  }
  const yesProbability = Math.round((noPoolZatoshis / total) * 1000) / 10;
  const noProbability = Math.round((100 - yesProbability) * 10) / 10;
  return { yesProbability, noProbability };
}

/**
 * Estimates outcome shares received for an incoming shielded ZEC deposit
 * after deducting the creator fee (in basis points).
 */
export function estimateSharesOut(params: {
  amountZatoshis: number;
  targetPoolZatoshis: number;
  oppositePoolZatoshis: number;
  creatorFeeBps: number;
}): {
  sharesOut: number;
  feeZatoshis: number;
  netDepositZatoshis: number;
} {
  const { amountZatoshis, targetPoolZatoshis, oppositePoolZatoshis, creatorFeeBps } = params;
  const feeZatoshis = Math.floor((amountZatoshis * creatorFeeBps) / 10_000);
  const netDepositZatoshis = Math.max(0, amountZatoshis - feeZatoshis);

  if (netDepositZatoshis === 0 || targetPoolZatoshis <= 0 || oppositePoolZatoshis <= 0) {
    return { sharesOut: 0, feeZatoshis, netDepositZatoshis };
  }

  // Constant product invariant k = targetPool * oppositePool
  const k = targetPoolZatoshis * oppositePoolZatoshis;
  const newOppositePool = oppositePoolZatoshis + netDepositZatoshis;
  const newTargetPool = k / newOppositePool;
  const targetTokensPurchased = targetPoolZatoshis - newTargetPool;

  // Express shares in ZEC units (1 share pays out 1 ZEC on winning resolution)
  const sharesOut = zatoshisToZec(netDepositZatoshis + targetTokensPurchased);

  return {
    sharesOut: Math.max(0, Math.round(sharesOut * 10_000) / 10_000),
    feeZatoshis,
    netDepositZatoshis,
  };
}

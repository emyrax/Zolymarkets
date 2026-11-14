/**
 * Pollar Multichain Asset Catalog & Payment Parameter Builder
 *
 * Uses `@pollar/core`'s `toBaseUnits` for safe string/BigInt integer base-unit
 * conversion on Solana (lamports / SPL smallest unit) and Polygon (wei / ERC-20).
 */

import { SendPaymentParams, StellarNetwork, WalletChain, toBaseUnits } from '@pollar/core';

export type PollarAssetSymbol = 'USDC' | 'NATIVE';

export interface ChainAssetOption {
  chain: WalletChain;
  symbol: string;
  label: string;
  decimals: number;
  isNative: boolean;
  issuer?: string;
  mintOrContract?: string;
}

const STELLAR_USDC_ISSUER: Record<StellarNetwork, string> = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

const SOLANA_USDC_MINT: Record<StellarNetwork, string> = {
  testnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const POLYGON_USDC_CONTRACT: Record<StellarNetwork, string> = {
  testnet: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  mainnet: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

export function getChainAssetOptions(
  chain: WalletChain,
  network: StellarNetwork
): ChainAssetOption[] {
  if (chain === 'STELLAR') {
    return [
      {
        chain: 'STELLAR',
        symbol: 'USDC',
        label: 'USDC (Stellar)',
        decimals: 7,
        isNative: false,
        issuer: STELLAR_USDC_ISSUER[network],
      },
      {
        chain: 'STELLAR',
        symbol: 'XLM',
        label: 'XLM (Native)',
        decimals: 7,
        isNative: true,
      },
    ];
  }

  if (chain === 'SOLANA') {
    return [
      {
        chain: 'SOLANA',
        symbol: 'USDC',
        label: network === 'testnet' ? 'USDC (Solana Devnet SPL)' : 'USDC (Solana SPL)',
        decimals: 6,
        isNative: false,
        mintOrContract: SOLANA_USDC_MINT[network],
      },
      {
        chain: 'SOLANA',
        symbol: 'SOL',
        label: 'SOL (Native)',
        decimals: 9,
        isNative: true,
      },
    ];
  }

  return [
    {
      chain: 'POLYGON',
      symbol: 'USDC',
      label: network === 'testnet' ? 'USDC (Polygon Amoy)' : 'USDC (Polygon ERC-20)',
      decimals: 6,
      isNative: false,
      mintOrContract: POLYGON_USDC_CONTRACT[network],
    },
    {
      chain: 'POLYGON',
      symbol: 'POL',
      label: 'POL (Native)',
      decimals: 18,
      isNative: true,
    },
  ];
}

export function buildPollarPaymentParams(input: {
  chain: WalletChain;
  network: StellarNetwork;
  destination: string;
  amount: string;
  assetKind: PollarAssetSymbol;
  memoText?: string;
}): SendPaymentParams {
  const destination = input.destination.trim();
  const amount = input.amount.trim();

  if (input.chain === 'STELLAR') {
    const asset =
      input.assetKind === 'NATIVE'
        ? ({ type: 'native' } as const)
        : ({
            type: 'credit_alphanum4',
            code: 'USDC',
            issuer: STELLAR_USDC_ISSUER[input.network],
          } as const);

    return {
      chain: 'STELLAR',
      destination,
      amount,
      asset,
      ...(input.memoText?.trim()
        ? {
            options: {
              memo: {
                type: 'text' as const,
                value: input.memoText.trim().slice(0, 28),
              },
            },
          }
        : {}),
    };
  }

  if (input.chain === 'SOLANA') {
    if (input.assetKind === 'NATIVE') {
      return {
        chain: 'SOLANA',
        destination,
        amount: toBaseUnits(amount, 9),
      };
    }
    return {
      chain: 'SOLANA',
      destination,
      amount: toBaseUnits(amount, 6),
      mint: SOLANA_USDC_MINT[input.network],
    };
  }

  if (input.assetKind === 'NATIVE') {
    return {
      chain: 'POLYGON',
      destination,
      amount: toBaseUnits(amount, 18),
    };
  }
  return {
    chain: 'POLYGON',
    destination,
    amount: toBaseUnits(amount, 6),
    mint: POLYGON_USDC_CONTRACT[input.network],
  };
}

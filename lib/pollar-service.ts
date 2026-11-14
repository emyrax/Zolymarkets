/**
 * Pollar Server API v3 Client Service (Zero-VPS Multichain Layer)
 *
 * Executes authenticated server-to-server calls against https://server.api.pollar.xyz
 * using `POLLAR_SECRET_KEY` via the `x-pollar-api-key` header. Secret keys remain
 * strictly on the backend and are never exposed to client bundles.
 */

export type PollarServiceErrorCode =
  | 'POLLAR_SECRET_MISSING'
  | 'INVALID_INPUT'
  | 'POLLAR_API_ERROR';

export class PollarServiceError extends Error {
  readonly code: PollarServiceErrorCode;
  readonly statusCode: number;

  constructor(
    code: PollarServiceErrorCode,
    message: string,
    statusCode = 502
  ) {
    super(message);
    this.name = 'PollarServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface PollarIntegrationStatus {
  publishableKeyConfigured: boolean;
  secretKeyConfigured: boolean;
  network: 'testnet' | 'mainnet';
  serverApiUrl: string;
  sdkVersion: string;
  supportedChains: ('STELLAR' | 'SOLANA' | 'POLYGON')[];
}

function getServerApiUrl(): string {
  const configured = process.env.POLLAR_API_URL?.trim();
  return (configured || 'https://server.api.pollar.xyz').replace(/\/+$/, '');
}

function getSecretKey(): string {
  const key = process.env.POLLAR_SECRET_KEY?.trim() || '';
  if (!key) {
    throw new PollarServiceError(
      'POLLAR_SECRET_MISSING',
      'POLLAR_SECRET_KEY is not configured on the server. Add your sec_testnet_... or sec_live_... key from dashboard.pollar.xyz to your environment secrets.',
      503
    );
  }
  return key;
}

export function getPollarIntegrationStatus(): PollarIntegrationStatus {
  const publishable = process.env.VITE_POLLAR_PUBLISHABLE_KEY?.trim() || '';
  const secret = process.env.POLLAR_SECRET_KEY?.trim() || '';
  const rawNetwork = process.env.VITE_POLLAR_STELLAR_NETWORK?.trim().toLowerCase();

  return {
    publishableKeyConfigured:
      publishable.length > 0 && !publishable.startsWith('MY_'),
    secretKeyConfigured: secret.length > 0 && !secret.startsWith('MY_'),
    network: rawNetwork === 'mainnet' ? 'mainnet' : 'testnet',
    serverApiUrl: getServerApiUrl(),
    sdkVersion: '0.12.0',
    supportedChains: ['STELLAR', 'SOLANA', 'POLYGON'],
  };
}

async function callPollarServerApi<T = unknown>(
  endpointPath: string,
  options: {
    method?: 'GET' | 'POST';
    externalUserId?: string;
    body?: Record<string, unknown>;
  } = {}
): Promise<T> {
  const secretKey = getSecretKey();
  const baseUrl = getServerApiUrl();
  const method = options.method ?? 'GET';

  const headers: Record<string, string> = {
    'x-pollar-api-key': secretKey,
    Accept: 'application/json',
  };

  if (options.externalUserId) {
    headers['x-pollar-external-user-id'] = options.externalUserId;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${endpointPath}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    throw new PollarServiceError(
      'POLLAR_API_ERROR',
      err instanceof Error
        ? `Unable to reach Pollar Server API: ${err.message}`
        : 'Unable to reach Pollar Server API.',
      502
    );
  }

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { raw: rawText };
    }
  }

  if (!response.ok) {
    const errRecord =
      parsed && typeof parsed === 'object'
        ? (parsed as { message?: string; error?: string; code?: string })
        : {};
    const msg =
      errRecord.message ||
      errRecord.error ||
      `Pollar Server API returned HTTP ${response.status}.`;
    throw new PollarServiceError('POLLAR_API_ERROR', msg, response.status);
  }

  return parsed as T;
}

export async function provisionPollarUserWithWallet(input: {
  externalUserId: string;
  email?: string;
  name?: string;
}): Promise<unknown> {
  const cleanExternalId = input.externalUserId.trim();
  if (!cleanExternalId || cleanExternalId.length > 128) {
    throw new PollarServiceError(
      'INVALID_INPUT',
      'externalUserId is required and must be at most 128 characters.',
      400
    );
  }

  const payload: Record<string, unknown> = {
    externalUserId: cleanExternalId,
  };
  if (input.email?.trim()) {
    payload.email = input.email.trim();
  }
  if (input.name?.trim()) {
    payload.name = input.name.trim();
  }

  return callPollarServerApi('/v3/users/with-wallet', {
    method: 'POST',
    externalUserId: cleanExternalId,
    body: payload,
  });
}

export async function getPollarUserWallets(externalUserId: string): Promise<unknown> {
  const cleanId = externalUserId.trim();
  if (!cleanId) {
    throw new PollarServiceError('INVALID_INPUT', 'externalUserId is required.', 400);
  }
  return callPollarServerApi('/v3/wallets', {
    method: 'GET',
    externalUserId: cleanId,
  });
}

export async function getPollarUserRampOrders(externalUserId: string): Promise<unknown> {
  const cleanId = externalUserId.trim();
  if (!cleanId) {
    throw new PollarServiceError('INVALID_INPUT', 'externalUserId is required.', 400);
  }
  return callPollarServerApi('/v3/ramps/orders', {
    method: 'GET',
    externalUserId: cleanId,
  });
}

export async function getPollarUserTxHistory(
  externalUserId: string,
  chain?: string
): Promise<unknown> {
  const cleanId = externalUserId.trim();
  if (!cleanId) {
    throw new PollarServiceError('INVALID_INPUT', 'externalUserId is required.', 400);
  }
  const query = chain ? `?chain=${encodeURIComponent(chain)}` : '';
  return callPollarServerApi(`/v3/tx/history${query}`, {
    method: 'GET',
    externalUserId: cleanId,
  });
}

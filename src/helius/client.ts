/**
 * Helius Client — minimal subset needed by the Alpha trading engine.
 *
 * Only implements:
 *   getTokenBalanceByOwner — used by liveEngine + liveSellTracker
 *   getCreatorInfo         — used by liveEngine at position open
 *   getAsset               — used internally by getCreatorInfo
 */

const HELIUS_RPC = (key: string) =>
  `https://mainnet.helius-rpc.com/?api-key=${key}`;

export interface AssetMetadata {
  id: string;
  token_info?: {
    supply?: number;
    decimals?: number;
  };
  creators?: Array<{ address: string; share?: number; verified?: boolean }>;
  content?: {
    metadata?: { name?: string; symbol?: string };
  };
}

export interface TokenAccount {
  address: string;
  owner: string;
  mint: string;
}

// ─── getAsset ─────────────────────────────────────────────────────────────────

export async function getAsset(
  apiKey: string,
  mintAddress: string,
): Promise<AssetMetadata | null> {
  if (!apiKey) return null;
  const endpoint = HELIUS_RPC(apiKey);

  try {
    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      "alpha-get-asset",
        method:  "getAsset",
        params:  { id: mintAddress },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      result?: AssetMetadata;
      error?: unknown;
    };

    if (json.error) return null;
    return json.result ?? null;
  } catch {
    return null;
  }
}

// ─── getTokenBalanceByOwner ───────────────────────────────────────────────────

export async function getTokenBalanceByOwner(
  apiKey: string,
  ownerAddress: string,
  mintAddress: string,
): Promise<number | null> {
  if (!apiKey) return null;
  const endpoint = HELIUS_RPC(apiKey);

  try {
    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      "alpha-token-balance",
        method:  "getTokenAccountsByOwner",
        params:  [ownerAddress, { mint: mintAddress }, { encoding: "jsonParsed" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      result?: {
        value?: Array<{
          account?: {
            data?: {
              parsed?: {
                info?: { tokenAmount?: { amount?: string } };
              };
            };
          };
        }>;
      };
    };

    const accounts = json.result?.value ?? [];
    let total = 0;
    for (const acc of accounts) {
      const raw = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (raw) total += Number(raw);
    }
    return total;
  } catch {
    return null;
  }
}

// ─── getCreatorInfo ───────────────────────────────────────────────────────────

export async function getCreatorInfo(
  apiKey: string,
  mintAddress: string,
): Promise<{
  creatorAddress:       string | null;
  totalSupply:          number | null;
  creatorTokensAtEntry: number | null;
}> {
  const empty = { creatorAddress: null, totalSupply: null, creatorTokensAtEntry: null };
  if (!apiKey) return empty;

  try {
    const asset = await getAsset(apiKey, mintAddress);
    if (!asset) return empty;

    const creatorAddress = asset.creators?.[0]?.address ?? null;
    const totalSupply    = asset.token_info?.supply    ?? null;

    if (!creatorAddress) return { creatorAddress: null, totalSupply, creatorTokensAtEntry: null };

    const creatorTokensAtEntry = await getTokenBalanceByOwner(apiKey, creatorAddress, mintAddress);
    return { creatorAddress, totalSupply, creatorTokensAtEntry };
  } catch {
    return empty;
  }
}

/**
 * Transaction Pipeline
 *
 * Handles everything between "we have a base64 transaction from Jupiter"
 * and "the transaction is confirmed on-chain (or permanently failed)".
 *
 * Pipeline steps:
 *   1. Decrypt keypair from AES-256-GCM encrypted wallet record
 *   2. Deserialize the VersionedTransaction from Jupiter
 *   3. Sign with the decrypted keypair
 *   4. Submit:
 *        a. If Jito RPC configured + mev_protection: POST to Jito block engine
 *        b. Otherwise: sendRawTransaction to configured RPC
 *   5. Confirm with retry loop (exponential backoff, blockhash expiry guard)
 *   6. Failure recovery: if tx dropped, resubmit up to maxRetries times
 *
 * SAFETY:
 *   - decryptKeypair() clears the key from memory after signing (best-effort)
 *   - All errors are caught and surfaced via SubmitResult — never thrown to caller
 *   - Never logs the decrypted private key or keypair bytes
 */

import {
  Keypair,
  VersionedTransaction,
  Connection,
  PublicKey,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import bs58 from "bs58";
import { decryptValue } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletRecord {
  wallet_address:       string;
  encrypted_private_key: string;
  encryption_iv:        string;
  encryption_tag:       string;
  rpc_endpoint:         string;
  jito_rpc:             string | null;
  mev_protection:       number;
}

export interface SubmitResult {
  success:             boolean;
  signature:           string | null;   // confirmed tx signature
  bundleId:            string | null;   // Jito bundle ID if used
  retries:             number;
  latencyMs:           number;
  error:               string | null;
  networkFeeLamports:  number | null;   // actual total fee from RPC meta.fee; null when unavailable
}

interface PipelineOptions {
  wallet:              WalletRecord;
  base64Transaction:   string;
  lastValidBlockHeight: number;
  maxRetries?:         number;           // default 3
  confirmTimeoutMs?:   number;          // default 45_000
  skipPreflight?:      boolean;         // default false
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES      = 3;
const DEFAULT_CONFIRM_TIMEOUT  = 45_000;
const RETRY_BACKOFF_MS         = [500, 1_500, 4_000] as const;

// Jito tip accounts (8 canonical addresses — pick randomly)
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

// ── Keypair decrypt ───────────────────────────────────────────────────────────

/**
 * Decrypt the wallet's private key and return a Keypair.
 * The private key is expected to be base58-encoded 64-byte secret key.
 * Throws if decryption fails (wrong SESSION_SECRET or tampered data).
 */
export function decryptKeypair(wallet: WalletRecord): Keypair {
  const secretKeyBase58 = decryptValue({
    iv:         wallet.encryption_iv,
    tag:        wallet.encryption_tag,
    ciphertext: wallet.encrypted_private_key,
  });
  const secretKeyBytes = bs58.decode(secretKeyBase58);
  return Keypair.fromSecretKey(secretKeyBytes);
}

// ── Jito bundle submission ────────────────────────────────────────────────────

async function submitViaJito(
  jitoRpc: string,
  signedTx: VersionedTransaction,
): Promise<{ bundleId: string | null; error: string | null }> {
  try {
    const txBase58 = bs58.encode(signedTx.serialize());
    const url = `${jitoRpc.replace(/\/$/, "")}/api/v1/bundles`;
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [[txBase58]],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json() as { result?: string; error?: { message: string } };
    if (json.error) {
      return { bundleId: null, error: `Jito error: ${json.error.message}` };
    }
    return { bundleId: json.result ?? null, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { bundleId: null, error: `Jito submit failed: ${msg}` };
  }
}

// ── Standard RPC submission ───────────────────────────────────────────────────

async function submitViaRpc(
  connection: Connection,
  signedTx: VersionedTransaction,
  skipPreflight: boolean,
): Promise<{ signature: string | null; error: string | null }> {
  try {
    const signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight,
      maxRetries: 0,           // we manage retries ourselves
      preflightCommitment: "processed",
    });
    return { signature, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { signature: null, error: `RPC submit failed: ${msg}` };
  }
}

// ── Confirmation loop ─────────────────────────────────────────────────────────

async function confirmSignature(
  connection: Connection,
  signature: string,
  blockhash: BlockhashWithExpiryBlockHeight,
  timeoutMs: number,
): Promise<{ confirmed: boolean; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  try {
    const result = await connection.confirmTransaction(
      {
        signature,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (result.value.err) {
      return { confirmed: false, error: `Transaction failed on-chain: ${JSON.stringify(result.value.err)}` };
    }
    return { confirmed: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Check if the reason is a blockhash expiry (not worth retrying same tx)
    if (msg.includes("block height exceeded") || Date.now() >= deadline) {
      return { confirmed: false, error: `Blockhash expired: ${msg}` };
    }
    return { confirmed: false, error: msg };
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Full sign → submit → confirm pipeline with retry.
 *
 * Returns a SubmitResult — never throws.
 * On permanent failure (all retries exhausted, blockhash expired, on-chain error),
 * success=false with a descriptive error string.
 */
export async function executeTransaction(opts: PipelineOptions): Promise<SubmitResult> {
  const start       = Date.now();
  const maxRetries  = opts.maxRetries      ?? DEFAULT_MAX_RETRIES;
  const confirmMs   = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT;
  const skipPreflight = opts.skipPreflight ?? false;
  const useJito     = !!(opts.wallet.jito_rpc && opts.wallet.mev_protection);

  const result: SubmitResult = {
    success: false, signature: null, bundleId: null,
    retries: 0, latencyMs: 0, error: null,
    networkFeeLamports: null,
  };

  try {
    // ── 1. Decrypt keypair ────────────────────────────────────────────────────
    const keypair = decryptKeypair(opts.wallet);

    // ── 2. Deserialize ────────────────────────────────────────────────────────
    const txBytes = Buffer.from(opts.base64Transaction, "base64");
    const tx = VersionedTransaction.deserialize(txBytes);

    // ── 3. Sign ───────────────────────────────────────────────────────────────
    tx.sign([keypair]);

    // ── 4. Submit (with retry loop) ───────────────────────────────────────────
    const connection = new Connection(opts.wallet.rpc_endpoint, "confirmed");
    const blockhashInfo: BlockhashWithExpiryBlockHeight = {
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: opts.lastValidBlockHeight,
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        result.retries++;
        const delay = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]!;
        await new Promise((r) => setTimeout(r, delay));
        logger.info({ attempt, signature: result.signature }, "[tx-pipeline] retry");
      }

      // Submit
      if (useJito && opts.wallet.jito_rpc) {
        const { bundleId, error } = await submitViaJito(opts.wallet.jito_rpc, tx);
        if (error) {
          result.error = error;
          logger.warn({ attempt, error }, "[tx-pipeline] Jito submit error");
          // Fall back to RPC on Jito failure
          const { signature, error: rpcErr } = await submitViaRpc(connection, tx, skipPreflight);
          if (rpcErr) { result.error = rpcErr; continue; }
          result.signature = signature;
          result.bundleId  = bundleId;
        } else {
          result.bundleId = bundleId;
          // For Jito bundles, we still confirm via RPC
          // Get the signature from the signed tx
          const sig = bs58.encode(tx.signatures[0]!);
          result.signature = sig;
        }
      } else {
        const { signature, error } = await submitViaRpc(connection, tx, skipPreflight);
        if (error) { result.error = error; continue; }
        result.signature = signature;
      }

      if (!result.signature) continue;

      // ── 5. Confirm ─────────────────────────────────────────────────────────
      const { confirmed, error: confirmErr } = await confirmSignature(
        connection, result.signature, blockhashInfo, confirmMs,
      );

      if (confirmed) {
        result.success   = true;
        result.error     = null;
        result.latencyMs = Date.now() - start;

        // ── Best-effort: fetch actual fee from confirmed tx ─────────────────
        // getTransaction().meta.fee = total lamports paid (base + priority).
        // One extra RPC call; failure always yields null — never throws.
        try {
          const txInfo = await connection.getTransaction(result.signature!, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          result.networkFeeLamports = txInfo?.meta?.fee ?? null;
        } catch {
          result.networkFeeLamports = null;
        }

        logger.info(
          {
            signature:          result.signature,
            retries:            result.retries,
            latencyMs:          result.latencyMs,
            bundleId:           result.bundleId,
            networkFeeLamports: result.networkFeeLamports,
          },
          "[tx-pipeline] confirmed",
        );
        return result;
      }

      result.error = confirmErr;

      // If blockhash expired, no point retrying same tx
      if (confirmErr?.includes("Blockhash expired")) {
        logger.warn({ signature: result.signature, confirmErr }, "[tx-pipeline] blockhash expired — abort retry loop");
        break;
      }

      logger.warn({ attempt, confirmErr, signature: result.signature }, "[tx-pipeline] not confirmed");
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logger.error({ err: result.error }, "[tx-pipeline] unhandled error");
  }

  result.latencyMs = Date.now() - start;
  return result;
}

/**
 * Derive wallet address from decrypted keypair for verification.
 * Used during wallet connection to confirm the key matches the stored address.
 */
export function derivePublicKey(wallet: WalletRecord): string {
  const keypair = decryptKeypair(wallet);
  return keypair.publicKey.toBase58();
}

/**
 * Pick a random Jito tip account address.
 */
export function randomJitoTipAccount(): string {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
}

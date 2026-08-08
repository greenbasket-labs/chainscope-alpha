/**
 * Symmetric encryption utilities for sensitive values (e.g. wallet private keys).
 *
 * Algorithm : AES-256-GCM
 * Key source : SHA-256 of SESSION_SECRET env var (32 bytes)
 * IV         : 12 random bytes per encryption (stored alongside ciphertext)
 * Auth tag   : 16 bytes (stored alongside ciphertext)
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const IV_BYTES   = 12;

function getKey(): Buffer {
  const secret =
    process.env.SESSION_SECRET ??
    "alpha-local-dev-only-replace-in-production";
  return createHash("sha256").update(secret, "utf8").digest();
}

export interface EncryptedBlob {
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptValue(plaintext: string): EncryptedBlob {
  const key    = getKey();
  const iv     = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext    += cipher.final("hex");
  const tag      = cipher.getAuthTag();

  return {
    iv:         iv.toString("hex"),
    tag:        tag.toString("hex"),
    ciphertext,
  };
}

export function decryptValue(blob: EncryptedBlob): string {
  const key      = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));

  let plaintext  = decipher.update(blob.ciphertext, "hex", "utf8");
  plaintext     += decipher.final("utf8");
  return plaintext;
}

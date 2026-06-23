/**
 * PKCE (RFC 7636) helpers, S256 only.
 *
 * Uses Node's native crypto so there is no runtime dependency and it works in
 * an air-gapped environment.
 */
import { createHash, randomBytes } from "node:crypto";

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Base64url encode without padding (RFC 4648 §5). */
export function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a PKCE verifier/challenge pair.
 *
 * The verifier is 32 random bytes base64url-encoded (43 chars), comfortably
 * within the RFC's 43–128 character range. The challenge is the S256 hash.
 */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Cryptographically random URL-safe string, used for the OAuth `state` param. */
export function randomState(bytes = 24): string {
  return base64url(randomBytes(bytes));
}

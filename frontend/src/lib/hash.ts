/**
 * Browser-compatible port of backend/src/shared/hash.ts
 * -------------------------------------------------------
 * This MUST produce byte-identical output to the Node.js
 * backend version. Any divergence will cause the Secure
 * Gateway Listener to flag hash-lock mismatches.
 *
 * Algorithm:
 *   1. Canonicalize JSON via stableStringify (sorted keys)
 *   2. SHA-256 hash the canonical string
 */

/**
 * Produces a deterministic JSON string by sorting object keys
 * alphabetically at every nesting level. This is the exact
 * same logic as backend/src/shared/hash.ts — do NOT modify
 * without coordinating with the backend team.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`
  );
  return `{${entries.join(",")}}`;
}

/**
 * Generates a SHA-256 hash of the canonicalized JSON payload.
 * Returns a Uint8Array of 32 bytes (suitable for Array.from()
 * before passing to the Anchor instruction).
 */
export async function generateSha256Hash(data: object): Promise<Uint8Array> {
  const canonical = stableStringify(data);
  const encoded = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(hashBuffer);
}

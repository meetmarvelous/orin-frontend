import { createHash } from "crypto";

/**
 * Shared hashing utilities
 * -------------------------------------------------------------
 * These functions define the canonical serialization + hash logic
 * used by both AI generation and gateway verification paths.
 * Any change here is protocol-sensitive and must be coordinated.
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
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}

export function generateSha256Hash(data: object): Buffer {
  return createHash("sha256").update(stableStringify(data)).digest();
}

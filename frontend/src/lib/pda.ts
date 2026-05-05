/**
 * PDA (Program Derived Address) derivation utilities
 * ---------------------------------------------------
 * Mirrors the seed logic defined in the Anchor smart contract:
 *   seeds = [b"guest", email_hash.as_ref()]
 *
 * Reference: programs/orin_identity/src/lib.rs (line 65)
 * Reference: docs/INTEGRATION_SPEC.md (Section 1)
 */

import { PublicKey } from "@solana/web3.js";
import { sha256 } from "js-sha256";

/** Deployed ORIN Program ID on Solana Devnet */
export const ORIN_PROGRAM_ID = new PublicKey(
  "FqtrHgdYTph1DSP9jDYD7xrKPrjSjCTtnw6fyKMmboYk"
);

/**
 * Derives the unique Guest Identity PDA from a raw identifier string and user wallet.
 * Security Update: Seed scheme [b"guest", identifier_hash, user.key()]
 *
 * @param identifier - Guest's raw identifier string (e.g. name or email)
 * @param userPubkey - The Guest's connected Phantom wallet public key
 * @returns Guest PDA PublicKey and the identifier hash buffer
 */
export function deriveGuestPda(identifier: string, userPubkey: PublicKey): {
  pda: PublicKey;
  identifierHash: Uint8Array;
} {
  const normalizedIdentifier = identifier.toLowerCase().trim();
  const identifierHashArray = sha256.array(normalizedIdentifier);
  const identifierHash = new Uint8Array(identifierHashArray);

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("guest"), Buffer.from(identifierHash), userPubkey.toBuffer()],
    ORIN_PROGRAM_ID
  );

  return { pda, identifierHash };
}

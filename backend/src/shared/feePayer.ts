import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getEnv } from "../config/env";
import { logger } from "./logger";

/**
 * ORIN Gas Relayer — FeePayer Module
 * -------------------------------------------------------------
 * Loads the server-side fee-payer keypair from a base58-encoded
 * private key stored in the environment, then co-signs serialized
 * guest transactions so the guest pays ZERO on-chain fees.
 *
 * Security contract:
 *  - The private key never leaves the backend process memory.
 *  - No endpoint exposes the keypair or seeds.
 *  - The fee-payer signs ONLY fully-formed transactions submitted
 *    by authenticated frontend clients (X-API-KEY guarded route).
 *  - The transaction instruction logic is enforced by the Anchor
 *    program's `has_one = owner` constraint — the server can pay
 *    but cannot alter or forge an instruction on a guest's behalf.
 */

let _feePayerKeypair: Keypair | null = null;

/**
 * Returns a singleton Keypair loaded from FEE_PAYER_PRIVATE_KEY.
 * Throws at startup if the key is missing or malformed, so the
 * process fails fast rather than silently at request time.
 */
export function getFeePayerKeypair(): Keypair {
  if (_feePayerKeypair) return _feePayerKeypair;

  const env = getEnv();
  const raw = env.FEE_PAYER_PRIVATE_KEY;

  try {
    const secret = bs58.decode(raw);
    _feePayerKeypair = Keypair.fromSecretKey(secret);
    logger.info(
      { fee_payer_pubkey: _feePayerKeypair.publicKey.toBase58() },
      "fee_payer_loaded"
    );
    return _feePayerKeypair;
  } catch (err) {
    throw new Error(
      "FEE_PAYER_PRIVATE_KEY is invalid. Must be a base58-encoded 64-byte secret key."
    );
  }
}

export interface RelayResult {
  signature: string;
  feePayerPubkey: string;
}

/**
 * Co-signs and broadcasts a partially-signed legacy Transaction.
 *
 * Flow:
 *   1. Frontend builds the transaction with feePayer = server pubkey.
 *   2. Guest wallet signs (authorizing the instruction).
 *   3. Frontend serialises the tx and POSTs it here.
 *   4. Server deserialises, validates, co-signs, and sends.
 *
 * @param connection - An active Solana Connection
 * @param serializedTx - Base64-encoded serialized Transaction bytes
 *                       from the frontend (partially signed by guest)
 */
export async function relayTransaction(
  connection: Connection,
  serializedTx: string
): Promise<RelayResult> {
  const feePayerKeypair = getFeePayerKeypair();

  // Decode the base64 transaction sent from the frontend
  const txBytes = Buffer.from(serializedTx, "base64");

  // Attempt to deserialize; support both legacy and versioned formats
  let tx: Transaction | VersionedTransaction;
  let isVersioned = false;

  try {
    // Versioned transactions (v0) start with a version prefix byte
    tx = VersionedTransaction.deserialize(txBytes);
    isVersioned = true;
  } catch {
    tx = Transaction.from(txBytes);
  }

  if (isVersioned) {
    // Versioned tx: fee payer must be pre-set in the message; we just co-sign
    const vtx = tx as VersionedTransaction;
    vtx.sign([feePayerKeypair]);
    const rawTx = vtx.serialize();
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(sig, "confirmed");
    return { signature: sig, feePayerPubkey: feePayerKeypair.publicKey.toBase58() };
  } else {
    // Legacy tx: ensure the fee payer key is set to our server wallet
    const ltx = tx as Transaction;

    if (!ltx.feePayer) {
      ltx.feePayer = feePayerKeypair.publicKey;
    }

    // Validate that the frontend intended OUR server as the fee payer
    if (!ltx.feePayer.equals(feePayerKeypair.publicKey)) {
      throw new Error(
        `Transaction feePayer mismatch. ` +
        `Expected ${feePayerKeypair.publicKey.toBase58()}, ` +
        `got ${ltx.feePayer.toBase58()}`
      );
    }

    // Require a recent blockhash — guards against replay attacks
    if (!ltx.recentBlockhash) {
      throw new Error("Transaction is missing recentBlockhash. Cannot relay.");
    }

    // Co-sign with the server fee-payer key
    ltx.partialSign(feePayerKeypair);

    // Verify all required signatures are present before broadcasting
    const verified = ltx.verifySignatures(false);
    if (!verified) {
      throw new Error(
        "Transaction signature verification failed. Ensure the guest wallet signed before submitting."
      );
    }

    const rawTx = ltx.serialize();
    const sig = await sendAndConfirmRawTransaction(connection, rawTx, {
      commitment: "confirmed",
    });

    return { signature: sig, feePayerPubkey: feePayerKeypair.publicKey.toBase58() };
  }
}

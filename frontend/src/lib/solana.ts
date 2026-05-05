/**
 * Solana program interaction utilities
 * ---------------------------------------------------
 * Handles all direct interactions with the ORIN Anchor
 * smart contract on Solana Devnet.
 *
 * Uses the same IDL and instruction patterns as:
 *   - backend/src/simulate_frontend.ts
 *   - tests/orin_identity.ts
 */

import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  ConnectionConfig,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { ORIN_PROGRAM_ID } from "./pda";

type ProviderWalletLike = {
  signTransaction?: (tx: any) => Promise<any>;
  signAllTransactions?: (txs: any[]) => Promise<any[]>;
};

/** Solana RPC endpoint (required) */
const RPC_ENDPOINT = process.env.NEXT_PUBLIC_RPC_ENDPOINT;
if (!RPC_ENDPOINT) {
  console.error("FATAL: NEXT_PUBLIC_RPC_ENDPOINT is missing. Transaction flows will fail.");
}
const RPC_WS_ENDPOINT = process.env.NEXT_PUBLIC_RPC_WS_ENDPOINT;
let sharedConnection: Connection | null = null;

/**
 * Creates a Solana Connection instance for Devnet.
 */
export function getConnection(): Connection {
  if (!RPC_ENDPOINT) {
    throw new Error("Missing RPC Endpoint");
  }
  if (!sharedConnection) {
    const config: ConnectionConfig = {
      commitment: "confirmed",
      ...(RPC_WS_ENDPOINT ? { wsEndpoint: RPC_WS_ENDPOINT } : {}),
    };
    sharedConnection = new Connection(RPC_ENDPOINT, config);
  }
  return sharedConnection;
}

/**
 * Loads an AnchorProvider from the given wallet adapter.
 * This is typically called with the connected wallet from
 * @solana/wallet-adapter-react's useAnchorWallet().
 */
export function getProvider(wallet: any): AnchorProvider {
  const connection = getConnection();
  return new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
}

/**
 * Loads the ORIN Anchor program instance.
 * The IDL is imported statically from the build artifacts.
 *
 * @param provider - An AnchorProvider with a connected wallet
 * @param idl - The ORIN program IDL (loaded from target/idl/orin_identity.json)
 */
export function getProgram(provider: AnchorProvider, idl: Idl): Program {
  return new Program(idl, provider);
}

/**
 * Signs a transaction using whichever signing interface the injected wallet supports.
 * Some Privy/wallet-adapter bridges expose `signAllTransactions` but not `signTransaction`.
 */
async function signTxWithProviderWallet(program: Program, tx: any): Promise<any> {
  try {
    const wallet = (program.provider as any)?.wallet as ProviderWalletLike | undefined;
    if (!wallet) {
      throw new Error("Wallet signer not available on Anchor provider.");
    }

    if (typeof wallet.signTransaction === "function") {
      return await wallet.signTransaction(tx);
    }

    if (typeof wallet.signAllTransactions === "function") {
      const signed = await wallet.signAllTransactions([tx]);
      if (!signed?.[0]) {
        throw new Error("Wallet returned no signed transaction.");
      }
      return signed[0];
    }

    throw new Error(
      "Connected wallet does not support transaction signing (signTransaction/signAllTransactions)."
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ORIN] Signing failed gracefully:", message);
    throw new Error(`Signing failed: ${message}`);
  }
}

/**
 * Step C: Writes the preferences hash on-chain.
 * Calls the Anchor `updatePreferences` instruction with a 32-byte hash.
 *
 * This is the final step of the Hash-Lock workflow:
 *   Step A (API) → Step B (hash) → Step C (this function)
 *
 * @param program - The loaded ORIN Anchor program
 * @param guestPda - The guest's PDA (derived from their email)
 * @param ownerPubkey - The connected wallet's public key (must be the PDA owner)
 * @param preferencesHash - 32-byte SHA-256 hash as Uint8Array
 * @param opts.feePayerPubkey - If provided, uses Gas Relay mode: the guest
 *   partial-signs and the backend fee-payer co-signs + broadcasts. Guest pays zero gas.
 * @param opts.relayFn - The `relayTransaction` function from api.ts, injected
 *   to avoid circular imports and enable testing.
 * @returns Transaction signature string
 */
export async function updatePreferencesOnChain(
  program: Program,
  guestPda: PublicKey,
  ownerPubkey: PublicKey,
  preferencesHash: Uint8Array,
  identifierHash: Uint8Array,
  guestName: string,
  opts?: {
    feePayerPubkey?: PublicKey;
    relayFn?: (serializedTx: string) => Promise<{ signature: string }>;
  }
): Promise<string> {
  const connection = program.provider.connection;
  const useRelay = !!(opts?.feePayerPubkey && opts?.relayFn);

  // ── Lazy Init check: does the PDA exist on-chain? ──────────────
  const accountInfo = await connection.getAccountInfo(guestPda);
  const needsInit = accountInfo === null;

  if (!useRelay) {
    // ── Direct-pay mode (guest pays gas themselves) ──────────────
    if (!needsInit) {
      // Account exists — simple single-instruction RPC
      const tx = await (program.methods as any)
        .updatePreferences(Array.from(preferencesHash))
        .accounts({ guestProfile: guestPda, owner: ownerPubkey } as any)
        .rpc();
      return tx;
    }

    // Account missing — build atomic init + update transaction
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const { Transaction } = await import("@solana/web3.js");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: ownerPubkey });

    const initIx = await (program.methods as any)
      .initializeGuest(Array.from(identifierHash), guestName)
      .accounts({
        guestProfile: guestPda,
        user: ownerPubkey,
        feePayer: ownerPubkey,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    tx.add(initIx);

    const updateIx = await (program.methods as any)
      .updatePreferences(Array.from(preferencesHash))
      .accounts({ guestProfile: guestPda, owner: ownerPubkey } as any)
      .instruction();
    tx.add(updateIx);

    const signedTx = await signTxWithProviderWallet(program, tx);
    const sig = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  // ── Gas Relay mode (ORIN pays gas on behalf of the guest) ────
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const { Transaction } = await import("@solana/web3.js");
  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: opts!.feePayerPubkey,  // server is the fee payer
  });

  // Lazy Init: prepend initializeGuest if needed
  if (needsInit) {
    const initIx = await (program.methods as any)
      .initializeGuest(Array.from(identifierHash), guestName)
      .accounts({
        guestProfile: guestPda,
        user: ownerPubkey,
        feePayer: opts!.feePayerPubkey,   // Server covers rent
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    tx.add(initIx);
  }

  const updateIx = await (program.methods as any)
    .updatePreferences(Array.from(preferencesHash))
    .accounts({ guestProfile: guestPda, owner: ownerPubkey } as any)
    .instruction();
  tx.add(updateIx);

  // Guest wallet partial-signs — authorizes the instruction; fee-payer sig is missing
  const signedTx = await signTxWithProviderWallet(program, tx);

  // Serialize without requiring all sigs (fee-payer sig will be added by server)
  const serialized = signedTx.serialize({ requireAllSignatures: false }).toString("base64");

  // Server co-signs + broadcasts, returns tx signature
  const relayResult = await opts!.relayFn!(serialized);
  return relayResult.signature;
}


/**
 * Initializes a new guest identity PDA on-chain.
 * Typically called once during first-time onboarding.
 *
 * @param program - The loaded ORIN Anchor program
 * @param guestPda - The derived guest PDA
 * @param userPubkey - The wallet paying for account creation
 * @param emailHash - 32-byte SHA-256 hash of the guest's email
 * @param name - Guest's display name (max 100 chars)
 * @returns Transaction signature string
 */
/**
 * @param opts.feePayerPubkey - If provided, Gas Relay mode: guest partial-signs,
 *   server co-signs + broadcasts. Guest pays ZERO gas.
 * @param opts.relayFn - Injected relayTransaction function from api.ts.
 */
export async function initializeGuestOnChain(
  program: Program,
  guestPda: PublicKey,
  userPubkey: PublicKey,
  emailHash: Uint8Array,
  name: string,
  opts?: {
    feePayerPubkey?: PublicKey;
    relayFn?: (serializedTx: string) => Promise<{ signature: string }>;
  }
): Promise<string> {
  const useRelay = !!(opts?.feePayerPubkey && opts?.relayFn);

  if (!useRelay) {
    // ── Direct-pay mode: user pays both gas AND rent ──────────────
    const tx = await (program.methods as any)
      .initializeGuest(Array.from(emailHash), name)
      .accounts({
        guestProfile: guestPda,
        user: userPubkey,
        feePayer: userPubkey,      // same wallet covers rent in direct mode
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    return tx;
  }

  // ── Gas Relay mode ───────────────────────────────────────────
  const connection = program.provider.connection;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const instruction = await (program.methods as any)
    .initializeGuest(Array.from(emailHash), name)
    .accounts({
      guestProfile: guestPda,
      user: userPubkey,
      feePayer: opts!.feePayerPubkey, // server wallet covers rent
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();

  const { Transaction } = await import("@solana/web3.js");
  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: opts!.feePayerPubkey,  // server subsidizes the gas
  });
  tx.add(instruction);

  // Guest wallet partial-signs — authorizes the instruction only
  const signedTx = await signTxWithProviderWallet(program, tx);

  // Serialize without requiring fee-payer signature (server will add it)
  const serialized = signedTx.serialize({ requireAllSignatures: false }).toString("base64");

  const relayResult = await opts!.relayFn!(serialized);
  return relayResult.signature;
}

/**
 * Fetches the on-chain GuestIdentity account data.
 *
 * @param program - The loaded ORIN Anchor program
 * @param guestPda - The guest's PDA
 * @returns Decoded account data or null if account doesn't exist
 */
export async function fetchGuestProfile(
  program: Program,
  guestPda: PublicKey
): Promise<any | null> {
  try {
    const account = await (program.account as any).guestIdentity.fetch(
      guestPda
    );
    return account;
  } catch {
    return null;
  }
}

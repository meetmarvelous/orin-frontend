/**
 * Solana Infrastructure Provider
 * ---------------------------------------------------
 * Provides Solana Connection context and wallet adapter bridge.
 * 
 * NOTE: Wallet UI is handled ENTIRELY by Privy.
 * This provider only supplies:
 *   1. ConnectionProvider — RPC endpoint for Anchor operations
 *   2. WalletProvider — wallet state bridge (Privy ↔ Anchor)
 * 
 * The old WalletModalProvider is removed — Privy's modal replaces it.
 */

"use client";

import React, { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";

interface Props {
  children: React.ReactNode;
}

export default function SolanaWalletProvider({ children }: Props) {
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_RPC_ENDPOINT || "", []);
  if (!endpoint) {
    throw new Error("Missing NEXT_PUBLIC_RPC_ENDPOINT");
  }

  // Empty array — Privy's toSolanaWalletConnectors handles wallet injection.
  // Privy bridges both external (Phantom/Solflare) and embedded wallets
  // into the standard adapter, so useWallet()/useAnchorWallet() still work.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

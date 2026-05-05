/**
 * Privy Auth Provider — SOLE Authentication Gateway
 * ---------------------------------------------------
 * Privy handles ALL authentication and wallet connections:
 *   - Email login
 *   - X (Twitter) login
 *   - Solana wallet login (Phantom, Solflare, etc.)
 *   - Embedded wallet creation for users without a wallet
 *
 * The old SolanaWalletProvider is kept ONLY for Connection context.
 * All wallet UI goes through Privy's modal.
 */

"use client";

import React from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { defaultSolanaRpcsPlugin, toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

const solanaConnectors = toSolanaWalletConnectors({
  shouldAutoConnect: true,
});

interface Props {
  children: React.ReactNode;
}

export default function PrivyClientProvider({ children }: Props) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) {
    throw new Error("Missing NEXT_PUBLIC_PRIVY_APP_ID");
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#C4A97A",
          logo: undefined,
          walletChainType: "solana-only",
          walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets"],
        },
        loginMethodsAndOrder: {
          primary: ["email", "twitter", "phantom", "solflare"],
          overflow: ["backpack"],
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },
        externalWallets: {
          solana: {
            connectors: solanaConnectors,
          },
        },
        plugins: [defaultSolanaRpcsPlugin()],
      }}
    >
      {children}
    </PrivyProvider>
  );
}

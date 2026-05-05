import type { Metadata } from "next";
import { Cormorant_Garamond, Nunito_Sans } from "next/font/google";
import "./globals.css";
import PrivyClientProvider from "@/providers/PrivyClientProvider";
import SolanaWalletProvider from "@/providers/SolanaWalletProvider";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["600", "700"],
});

const nunito = Nunito_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "600", "700"],
});

export const metadata: Metadata = {
  title: "ORIN · Your AI Concierge",
  description: "ORIN Core: Your personal AI assistant for travel, hospitality, and smart environments. Powered by Solana.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${cormorant.variable} ${nunito.variable} antialiased`}>
        <PrivyClientProvider>
          <SolanaWalletProvider>{children}</SolanaWalletProvider>
        </PrivyClientProvider>
      </body>
    </html>
  );
}

"use client";

// Legacy reference component copied from the original frontend.
// The live frontend2 shell is src/app/page.tsx; do not wire this as an alternate auth/dashboard flow.

import React, { useEffect, useState } from "react";
import { useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { deriveGuestPda } from "@/lib/pda";
import { getConnection, fetchGuestProfile, initializeGuestOnChain } from "@/lib/solana";
import { getRelayOpts } from "@/lib/savePreferences";
import idl from "@idl/orin_identity.json";


interface GuestDashboardProps {
  onEnterRoom: () => void;
}

export default function GuestDashboard({ onEnterRoom }: GuestDashboardProps) {
  const { publicKey, connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  
  // We'll use a mocked email for the dashboard if the user hasn't explicitly set one,
  // or ideally we could just prompt them for it. For now, let's allow a temporary input
  // to fetch the correct PDA.
  const [guestEmail, setGuestEmail] = useState("");
  const [profileData, setProfileData] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [profileNotFound, setProfileNotFound] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Attempt to fetch profile if we have wallet and email
    async function loadProfile() {
      if (!connected || !anchorWallet || !guestEmail) {
        setProfileData(null);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const connection = getConnection();
        const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
        const program = new Program(idl as Idl, provider);
        const { pda } = deriveGuestPda(guestEmail, publicKey!);
        
        const data = await fetchGuestProfile(program, pda);
        if (data === null) {
          setProfileNotFound(true);
        } else {
          setProfileNotFound(false);
        }
        setProfileData(data);
      } catch (err: any) {
        setProfileData(null);
        setProfileNotFound(true);
      } finally {
        setIsLoading(false);
      }
    }

    // Only load if guestEmail is a somewhat valid email to prevent spamming RPC
    if (guestEmail.includes("@")) {
      const timeoutId = setTimeout(() => loadProfile(), 1000);
      return () => clearTimeout(timeoutId);
    }
  }, [publicKey?.toBase58(), connected, guestEmail]);

  const handleInitialize = async () => {
    if (!anchorWallet || !publicKey || !guestEmail) return;
    setIsInitializing(true);
    setError(null);
    try {
      const connection = getConnection();
      const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
      const program = new Program(idl as Idl, provider);
      const { pda, identifierHash } = deriveGuestPda(guestEmail, publicKey!);
      
      await initializeGuestOnChain(
        program,
        pda,
        publicKey,
        identifierHash,
        guestEmail.split("@")[0],
        getRelayOpts()

      );
      
      const data = await fetchGuestProfile(program, pda);
      setProfileData(data);
      setProfileNotFound(false);
    } catch (err: any) {
      setError(err.message || "Failed to initialize guest profile.");
    } finally {
      setIsInitializing(false);
    }
  };

  if (!connected) {
    return (
      <div className="fade-up" style={{ textAlign: "center", paddingTop: 60 }}>
        <div className="section-label" style={{ justifyContent: "center", marginBottom: 24 }}>
          Identity Module
        </div>
        <h1 style={{ fontSize: "clamp(36px, 5vw, 56px)", fontWeight: 300, letterSpacing: -2, lineHeight: 1.1, color: "var(--white)", marginBottom: 12 }}>
          Connect <em style={{ fontStyle: "italic", color: "var(--gold)" }}>wallet</em> to begin.
        </h1>
        <p style={{ fontSize: 18, fontWeight: 300, fontStyle: "italic", color: "var(--text-dim)", marginBottom: 40 }}>
          Your portable hospitality profile awaits.
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", maxWidth: 800, margin: "0 auto" }}>
      {/* ── Email Identity Check ───────────────── */}
      {!profileData && !profileNotFound && (
        <div className="orin-card fade-up" style={{ marginBottom: 40 }}>
          <div className="section-label" style={{ marginBottom: 16 }}>Locate Identity</div>
          <input
            type="email"
            className="orin-input"
            value={guestEmail}
            onChange={(e) => {
              setGuestEmail(e.target.value);
              setProfileNotFound(false);
            }}
            placeholder="Enter registered email (e.g., shalom@orin.network)"
          />
          {isLoading && <p className="hint-text" style={{ textAlign: "left" }}>Searching blockchain...</p>}
        </div>
      )}

      {/* ── New User Onboarding ────────────────── */}
      {profileNotFound && !profileData && (
        <div className="orin-card fade-up" style={{ marginBottom: 40, textAlign: "center", borderColor: "var(--gold)" }}>
          <div className="section-label" style={{ justifyContent: "center", marginBottom: 16, color: "var(--gold)" }}>Identity Not Found</div>
          <p style={{ marginBottom: 20, fontSize: 14 }}>No on-chain profile found for <strong>{guestEmail}</strong>. You must register on Solana to use ORIN.</p>
          <button 
            onClick={handleInitialize}
            disabled={isInitializing}
            className={`btn-primary ${isInitializing ? "btn-disabled" : ""}`}
            style={{ width: "auto" }}
          >
            {isInitializing ? "Registering on Solana..." : "Initialize Guest Profile"}
          </button>
          {error && <p style={{ color: "var(--danger)", marginTop: 12, fontSize: 12 }}>{error}</p>}
        </div>
      )}

      {/* ── Welcome Module ─────────────────────── */}
      <div className="fade-up fade-up-d1" style={{ marginBottom: 60 }}>
        <div className="problem-visual">
          <div className="screen-header">Room 204 — ORIN Ready</div>
          <div className="screen-title">
            Welcome back,<br />
            {profileData ? <span style={{ color: "var(--gold)" }}>{profileData.name}</span> : <em>Guest.</em>}
          </div>
          <div className="screen-sub">Adjusted before you arrived.</div>
          
          <div className="screen-chips">
            <div className="chip chip-active">22°C ✓</div>
            <div className="chip chip-active">Warm lighting ✓</div>
            <div className="chip chip-active">Ambient playlist ✓</div>
          </div>
          
          <button 
            onClick={onEnterRoom}
            className="btn-primary" 
            style={{ width: "fit-content", padding: "12px 28px", marginTop: "12px" }}
          >
            Enter Room →
          </button>
        </div>
      </div>

      {/* ── Profile Stats ──────────────────────── */}
      <div className="section-label fade-up fade-up-d2">On-Chain Identity</div>
      <div className="spaces-grid fade-up fade-up-d3">
        <div className="space-card">
          <h3>Wallet</h3>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
            {publicKey?.toBase58().slice(0, 8)}...{publicKey?.toBase58().slice(-8)}
          </p>
          <p style={{ marginTop: 8, fontSize: 14 }}>
            Status: <span style={{ color: "var(--success)" }}>Authenticated</span>
          </p>
        </div>
        
        <div className="space-card">
          <h3>Loyalty Points</h3>
          <p style={{ fontSize: 32, color: "var(--gold)", fontWeight: 400, fontFamily: "var(--font-mono)" }}>
            {profileData ? (profileData.loyaltyPoints as any).toString() : "0"} <span style={{ fontSize: 14, color: "var(--text-dim)" }}>PTS</span>
          </p>
        </div>

        <div className="space-card" style={{ gridColumn: "1 / -1", display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3>Stay History</h3>
            <p>Total verified environmental activations</p>
          </div>
          <div style={{ fontSize: 48, color: "var(--white)", fontWeight: 300, fontFamily: "var(--font-mono)" }}>
            {profileData ? profileData.stayCount : "0"}
          </div>
        </div>
      </div>
    </div>
  );
}

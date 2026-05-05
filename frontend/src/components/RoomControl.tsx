/**
 * Room Control Component — ORIN Brand Template
 * Pure CSS classes matching docs/index_template.html
 */

"use client";

// Legacy reference component copied from the original frontend.
// The live frontend2 room-control flow is implemented in src/app/page.tsx.

import React, { useState, useCallback } from "react";
import { useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { deriveGuestPda } from "@/lib/pda";
import { getConnection } from "@/lib/solana";
import {
  saveVoicePreferences,
  saveManualPreferences,
  RoomPreferences,
  SavePreferencesResult,
} from "@/lib/savePreferences";
import { type GuestContext, transcribeAudio } from "@/lib/api";
import idl from "@idl/orin_identity.json";

type LightingMode = "warm" | "cold" | "ambient";
type RoomMode = "relax" | "focus" | "sleep";

const MODE_PRESETS: Record<RoomMode, { temp: number; brightness: number; lighting: LightingMode; music: string; color: string; label: string; desc: string }> = {
  relax: { temp: 23, brightness: 40, lighting: "warm", music: "Luxe Jazz", color: "#FF8C42", label: "Relax", desc: "Warm · 23°C · 40%" },
  focus: { temp: 21, brightness: 85, lighting: "cold", music: "", color: "#1E90FF", label: "Focus", desc: "Cool · 21°C · 85%" },
  sleep: { temp: 19, brightness: 10, lighting: "ambient", music: "Ambient Waves", color: "#4B0082", label: "Sleep", desc: "Ambient · 19°C · 10%" },
};

export default function RoomControl() {
  const { publicKey, connected } = useWallet();
  const anchorWallet = useAnchorWallet();

  const [activeMode, setActiveMode] = useState<RoomMode | null>(null);
  const [temp, setTemp] = useState(22);
  const [brightness, setBrightness] = useState(60);
  const [lightColor, setLightColor] = useState("#C9A84C");
  const [lightingType, setLightingType] = useState<LightingMode>("warm");
  const [music, setMusic] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SavePreferencesResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [guestEmail, setGuestEmail] = useState("");

  // Voice AI States
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [voiceInputText, setVoiceInputText] = useState("");
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const audioChunksRef = React.useRef<Blob[]>([]);

  const applyMode = useCallback((mode: RoomMode) => {
    const p = MODE_PRESETS[mode];
    setActiveMode(mode);
    setTemp(p.temp);
    setBrightness(p.brightness);
    setLightColor(p.color);
    setLightingType(p.lighting);
    setMusic(p.music);
  }, []);

  const handleSave = useCallback(async () => {
    if (!anchorWallet || !publicKey || !guestEmail) {
      setSaveError("Connect wallet and enter guest email to save.");
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const connection = getConnection();
      const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
      const program = new Program(idl as Idl, provider);
      const { pda } = deriveGuestPda(guestEmail, publicKey!);
      const preferences: RoomPreferences = {
        temp: temp,
        lighting: lightingType,
        brightness: brightness,
        music: music,
      };

      const result = await saveManualPreferences(program, pda, publicKey, preferences, guestEmail);

      setSaveResult(result);
    } catch (err: any) {
      setSaveError(err.message || "Failed to save preferences.");
    } finally {
      setIsSaving(false);
    }
  }, [anchorWallet, publicKey, guestEmail, temp, brightness, lightColor, lightingType, music, activeMode]);

  const handleVoiceToggle = useCallback(async () => {
    if (!anchorWallet || !publicKey || !guestEmail) {
      setSaveError("Connect wallet and enter guest email to use Voice AI.");
      return;
    }
    
    if (isRecording) {
      // Stop recording and process
      setIsRecording(false);
      setIsProcessingVoice(true);
      setSaveError(null);
      setSaveResult(null);

      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
      } else {
        setIsProcessingVoice(false);
      }
    } else {
      // Start recording
      setSaveError(null);
      setSaveResult(null);
      
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) audioChunksRef.current.push(event.data);
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
          try {
            // STEP 1: Deepgram Transcribe via Backend Bypass
            const transcribedText = await transcribeAudio(audioBlob);
            setVoiceInputText(transcribedText);

            // STEP 2: Initiate Blockchain + AI loop
            const connection = getConnection();
            const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
            const program = new Program(idl as Idl, provider);
            const { pda } = deriveGuestPda(guestEmail, publicKey!);
        
            const preferences: RoomPreferences = {
              temp: temp,
              lighting: lightingType,
              brightness: brightness,
              music: music,
            };
            const guestContext: GuestContext = { name: guestEmail.split("@")[0], loyaltyPoints: 0, history: [] };

            const command = transcribedText.trim() || "Set room to relax mode";
            const result = await saveVoicePreferences(program, pda, publicKey, command, preferences, guestContext, guestEmail);
            setSaveResult(result);
          } catch (err: any) {
            setSaveError(err.message || "Voice AI transcription failed.");
          } finally {
            setIsProcessingVoice(false);
          }
        };

        mediaRecorder.start();
        setIsRecording(true);
        setVoiceInputText("Listening... (Speak Now)"); 
      } catch (err) {
        setSaveError("Microphone permission denied or Web Audio API not available.");
        setIsProcessingVoice(false);
      }
    }
  }, [anchorWallet, publicKey, guestEmail, temp, lightingType, isRecording]);

  return (
    <div style={{ width: "100%", maxWidth: 640, margin: "0 auto" }}>

      {/* ── Title ──────────────────────── */}
      <div className="fade-up" style={{ textAlign: "center", marginBottom: 48 }}>
        <div className="section-label" style={{ justifyContent: "center", marginBottom: 24 }}>
          Room Control
        </div>
        <h1 style={{ fontSize: "clamp(36px, 5vw, 56px)", fontWeight: 300, letterSpacing: -2, lineHeight: 1.1, color: "var(--white)", marginBottom: 12 }}>
          Your <em style={{ fontStyle: "italic", color: "var(--gold)" }}>ambient</em> space.
        </h1>
        <p style={{ fontSize: 18, fontWeight: 300, fontStyle: "italic", color: "var(--text-dim)" }}>
          Adjust your environment preferences
        </p>
      </div>

      {/* ── Guest Identity ─────────────── */}
      <div className="orin-card fade-up fade-up-d1">
        <div className="section-label" style={{ marginBottom: 16 }}>Guest Identity</div>
        <input
          id="guest-email"
          type="email"
          className="orin-input"
          value={guestEmail}
          onChange={(e) => setGuestEmail(e.target.value)}
          placeholder="your.email@orin.network"
        />
      </div>

      {/* ── Quick Modes ────────────────── */}
      <div className="orin-card fade-up fade-up-d2">
        <div className="section-label" style={{ marginBottom: 20 }}>Quick Modes</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {(Object.keys(MODE_PRESETS) as RoomMode[]).map((mode) => {
            const p = MODE_PRESETS[mode];
            return (
              <button
                key={mode}
                id={`mode-${mode}`}
                onClick={() => applyMode(mode)}
                className={`chip ${activeMode === mode ? "chip-active" : ""}`}
                style={{ flex: 1, minWidth: 100 }}
              >
                {p.label}
                <span className="chip-desc">{p.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Manual Controls ────────────── */}
      <div className="orin-card fade-up fade-up-d3">
        <div className="section-label" style={{ marginBottom: 28 }}>Manual Controls</div>

        {/* temp */}
        <div style={{ marginBottom: 28 }}>
          <div className="control-row">
            <span className="control-label">Temperature</span>
            <span className="control-value">{temp}°C</span>
          </div>
          <input id="temp-slider" type="range" min={16} max={30} step={0.5} value={temp}
            onChange={(e) => { setTemp(parseFloat(e.target.value)); setActiveMode(null); }} />
        </div>

        {/* Brightness */}
        <div style={{ marginBottom: 28 }}>
          <div className="control-row">
            <span className="control-label">Brightness</span>
            <span className="control-value">{brightness}%</span>
          </div>
          <input id="brightness-slider" type="range" min={0} max={100} step={1} value={brightness}
            onChange={(e) => { setBrightness(parseInt(e.target.value)); setActiveMode(null); }} />
        </div>

        {/* Light Color */}
        <div style={{ marginBottom: 28 }}>
          <div className="control-row">
            <span className="control-label">Light Color</span>
            <span className="control-label">{lightColor}</span>
          </div>
          <input id="color-picker" type="color" className="color-picker" value={lightColor}
            onChange={(e) => { setLightColor(e.target.value); setActiveMode(null); }} />
        </div>

        {/* Lighting Mode */}
        <div>
          <div className="control-label" style={{ marginBottom: 10 }}>Lighting Mode</div>
          <div style={{ display: "flex", gap: 10 }}>
            {(["warm", "cold", "ambient"] as LightingMode[]).map((mode) => (
              <button key={mode} id={`lighting-${mode}`}
                onClick={() => { setLightingType(mode); setActiveMode(null); }}
                className={`chip ${lightingType === mode ? "chip-active" : ""}`}
                style={{ flex: 1 }}>
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Actions (Voice & Save) ───────── */}
      <div className="fade-up fade-up-d4" style={{ marginTop: 32, marginBottom: 24, display: 'flex', gap: '16px', flexDirection: 'column' }}>
        
        {/* Voice AI Integrator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(201, 168, 76, 0.05)', padding: '16px', border: '1px solid var(--gold-line)' }}>
          <button 
            type="button"
            onClick={handleVoiceToggle} 
            disabled={isProcessingVoice || !connected || !guestEmail || isSaving}
            style={{
              width: 48, height: 48, borderRadius: '50%', border: '1px solid var(--gold)',
              background: isRecording ? 'var(--danger)' : 'transparent',
              color: isRecording ? 'var(--white)' : 'var(--gold)',
              cursor: (isProcessingVoice || !connected || !guestEmail || isSaving) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s'
            }}
          >
            {isRecording ? "⏹" : "🎤"}
          </button>
          <div style={{ flex: 1 }}>
            <div className="control-label" style={{ marginBottom: 4 }}>
              {isRecording ? "Recording..." : isProcessingVoice ? "Processing Intelligence..." : "Tell ORIN what you want"}
            </div>
            {isRecording && <span className="status-dot" style={{ background: 'var(--danger)', boxShadow: '0 0 6px var(--danger)' }}></span>}
            <input 
              type="text" 
              className="orin-input" 
              style={{ border: 'none', padding: 0, opacity: isRecording ? 1 : 0.5 }} 
              placeholder="e.g. 'I want to focus, make it cooler'" 
              value={voiceInputText}
              onChange={(e) => setVoiceInputText(e.target.value)}
              disabled={!isRecording}
            />
          </div>
        </div>

        {/* Manual Save Button */}
        <button
          id="save-setup-btn"
          onClick={handleSave}
          disabled={isSaving || isProcessingVoice || isRecording || !connected || !guestEmail}
          className={`btn-primary ${(isSaving || isProcessingVoice || isRecording || !connected || !guestEmail) ? "btn-disabled" : ""}`}
        >
          {isSaving ? "Saving to blockchain..." : !connected ? "Connect wallet to save" : !guestEmail ? "Enter guest email to save" : "Save my setup →"}
        </button>
      </div>

      {/* ── Status Feedback ────────────── */}
      {saveResult && (
        <div className="status-success fade-up">
          <div>
            <span className="status-dot" />
            <span className="status-label">Preferences saved</span>
          </div>
          <div className="status-detail">
            <div>Step A · {saveResult.apiAccepted ? "API Accepted ✓" : "API Rejected ✗"}</div>
            <div>Step B · Hash: {saveResult.hashHex.slice(0, 20)}...</div>
            <div>Step C · TX: {saveResult.solanaTxSignature?.slice(0, 20)}...</div>
          </div>
        </div>
      )}

      {saveError && (
        <div className="status-error fade-up">
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--danger)", letterSpacing: 1 }}>
            {saveError}
          </span>
        </div>
      )}

      {!connected && (
        <p className="hint-text">Connect your Solana wallet to enable room sync</p>
      )}
    </div>
  );
}

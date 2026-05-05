"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction as usePrivySignTransaction, useWallets as usePrivySolanaWallets } from "@privy-io/react-auth/solana";
import { BedDouble, Camera, Check, ChevronLeft, Home, Lightbulb, LogOut, MapPin, MessageCircle, Mic, Music, Send, Sparkles, Thermometer, Ticket, UserRound, Wallet, Zap } from "lucide-react";

import { BrandWordmark, ConsentArt } from "./orin-ui";
import {
  buildBookingSummary,
  bookStay,
  fetchCuratedStays,
  fetchDeviceStatus,
  fetchFastVoiceReply,
  fetchGuestProfileApi,
  fetchTtsAudio,
  requestPusdFaucet,
  updateGuestAvatar,
  type BookingSummary,
  type CuratedSearchRequest,
  type CuratedStayOption,
  type GuestProfileRecord,
  type PusdPaymentDetails,
} from "../lib/api";
import { deriveGuestPda } from "../lib/pda";
import { getConnection, getProgram, getProvider } from "../lib/solana";
import { saveManualPreferences, saveVoicePreferences, type RoomPreferences } from "../lib/savePreferences";
import { cn } from "../lib/utils";
import idl from "../../idl/orin_identity.json";

type AppView = "landing" | "onboarding" | "dashboard";
type Tab = "home" | "chat" | "booking" | "room" | "profile";
type PaymentMethod = "pusd" | "mastercard";
type LightingMode = "warm" | "cold" | "ambient";
type PreferenceOption = { label: string; value: string; description: string };
type PreferenceStep = { id: string; kicker: string; label: string; options: readonly PreferenceOption[] };
type ChatCard =
  | { type: "stays"; options: CuratedStayOption[] }
  | { type: "confirmation"; option: CuratedStayOption; summary: BookingSummary }
  | { type: "payment"; summary: BookingSummary; approved?: boolean };
type ChatMessage = { id: string; role: "orin" | "user"; text?: string; card?: ChatCard };
type SolanaLinkedAccount = { type?: string; address?: string; chainType?: string };
type SignerWallet = {
  publicKey: PublicKey;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
};

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const searchDefaults: CuratedSearchRequest = {
  check_in_date: "2026-06-10",
  check_out_date: "2026-06-12",
  guests: 2,
  location: { latitude: 40.7128, longitude: -74.006, radius: 10 },
  conversation_summary: "Premium calm hotel stay with strong WiFi and personalized room setup.",
  loyalty_points: 0,
};

const preferenceSteps = [
  {
    id: "vibe",
    kicker: "Stay memory",
    label: "What kind of stay should ORIN prepare for you?",
    options: [
      { label: "Calm luxury", value: "calm_luxury", description: "Quiet rooms, soft lighting, slower pacing." },
      { label: "Business focus", value: "business_focus", description: "Bright workspace, cooler air, minimal distractions." },
      { label: "Nightlife ready", value: "nightlife_ready", description: "Warmer energy with upbeat room defaults." },
    ],
  },
  {
    id: "temperature",
    kicker: "Room climate",
    label: "Preferred room temperature?",
    options: [
      { label: "Cool", value: "19", description: "Set default room temperature to 19°C." },
      { label: "Balanced", value: "22", description: "Set default room temperature to 22°C." },
      { label: "Warm", value: "24", description: "Set default room temperature to 24°C." },
    ],
  },
  {
    id: "lighting",
    kicker: "Lighting mood",
    label: "How should the lights feel?",
    options: [
      { label: "Warm", value: "warm", description: "Golden hotel lighting for relaxed evenings." },
      { label: "Cold", value: "cold", description: "Clean bright lighting for work and focus." },
      { label: "Ambient", value: "ambient", description: "Soft mood lighting for winding down." },
    ],
  },
  {
    id: "brightness",
    kicker: "Light level",
    label: "Default brightness?",
    options: [
      { label: "Dim", value: "35", description: "Low brightness for a softer arrival." },
      { label: "Balanced", value: "65", description: "Comfortable brightness for most stays." },
      { label: "Bright", value: "85", description: "High brightness for work and clarity." },
    ],
  },
  {
    id: "sound",
    kicker: "Sound profile",
    label: "Default room sound?",
    options: [
      { label: "Morning jazz", value: "Jazz", description: "Start with a warm jazz profile." },
      { label: "Ambient calm", value: "Ambient", description: "Keep the room quiet and atmospheric." },
      { label: "No music", value: "", description: "Arrive to silence by default." },
    ],
  },
] satisfies readonly PreferenceStep[];

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const getNumericValue = (value: unknown) => {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (value && typeof value === "object" && "toNumber" in value) {
    const maybeFn = (value as { toNumber?: unknown }).toNumber;
    if (typeof maybeFn === "function") return maybeFn.call(value) as number;
  }
  return 0;
};

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function renderTextWithLinks(text: string) {
  const parts = text.split(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g);
  return parts.map((part, index) => {
    if (index % 3 === 1) {
      const href = parts[index + 1];
      return <a key={`${part}-${href}`} className="chat-link" href={href} target="_blank" rel="noreferrer">{part}</a>;
    }
    if (index % 3 === 2) return null;
    return part;
  });
}

function playAudio(
  audioBase64: string,
  mimeType: string,
  activeAudioRef?: React.MutableRefObject<HTMLAudioElement | null>
) {
  if (activeAudioRef?.current) {
    activeAudioRef.current.pause();
    activeAudioRef.current.currentTime = 0;
  }
  const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
  if (activeAudioRef) {
    activeAudioRef.current = audio;
    audio.onended = () => {
      if (activeAudioRef.current === audio) activeAudioRef.current = null;
    };
  }
  return audio.play().catch(() => undefined);
}

function normalizeLighting(value: string | undefined): LightingMode {
  return value === "cold" || value === "ambient" ? value : "warm";
}

function buildRoomPrefsFromAnswers(answers: Record<string, string>): RoomPreferences {
  const sound = answers.sound ?? "Jazz";
  return {
    temp: Number(answers.temperature ?? 22),
    lighting: normalizeLighting(answers.lighting),
    brightness: Number(answers.brightness ?? 65),
    music: sound,
  };
}

function getPrivyEmail(user: unknown) {
  const record = user as { email?: { address?: string } | string; linkedAccounts?: Array<Record<string, unknown>> } | null;
  if (!record) return "";
  if (typeof record.email === "string") return record.email;
  if (record.email?.address) return record.email.address;
  const emailAccount = record.linkedAccounts?.find((account) => account.type === "email" && typeof account.address === "string");
  return typeof emailAccount?.address === "string" ? emailAccount.address : "";
}

function splitGuestName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    given_name: parts[0] || "ORIN",
    family_name: parts.slice(1).join(" ") || "Guest",
  };
}

function getStayQuoteId(option: CuratedStayOption) {
  return option.quote_id || option.quoteId;
}

async function findAssociatedTokenAddress(mint: PublicKey, owner: PublicKey) {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey
) {
  return new Transaction().add({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  }).instructions[0];
}

function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number
) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new Transaction().add({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  }).instructions[0];
}

async function executePusdPaymentTransfer(
  signerWallet: SignerWallet,
  details: PusdPaymentDetails
) {
  if (!signerWallet.signTransaction) {
    throw new Error("Connected wallet does not support transaction signing.");
  }

  const payer = signerWallet.publicKey;
  const mint = new PublicKey(details.mint);
  const recipient = new PublicKey(details.recipient);
  const sourceAta = await findAssociatedTokenAddress(mint, payer);
  const recipientAta = await findAssociatedTokenAddress(mint, recipient);
  const units = BigInt(Math.round(details.amount * 10 ** details.decimals));
  const connection = getConnection();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });

  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, sourceAta, payer, mint));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, recipientAta, recipient, mint));
  tx.add(createTransferCheckedInstruction(sourceAta, mint, recipientAta, payer, units, details.decimals));
  if (details.memo_hash) {
    tx.add({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(details.memo_hash, "utf8"),
    });
  }

  const signed = await signerWallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

export default function Frontend2App() {
  const walletAdapter = useWallet();
  const { authenticated, login, logout, ready, user } = usePrivy();
  const { wallets: privySolanaWallets } = usePrivySolanaWallets();
  const { signTransaction: signPrivyTransaction } = usePrivySignTransaction();

  const [view, setView] = useState<AppView>("landing");
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [guestName, setGuestName] = useState("");
  const [profile, setProfile] = useState<GuestProfileRecord | null>(null);
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [onboardingName, setOnboardingName] = useState("");
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const [temp, setTemp] = useState(22);
  const [brightness, setBrightness] = useState(80);
  const [lighting, setLighting] = useState<LightingMode>("warm");
  const [music, setMusic] = useState("Jazz");
  const [musicUrl, setMusicUrl] = useState("");
  const [musicOn, setMusicOn] = useState(true);
  const [isSavingRoom, setIsSavingRoom] = useState(false);
  const [isAirdroppingPusd, setIsAirdroppingPusd] = useState(false);
  const [isFinalizingBooking, setIsFinalizingBooking] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "welcome", role: "orin", text: "Welcome back. I'm ORIN, your personal AI concierge. All systems are online." },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [isChatBusy, setIsChatBusy] = useState(false);
  const [selectedStay, setSelectedStay] = useState<CuratedStayOption | null>(null);
  const [bookingSummary, setBookingSummary] = useState<BookingSummary | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [bookingApproved, setBookingApproved] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastLocalRoomEditAt = useRef(0);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);

  const derivedAddress = useMemo(() => {
    if (walletAdapter.publicKey) return walletAdapter.publicKey.toBase58();
    const linkedAccounts = (user?.linkedAccounts ?? []) as SolanaLinkedAccount[];
    const solanaAccount = linkedAccounts.find((account) => {
      if (account.type === "solana_wallet") return true;
      if (account.type !== "wallet") return false;
      const chainType = (account.chainType ?? "").toLowerCase();
      return chainType === "solana" || chainType.startsWith("solana:");
    });
    return solanaAccount?.address ?? "";
  }, [user, walletAdapter.publicKey]);

  const effectivePublicKey = useMemo(() => {
    if (!derivedAddress) return null;
    try {
      return new PublicKey(derivedAddress);
    } catch {
      return null;
    }
  }, [derivedAddress]);

  const privySignerWallet = useMemo(() => {
    if (!effectivePublicKey) return null;
    const address = effectivePublicKey.toBase58().toLowerCase();
    return privySolanaWallets.find((wallet) => wallet.address.toLowerCase() === address) ?? null;
  }, [effectivePublicKey, privySolanaWallets]);

  const signerWallet = useMemo<SignerWallet | null>(() => {
    if (walletAdapter.publicKey && (walletAdapter.signTransaction || walletAdapter.signAllTransactions)) {
      return {
        publicKey: walletAdapter.publicKey,
        signTransaction: walletAdapter.signTransaction,
        signAllTransactions: walletAdapter.signAllTransactions,
      };
    }
    if (effectivePublicKey && privySignerWallet) {
      return {
        publicKey: effectivePublicKey,
        signTransaction: async (tx: Transaction) => {
          const signed = await signPrivyTransaction({
            transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
            wallet: privySignerWallet,
          });
          return Transaction.from(signed.signedTransaction);
        },
      };
    }
    return null;
  }, [effectivePublicKey, privySignerWallet, signPrivyTransaction, walletAdapter.publicKey, walletAdapter.signAllTransactions, walletAdapter.signTransaction]);

  const guestPda = useMemo(() => {
    if (!effectivePublicKey || !guestName.trim()) return null;
    return deriveGuestPda(guestName.trim(), effectivePublicKey).pda;
  }, [effectivePublicKey, guestName]);

  const walletLabel = derivedAddress ? `${derivedAddress.slice(0, 4)}...${derivedAddress.slice(-4)}` : "Privy wallet";
  const loyaltyPoints = getNumericValue(profile?.loyaltyPoints ?? profile?.loyalty_points);
  const persona = typeof profile?.persona === "string" && profile.persona.trim()
    ? profile.persona
    : "ORIN is building your long-term hospitality memory from each stay.";
  const roomPrefs = useMemo<RoomPreferences>(() => ({
    temp,
    lighting,
    brightness,
    music: musicOn ? music : "",
  }), [brightness, lighting, music, musicOn, temp]);

  const appendMessage = useCallback((message: Omit<ChatMessage, "id">) => {
    const id = newId();
    setMessages((current) => [...current, { id, ...message }]);
    return id;
  }, []);

  const replaceMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((current) => current.map((message) => message.id === id ? { ...message, ...patch } : message));
  }, []);

  const markLocalRoomEdit = useCallback(() => {
    lastLocalRoomEditAt.current = Date.now();
  }, []);

  const updateTemp = useCallback((value: number) => {
    markLocalRoomEdit();
    setTemp(value);
  }, [markLocalRoomEdit]);

  const updateBrightness = useCallback((value: number) => {
    markLocalRoomEdit();
    setBrightness(value);
  }, [markLocalRoomEdit]);

  const updateLighting = useCallback((value: LightingMode) => {
    markLocalRoomEdit();
    setLighting(value);
  }, [markLocalRoomEdit]);

  const updateMusic = useCallback((value: string) => {
    markLocalRoomEdit();
    setMusic(value);
  }, [markLocalRoomEdit]);

  const updateMusicOn = useCallback((value: boolean) => {
    markLocalRoomEdit();
    setMusicOn(value);
  }, [markLocalRoomEdit]);

  const syncRoomState = useCallback((state: Awaited<ReturnType<typeof fetchDeviceStatus>>) => {
    if (Date.now() - lastLocalRoomEditAt.current < 3000) return;
    if (state.nest?.temp !== undefined) setTemp(Number(state.nest.temp));
    if (state.hue?.brightness !== undefined) setBrightness(Number(state.hue.brightness));
    if (state.lighting) setLighting(state.lighting);
    if (typeof state.music === "string") {
      setMusic(state.music || "Jazz");
      setMusicOn(Boolean(state.music));
    }
    if (typeof state.music_url === "string") setMusicUrl(state.music_url);
  }, []);

  const refreshGroundTruth = useCallback(async () => {
    if (!guestPda) return;
    try {
      const state = await fetchDeviceStatus(guestPda.toBase58());
      syncRoomState(state);
    } catch (error) {
      console.warn(`[ORIN] Device status sync failed: ${getErrorMessage(error)}`);
    }
  }, [guestPda, syncRoomState]);

  useEffect(() => {
    document.documentElement.classList.add("light");
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setView("landing");
      return;
    }
    const storedName = derivedAddress ? localStorage.getItem(`orin_frontend2_name_${derivedAddress}`) : null;
    if (storedName) {
      const storedPrefs = localStorage.getItem(`orin_frontend2_room_${derivedAddress}`);
      if (storedPrefs) {
        try {
          const parsed = JSON.parse(storedPrefs) as Partial<RoomPreferences>;
          if (typeof parsed.temp === "number") setTemp(parsed.temp);
          if (typeof parsed.brightness === "number") setBrightness(parsed.brightness);
          if (parsed.lighting) setLighting(normalizeLighting(parsed.lighting));
          if (typeof parsed.music === "string") {
            setMusic(parsed.music || "Jazz");
            setMusicOn(Boolean(parsed.music));
          }
          if (typeof (parsed as Partial<RoomPreferences> & { music_url?: string }).music_url === "string") {
            setMusicUrl((parsed as Partial<RoomPreferences> & { music_url?: string }).music_url || "");
          }
        } catch {
          localStorage.removeItem(`orin_frontend2_room_${derivedAddress}`);
        }
      }
      setGuestName(storedName);
      setView("dashboard");
    } else {
      setView("onboarding");
    }
  }, [authenticated, derivedAddress]);

  useEffect(() => {
    if (!guestPda) return;
    let cancelled = false;
    fetchGuestProfileApi(guestPda.toBase58())
      .then((response) => {
        if (cancelled) return;
        if (response.profile) {
          setProfile(response.profile);
          if (response.profile.avatarUrl) setProfileImage(response.profile.avatarUrl);
        }
      })
      .catch((error) => console.warn(`[ORIN] Profile sync failed: ${getErrorMessage(error)}`));
    refreshGroundTruth();
    const interval = window.setInterval(refreshGroundTruth, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [guestPda, refreshGroundTruth]);

  useEffect(() => {
    if (!guestPda) return;
    try {
      const connection = getConnection();
      const subscription = connection.onAccountChange(guestPda, () => {
        void refreshGroundTruth();
        void fetchGuestProfileApi(guestPda.toBase58()).then((response) => {
          if (response.profile) setProfile(response.profile);
        }).catch(() => undefined);
      }, "confirmed");
      return () => {
        void connection.removeAccountChangeListener(subscription);
      };
    } catch (error) {
      console.warn(`[ORIN] WebSocket listener unavailable: ${getErrorMessage(error)}`);
    }
  }, [guestPda, refreshGroundTruth]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeTab]);

  const finishOnboarding = async () => {
    const finalName = onboardingName.trim() || "Guest";
    const initialRoomPrefs = buildRoomPrefsFromAnswers(answers);
    const onboardingSummary = [
      answers.vibe ? `stay mood ${answers.vibe.replace(/_/g, " ")}` : null,
      `room temperature ${initialRoomPrefs.temp} degrees`,
      `${initialRoomPrefs.lighting} lighting`,
      `${initialRoomPrefs.brightness}% brightness`,
      initialRoomPrefs.music ? `${initialRoomPrefs.music} music` : "no music",
    ].filter(Boolean).join(", ");
    markLocalRoomEdit();
    setTemp(initialRoomPrefs.temp);
    setBrightness(initialRoomPrefs.brightness);
    setLighting(initialRoomPrefs.lighting);
    setMusic(initialRoomPrefs.music || "Jazz");
    setMusicOn(Boolean(initialRoomPrefs.music));
    setGuestName(finalName);
    if (derivedAddress) {
      localStorage.setItem(`orin_frontend2_name_${derivedAddress}`, finalName);
      localStorage.setItem(`orin_frontend2_room_${derivedAddress}`, JSON.stringify(initialRoomPrefs));
      localStorage.setItem(`orin_frontend2_answers_${derivedAddress}`, JSON.stringify(answers));
    }
    setMessages([{ id: "welcome", role: "orin", text: `Welcome back, ${finalName}. I'm ORIN, your personal AI concierge. All systems are online.` }]);
    setActiveTab("booking");
    setView("dashboard");
    setIsChatBusy(true);
    const loadingId = appendMessage({ role: "orin", text: "Preparing stays that match your ORIN profile..." });
    try {
      const response = await fetchCuratedStays({
        ...searchDefaults,
        conversation_summary: `New guest onboarding complete for ${finalName}: ${onboardingSummary}. Recommend 2-3 stays that match this style.`,
        loyalty_points: loyaltyPoints,
      } satisfies CuratedSearchRequest);
      replaceMessage(loadingId, { text: "I found stays that match your style. Choose one and I will prepare the booking details in chat." });
      appendMessage({ role: "orin", card: { type: "stays", options: [...response.options] } });
    } catch (error) {
      replaceMessage(loadingId, { text: `I couldn't fetch curated stays yet: ${getErrorMessage(error)}` });
    } finally {
      setIsChatBusy(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setGuestName("");
    setProfile(null);
    setView("landing");
  };

  const handleCuratedSearch = useCallback(async (input: string) => {
    setActiveTab("chat");
    setIsChatBusy(true);
    appendMessage({ role: "user", text: input });
    const loadingId = appendMessage({ role: "orin", text: "Searching live curated stays for your profile..." });
    try {
      const response = await fetchCuratedStays({ ...searchDefaults, conversation_summary: input, loyalty_points: loyaltyPoints } satisfies CuratedSearchRequest);
      replaceMessage(loadingId, { text: `${response.conversationSummary}\n\nI found ${response.options.length} stays that match your ORIN memory.` });
      appendMessage({ role: "orin", card: { type: "stays", options: [...response.options] } });
      setActiveTab("booking");
    } catch (error) {
      replaceMessage(loadingId, { text: `I couldn't fetch stays yet: ${getErrorMessage(error)}` });
    } finally {
      setIsChatBusy(false);
    }
  }, [appendMessage, loyaltyPoints, replaceMessage]);

  const selectStay = (option: CuratedStayOption) => {
    const summary = buildBookingSummary(option, searchDefaults.check_in_date, searchDefaults.check_out_date, searchDefaults.guests, loyaltyPoints);
    setSelectedStay(option);
    setBookingSummary(summary);
    setPaymentMethod(null);
    setBookingApproved(false);
    appendMessage({ role: "orin", text: `Great choice. I prepared a booking summary for ${option.hotelName}.` });
    appendMessage({ role: "orin", card: { type: "confirmation", option, summary } });
    setActiveTab("chat");
  };

  const showPayment = () => {
    if (!bookingSummary) return;
    appendMessage({ role: "orin", text: "Payment summary is ready. Choose $PUSD or Mastercard for final approval." });
    appendMessage({ role: "orin", card: { type: "payment", summary: bookingSummary } });
    setActiveTab("chat");
  };

  const finalizeBooking = async () => {
    if (!selectedStay || !paymentMethod) return;
    if (paymentMethod === "pusd" && (!effectivePublicKey || !signerWallet)) {
      appendMessage({ role: "orin", text: "Wallet signer is not ready yet. Please reconnect through Privy before approving $PUSD payment." });
      return;
    }

    setIsFinalizingBooking(true);
    const loadingId = appendMessage({ role: "orin", text: "Submitting booking request..." });
    try {
      const quoteId = getStayQuoteId(selectedStay);
      if (!quoteId) {
        throw new Error("Selected stay is missing quote_id. Please refresh curated stays and choose again.");
      }

      const response = await bookStay({
        quote_id: quoteId,
        email: getPrivyEmail(user) || `${guestName.trim().replace(/\s+/g, ".").toLowerCase() || "guest"}@orin.ai`,
        phone_number: "+1234567890",
        guests: [splitGuestName(guestName)],
        payment_method: paymentMethod === "pusd" ? "PUSD" : "Fiat",
        amount_usd: bookingSummary?.payableTotal ?? selectedStay.price,
      });

      let paymentSignature = "";
      if (paymentMethod === "pusd" && response.action_required === true) {
        if (!response.payment_details) {
          throw new Error("Backend requested payment approval but did not return payment_details.");
        }
        replaceMessage(loadingId, { text: response.message || "Payment required. Please approve the $PUSD transaction in your wallet." });
        paymentSignature = await executePusdPaymentTransfer(signerWallet!, response.payment_details);
      }

      setBookingApproved(true);
      setMessages((current) => current.map((message) => message.card?.type === "payment" ? { ...message, card: { ...message.card, approved: true } } : message));
      replaceMessage(loadingId, {
        text: paymentSignature
          ? `Booking payment approved with $PUSD. TX Signature: [${paymentSignature.slice(0, 12)}...](https://explorer.solana.com/tx/${paymentSignature}?cluster=devnet)`
          : response.message || `Booking confirmed for ${selectedStay.hotelName}. Payment method: ${paymentMethod === "pusd" ? "$PUSD" : "Mastercard"}.`,
      });
    } catch (error) {
      replaceMessage(loadingId, { text: `Booking error: ${getErrorMessage(error)}` });
    } finally {
      setIsFinalizingBooking(false);
    }
  };

  const handleVoiceOrTextCommand = useCallback(async (input: string) => {
    if (!input.trim()) return;
    if (["hotel", "stay", "book", "travel"].some((word) => input.toLowerCase().includes(word))) {
      await handleCuratedSearch(input);
      setChatInput("");
      return;
    }

    setActiveTab("chat");
    setIsChatBusy(true);
    appendMessage({ role: "user", text: input });
    const responseId = appendMessage({ role: "orin", text: "I'm processing that with ORIN intelligence..." });

    try {
      const history = messages.slice(-6).map((message) => message.text ?? "");
      const fast = await fetchFastVoiceReply({
        userInput: input,
        guestContext: { name: guestName, loyaltyPoints, history, persona, currentPreferences: { temp, lighting, brightness, musicOn } },
      });
      if (fast.text) replaceMessage(responseId, { text: fast.text });
      if (fast.audioBase64) void playAudio(fast.audioBase64, fast.mimeType, activeAudioRef);

      if (!guestPda || !effectivePublicKey || !signerWallet) {
        appendMessage({ role: "orin", text: "Wallet signer is not ready yet, so I handled the conversation but skipped blockchain state changes." });
        return;
      }

      const provider = getProvider(signerWallet);
      const program = getProgram(provider, idl as Idl);
      const result = await saveVoicePreferences(
        program,
        guestPda,
        effectivePublicKey,
        input,
        roomPrefs,
        { name: guestName, loyaltyPoints, history, persona, currentPreferences: roomPrefs },
        guestName,
        (text) => replaceMessage(responseId, { text })
      );

      if (result.aiResult) {
        markLocalRoomEdit();
        if (typeof result.aiResult.temp === "number") setTemp(result.aiResult.temp);
        if (typeof result.aiResult.brightness === "number") setBrightness(result.aiResult.brightness);
        if (result.aiResult.lighting) setLighting(result.aiResult.lighting);
        if (typeof result.aiResult.music === "string") {
          setMusic(result.aiResult.music || "Jazz");
          setMusicOn(Boolean(result.aiResult.music));
        }
        if (typeof result.aiResult.music_url === "string") setMusicUrl(result.aiResult.music_url);
        if (result.aiResult.raw_response) {
          fetchTtsAudio(result.aiResult.raw_response)
            .then((tts) => playAudio(tts.audioBase64, tts.mimeType, activeAudioRef))
            .catch(() => undefined);
        }
      }

      if (result.solanaTxSignature) {
        appendMessage({ role: "orin", text: `Signature confirmed: [${result.solanaTxSignature.slice(0, 12)}...](https://explorer.solana.com/tx/${result.solanaTxSignature}?cluster=devnet)` });
      }
      await refreshGroundTruth();
    } catch (error) {
      replaceMessage(responseId, { text: `API Error: ${getErrorMessage(error)}` });
    } finally {
      setIsChatBusy(false);
      setChatInput("");
    }
  }, [appendMessage, brightness, effectivePublicKey, guestName, guestPda, handleCuratedSearch, lighting, loyaltyPoints, messages, musicOn, persona, refreshGroundTruth, replaceMessage, roomPrefs, signerWallet, temp]);

  const saveRoom = async () => {
    if (!guestPda || !effectivePublicKey || !signerWallet) {
      appendMessage({ role: "orin", text: "Wallet signer is not ready yet. Please reconnect through Privy and try again." });
      setActiveTab("chat");
      return;
    }
    setIsSavingRoom(true);
    try {
      const provider = getProvider(signerWallet);
      const program = getProgram(provider, idl as Idl);
      const result = await saveManualPreferences(program, guestPda, effectivePublicKey, roomPrefs, guestName);
      if (derivedAddress) {
        localStorage.setItem(`orin_frontend2_room_${derivedAddress}`, JSON.stringify({ ...roomPrefs, music_url: musicUrl }));
      }
      const message = result.solanaTxSignature
        ? `Environment preferences synchronized. Transaction was subsidized by ORIN Relay (Gasless). TX Signature: [${result.solanaTxSignature.slice(0, 12)}...](https://explorer.solana.com/tx/${result.solanaTxSignature}?cluster=devnet)`
        : "Environment preferences synchronized.";
      appendMessage({ role: "orin", text: message });
      setActiveTab("chat");
      window.setTimeout(() => void refreshGroundTruth(), 3500);
    } catch (error) {
      appendMessage({ role: "orin", text: `Error saving setup: ${getErrorMessage(error)}` });
      setActiveTab("chat");
    } finally {
      setIsSavingRoom(false);
    }
  };

  const handleAvatarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = String(reader.result);
      setProfileImage(dataUrl);
      if (guestPda) updateGuestAvatar(guestPda.toBase58(), dataUrl).catch((error) => console.warn(`[ORIN] Avatar sync failed: ${getErrorMessage(error)}`));
    };
    reader.readAsDataURL(file);
  };

  const handleAirdropPusd = async () => {
    if (!derivedAddress) {
      appendMessage({ role: "orin", text: "Connect a Privy Solana wallet before requesting test $PUSD." });
      setActiveTab("chat");
      return;
    }
    setIsAirdroppingPusd(true);
    try {
      const response = await requestPusdFaucet(derivedAddress);
      appendMessage({ role: "orin", text: `${response.message} Faucet TX: [${response.signature.slice(0, 12)}...](https://explorer.solana.com/tx/${response.signature}?cluster=devnet)` });
      setActiveTab("chat");
    } catch (error) {
      appendMessage({ role: "orin", text: `PUSD faucet error: ${getErrorMessage(error)}` });
      setActiveTab("chat");
    } finally {
      setIsAirdroppingPusd(false);
    }
  };

  if (view === "landing") return <Landing ready={ready} onLogin={login} />;
  if (view === "onboarding") {
    return (
      <Onboarding
        name={onboardingName}
        setName={setOnboardingName}
        step={onboardingStep}
        setStep={setOnboardingStep}
        answers={answers}
        setAnswers={setAnswers}
        onComplete={() => void finishOnboarding()}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <main className="page-shell">
      <div className={cn("mobile-frame auth-frame app-screen", `app-screen--${activeTab}`)}>
        <header className="app-home-header dashboard-shell-header">
          <BrandWordmark />
          <div className="dashboard-actions">
            <button className="profile-dot profile-link" onClick={() => setActiveTab("profile")} type="button" aria-label="Profile"><UserRound size={18} /></button>
            <button className="profile-dot profile-link" onClick={handleLogout} type="button" aria-label="Sign out"><LogOut size={18} /></button>
          </div>
        </header>

        <AnimatePresence mode="wait">
          <motion.section key={activeTab} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} className={cn("dashboard-screen", `dashboard-screen--${activeTab}`)}>
            {activeTab === "home" && <HomeScreen guestName={guestName} persona={persona} temp={temp} brightness={brightness} lighting={lighting} music={musicOn ? music : "Off"} onChat={() => setActiveTab("chat")} onRoom={() => setActiveTab("room")} onBook={() => void handleCuratedSearch("Recommend premium hotel stays that fit my ORIN profile.")} />}
            {activeTab === "chat" && <ChatScreen messages={messages} input={chatInput} setInput={setChatInput} isBusy={isChatBusy} onSend={() => void handleVoiceOrTextCommand(chatInput)} onRecommend={() => void handleCuratedSearch("Recommend curated stays for two nights.")} onBack={() => setActiveTab("home")} onSelectStay={selectStay} onConfirm={showPayment} paymentMethod={paymentMethod} setPaymentMethod={setPaymentMethod} approved={bookingApproved} onFinalize={() => void finalizeBooking()} isFinalizing={isFinalizingBooking} messagesEndRef={messagesEndRef} />}
            {activeTab === "booking" && <BookingScreen messages={messages} isLoading={isChatBusy} selectedStay={selectedStay} summary={bookingSummary} paymentMethod={paymentMethod} setPaymentMethod={setPaymentMethod} approved={bookingApproved} onSearch={() => void handleCuratedSearch("Show me premium hotel options for my next stay.")} onSelect={selectStay} onConfirm={showPayment} onFinalize={() => void finalizeBooking()} isFinalizing={isFinalizingBooking} />}
            {activeTab === "room" && <RoomScreen temp={temp} setTemp={updateTemp} brightness={brightness} setBrightness={updateBrightness} lighting={lighting} setLighting={updateLighting} music={music} musicUrl={musicUrl} setMusic={updateMusic} musicOn={musicOn} setMusicOn={updateMusicOn} isSaving={isSavingRoom} onSave={() => void saveRoom()} />}
            {activeTab === "profile" && <ProfileScreen guestName={guestName} walletLabel={walletLabel} profileImage={profileImage} persona={persona} points={loyaltyPoints} temp={temp} brightness={brightness} lighting={lighting} music={musicOn ? music : "Off"} onAvatarChange={handleAvatarChange} onAirdropPusd={() => void handleAirdropPusd()} isAirdroppingPusd={isAirdroppingPusd} />}
          </motion.section>
        </AnimatePresence>

        <nav className="bottom-tab-bar" aria-label="Dashboard navigation">
          {[
            { id: "home" as const, label: "Home", icon: Home },
            { id: "chat" as const, label: "ORIN", icon: MessageCircle },
            { id: "booking" as const, label: "Book", icon: BedDouble },
            { id: "room" as const, label: "Room", icon: Zap },
            { id: "profile" as const, label: "Profile", icon: UserRound },
          ].map((tab) => (
            <button key={tab.id} className={cn("tab-button", activeTab === tab.id && "tab-button--active")} onClick={() => setActiveTab(tab.id)} type="button">
              <tab.icon size={18} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </main>
  );
}

function Landing({ ready, onLogin }: { ready: boolean; onLogin: () => void }) {
  const features = [
    { title: "AI Concierge", description: "Talk and type naturally and ORIN understands context", icon: <LandingMicIcon /> },
    { title: "Room Control", description: "Lighting, temperature and music handled for you instantly, seamlessly, quietly.", icon: <LandingSettingsIcon /> },
    { title: "Personalized Experience", description: "Your preferences follow you everywhere. Every session builds a richer picture of what you love", icon: <LandingUserIcon /> },
    { title: "Instant Booking", description: "Find and secure stays that match your exact style curated by ORIN, confirmed in seconds.", icon: <LandingMapIcon /> },
    { title: "24/7 Customer Support", description: "Immediate assistance at any hour", icon: <LandingChatIcon /> },
  ];

  const footerColumns = [
    { title: "PRODUCTS", links: ["Features", "How it works", "Rewards"] },
    { title: "COMPANY", links: ["About", "Contact us"] },
    { title: "RESOURCES", links: ["Help center", "Privacy"] },
  ];

  return (
    <main className="page-shell">
      <div className="mobile-frame landing-frame">
        <header className="top-header">
          <BrandWordmark />
          <button className="menu-button" aria-label="Sign in" onClick={onLogin} type="button"><Wallet size={22} /></button>
        </header>
        <section className="hero-section hero-section--auth-entry">
          <div className="eyebrow-pill">AI-powered stays, personalized for you</div>
          <h1>Your Personal AI Concierge</h1>
          <p className="hero-copy hero-copy--entry">Every hotel already knows you.</p>
          <div className="hero-visual"><img src="/images/hero-phone.png" alt="ORIN app preview" /></div>
          <div className="cta-stack cta-stack--entry">
            <button className="primary-button primary-button--entry" onClick={onLogin} disabled={!ready} type="button">{ready ? "Sign In to ORIN" : "Loading Privy..."}</button>
          </div>
        </section>

        <section className="feature-section">
          <h2>How ORIN works</h2>
          <div className="feature-list">
            {features.map((feature) => (
              <article className="feature-row" key={feature.title}>
                <div className="feature-icon">{feature.icon}</div>
                <div className="feature-copy">
                  <h3>{feature.title}</h3>
                  <p>{feature.description}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="subscribe-section">
          <div className="subscribe-copy">
            <h2>Subscribe to updates</h2>
            <p>Get early access updates &amp; New features</p>
          </div>
          <form className="subscribe-form" onSubmit={(event) => event.preventDefault()}>
            <input type="email" placeholder="Enter your email" aria-label="Email" />
            <button type="submit">Submit</button>
          </form>
        </section>
        <footer className="footer-section">
          <div className="footer-brand">
            <BrandWordmark />
            <p>Your personal AI concierge for intelligent hotels.</p>
            <div className="social-row" aria-label="Social links">
              <a className="social-icon" href="https://x.com/orinhq?s=21" target="_blank" rel="noreferrer" aria-label="ORIN on X">
                <XIcon />
              </a>
              <a className="social-icon" href="https://www.linkedin.com/company/orinhq/" target="_blank" rel="noreferrer" aria-label="ORIN on LinkedIn">
                <LinkedInIcon />
              </a>
              <span className="social-icon social-icon--disabled" aria-label="ORIN Instagram coming soon">
                <InstagramIcon />
              </span>
            </div>
          </div>
          <div className="footer-columns">
            {footerColumns.map((column) => (
              <div key={column.title}>
                <h3>{column.title}</h3>
                {column.links.map((link) => link === "Contact us"
                  ? <a className="footer-link" href="mailto:hello@OrinHQ.xyz" key={link}>hello@OrinHQ.xyz</a>
                  : <span className="footer-link" key={link}>{link}</span>)}
              </div>
            ))}
          </div>
          <div className="footer-bottom">
            <div className="footer-line" />
            <p>2026 ORIN. All rights reserved.</p>
            <div className="footer-policies">
              <span>Privacy Policy</span>
              <span>Terms of service</span>
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4L20 20M20 4L4 20" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.2 10.2V18M7.2 6.4V6.3M11 18V10.2M11 13.8C11 11.8 12.2 10 14.4 10C16.6 10 17.6 11.5 17.6 14.1V18" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="4" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M16.6 7.7H16.7" />
    </svg>
  );
}

function LandingMicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="10" rx="3" />
      <path d="M6.5 11.5C6.5 14.54 8.96 17 12 17C15.04 17 17.5 14.54 17.5 11.5" />
      <path d="M12 17V21" />
    </svg>
  );
}

function LandingSettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5V6.5" />
      <path d="M12 17.5V20.5" />
      <path d="M4.93 6.93L7.05 9.05" />
      <path d="M16.95 18.95L19.07 21.07" />
      <path d="M3.5 12H6.5" />
      <path d="M17.5 12H20.5" />
      <path d="M4.93 17.07L7.05 14.95" />
      <path d="M16.95 5.05L19.07 2.93" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

function LandingUserIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 19C6.7 16.67 9.1 15.5 12 15.5C14.9 15.5 17.3 16.67 19 19" />
    </svg>
  );
}

function LandingMapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 6.5L9.5 4.5L14.5 6.5L19.5 4.5V17.5L14.5 19.5L9.5 17.5L4.5 19.5V6.5Z" />
      <path d="M9.5 4.5V17.5" />
      <path d="M14.5 6.5V19.5" />
    </svg>
  );
}

function LandingChatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6.5H18V15.5H10L6 18V6.5Z" />
      <path d="M9 10.5H15" />
    </svg>
  );
}

function Onboarding({ name, setName, step, setStep, answers, setAnswers, onComplete, onLogout }: {
  name: string;
  setName: (value: string) => void;
  step: number;
  setStep: (value: number) => void;
  answers: Record<string, string>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onComplete: () => void;
  onLogout: () => void;
}) {
  const activeQuestion = preferenceSteps[step - 1];
  const canContinue = step === 0 ? name.trim().length > 0 : activeQuestion ? Boolean(answers[activeQuestion.id]) : true;
  const initialRoomPrefs = buildRoomPrefsFromAnswers(answers);
  return (
    <main className="page-shell">
      <div className="mobile-frame auth-frame">
        <div className="minimal-header"><button className="back-button" onClick={step === 0 ? onLogout : () => setStep(step - 1)} type="button" aria-label="Back"><ChevronLeft size={18} /></button></div>
        {step === 0 ? (
          <section className="profile-screen profile-screen--details">
            <span className="screen-kicker screen-kicker--details">ORIN profile</span>
            <ConsentArt />
            <div className="profile-copy"><h1>Tell ORIN about you.</h1><p>Set up your ORIN profile so every stay feels personal from the moment you arrive.</p></div>
            <div className="profile-form-card"><label><span className="auth-label auth-label--soft">Display name</span><input className="auth-input auth-input--details" value={name} onChange={(event) => setName(event.target.value)} placeholder="Shalom" /></label></div>
            <button className={cn("auth-primary profile-primary", canContinue && "auth-primary--enabled")} disabled={!canContinue} onClick={() => setStep(1)} type="button">Continue</button>
          </section>
        ) : step <= preferenceSteps.length ? (
          <section className="preferences-screen preferences-screen--selection">
            <div className="preferences-topbar"><span>{step}/{preferenceSteps.length}</span><div className="preferences-progress"><span style={{ width: `${(step / preferenceSteps.length) * 100}%` }} /></div></div>
            <div className="preferences-copy"><p className="screen-kicker screen-kicker--center screen-kicker--details">{activeQuestion.kicker}</p><h1>{activeQuestion.label}</h1></div>
            <div className="preference-options">
              {activeQuestion.options.map((option) => {
                const selected = answers[activeQuestion.id] === option.value;
                return <button className={cn("preference-card", selected && "preference-card--active")} key={option.value} onClick={() => setAnswers((current) => ({ ...current, [activeQuestion.id]: option.value }))} type="button"><span className="preference-copy-block"><strong>{option.label}</strong><em>{option.description}</em></span><span className={cn("preference-radio", selected && "preference-radio--active")}>{selected ? <Check size={12} /> : null}</span></button>;
              })}
            </div>
            <button className={cn("auth-primary preference-next", canContinue && "auth-primary--enabled")} disabled={!canContinue} onClick={() => setStep(step + 1)} type="button">{step === preferenceSteps.length ? "Finish preferences" : "Next"}</button>
          </section>
        ) : (
          <section className="setup-saved-screen">
            <article className="success-card booking-success-card"><div className="success-icon-shell"><div className="success-icon-core"><Check size={30} /></div></div><div className="success-copy booking-success-copy"><h1>ORIN is ready.</h1><p>Your profile and room defaults are initialized.</p></div></article>
            <article className="preferences-summary-card">
              <strong>Room defaults</strong>
              <div className="preferences-summary-list">
                <div className="preferences-summary-row"><span>Temperature</span><b>{initialRoomPrefs.temp}°C</b></div>
                <div className="preferences-summary-row"><span>Lighting</span><b>{initialRoomPrefs.lighting}</b></div>
                <div className="preferences-summary-row"><span>Brightness</span><b>{initialRoomPrefs.brightness}%</b></div>
                <div className="preferences-summary-row"><span>Music</span><b>{initialRoomPrefs.music || "Off"}</b></div>
              </div>
            </article>
            <button className="auth-primary auth-primary--enabled verified-primary" onClick={onComplete} type="button">Enter ORIN</button>
          </section>
        )}
      </div>
    </main>
  );
}

function HomeScreen({ guestName, persona, temp, brightness, lighting, music, onChat, onRoom, onBook }: { guestName: string; persona: string; temp: number; brightness: number; lighting: string; music: string; onChat: () => void; onRoom: () => void; onBook: () => void }) {
  return <section className="app-home app-home--figma"><div className="post-home-greeting app-home-greeting"><div><p>Welcome back,</p><strong>{guestName}</strong><span className="app-home-subtitle">Hotel Bellweather, Suite 1234</span></div><span className="chat-status chat-status--home">ORIN ACTIVE</span></div><article className="home-hero-card"><div className="home-hero-copy"><span className="home-hero-kicker">Long-term memory</span><strong>Everything is tuned to your profile</strong><p>{persona}</p></div><div className="home-hero-orb"><div className="home-hero-orb-core" /></div></article><div className="quick-card-list quick-card-list--home">{[{ label: "Music", value: music, icon: Music }, { label: "Lights", value: `${lighting} / ${brightness}%`, icon: Lightbulb }, { label: "Temperature", value: `${temp}°C`, icon: Thermometer }].map((card) => <article className="quick-card quick-card--home" key={card.label}><div className="quick-card-icon quick-card-icon--home"><card.icon size={18} /></div><div className="quick-card-copy"><span>{card.label}</span><strong>{card.value}</strong></div></article>)}</div><div className="home-actions home-actions--figma"><button className="setup-button setup-button--figma home-primary" onClick={onChat} type="button"><span className="home-cta-inner"><Mic size={18} /><span>Talk to ORIN</span></span></button><button className="auth-secondary auth-secondary--figma" onClick={onRoom} type="button">Room control</button><button className="auth-secondary auth-secondary--figma" onClick={onBook} type="button">Curate stays</button></div></section>;
}

function ChatScreen({ messages, input, setInput, isBusy, onSend, onRecommend, onBack, onSelectStay, onConfirm, paymentMethod, setPaymentMethod, approved, onFinalize, isFinalizing, messagesEndRef }: { messages: ChatMessage[]; input: string; setInput: (value: string) => void; isBusy: boolean; onSend: () => void; onRecommend: () => void; onBack: () => void; onSelectStay: (option: CuratedStayOption) => void; onConfirm: () => void; paymentMethod: PaymentMethod | null; setPaymentMethod: (method: PaymentMethod) => void; approved: boolean; onFinalize: () => void; isFinalizing: boolean; messagesEndRef: React.RefObject<HTMLDivElement | null> }) {
  const hasBookingContext = messages.some((message) => message.card?.type === "stays" || message.card?.type === "confirmation" || message.card?.type === "payment");
  const statusLabel = isBusy ? "Listening" : hasBookingContext ? "Booking Active" : "Active";

  return (
    <section className="booking-chat live-chat-screen">
      <header className="chat-header">
        <button className="back-button" onClick={onBack} type="button" aria-label="Back to home">
          <ChevronLeft size={18} />
        </button>
        <div className="chat-header-copy">
          <strong>ORIN</strong>
          <span className={cn("chat-status", isBusy && "chat-status--listening", hasBookingContext && !isBusy && "chat-status--booking")}>{statusLabel}</span>
        </div>
        <button className="back-button chat-header-action" onClick={onRecommend} type="button">Stays</button>
      </header>

      <div className="chat-thread">
        {messages.map((message) => <ChatMessageView key={message.id} message={message} onSelectStay={onSelectStay} onConfirm={onConfirm} paymentMethod={paymentMethod} setPaymentMethod={setPaymentMethod} approved={approved} onFinalize={onFinalize} isFinalizing={isFinalizing} />)}
        {isBusy ? <article className="orin-message"><small>○ Orin</small><p>Working on that...</p></article> : null}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-composer">
        <div className="composer-input-shell">
          <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSend(); }} placeholder="Tell ORIN..." />
        </div>
        <button className="mic-button mic-button--voice" type="button" aria-label="Use microphone"><Mic size={18} /></button>
        <button className="mic-button mic-button--send" onClick={onSend} disabled={!input.trim()} type="button" aria-label="Send message"><Send size={18} /></button>
      </div>

      <div className="prompt-strip">
        <button onClick={onRecommend} type="button">Recommend stays</button>
        <button onClick={() => setInput("Dim the lights and set temperature to 22 degrees")} type="button">Room mood</button>
      </div>
    </section>
  );
}

function ChatMessageView({ message, onSelectStay, onConfirm, paymentMethod, setPaymentMethod, approved, onFinalize, isFinalizing }: { message: ChatMessage; onSelectStay: (option: CuratedStayOption) => void; onConfirm: () => void; paymentMethod: PaymentMethod | null; setPaymentMethod: (method: PaymentMethod) => void; approved: boolean; onFinalize: () => void; isFinalizing: boolean }) {
  if (message.card?.type === "stays") return <article className="orin-message orin-card-message"><small>○ Orin</small><StayCards options={message.card.options} onSelect={onSelectStay} /></article>;
  if (message.card?.type === "confirmation") return <article className="orin-message orin-flow-message"><small>○ Orin</small><BookingConfirmation option={message.card.option} summary={message.card.summary} onConfirm={onConfirm} /></article>;
  if (message.card?.type === "payment") return <article className="orin-message orin-flow-message"><small>○ Orin</small><PaymentSummary summary={message.card.summary} paymentMethod={paymentMethod} setPaymentMethod={setPaymentMethod} approved={message.card.approved || approved} onFinalize={onFinalize} isFinalizing={isFinalizing} /></article>;
  return message.role === "user" ? <div className="user-bubble"><p>{message.text}</p></div> : <article className="orin-message"><small>○ Orin</small><p>{renderTextWithLinks(message.text ?? "")}</p></article>;
}

function BookingScreen({ messages, isLoading, selectedStay, summary, paymentMethod, setPaymentMethod, approved, onSearch, onSelect, onConfirm, onFinalize, isFinalizing }: { messages: ChatMessage[]; isLoading: boolean; selectedStay: CuratedStayOption | null; summary: BookingSummary | null; paymentMethod: PaymentMethod | null; setPaymentMethod: (method: PaymentMethod) => void; approved: boolean; onSearch: () => void; onSelect: (option: CuratedStayOption) => void; onConfirm: () => void; onFinalize: () => void; isFinalizing: boolean }) {
  const stayCards = messages.findLast((message) => message.card?.type === "stays")?.card;
  return <section className="booking-results"><div className="results-copy"><h1>Here are stays that match your style</h1><p>Choose a stay and ORIN will prepare the booking details for you in chat.</p></div><button className="auth-secondary refine-button" onClick={onSearch} disabled={isLoading} type="button">{isLoading ? "Curating stays..." : "Search curated stays"}</button>{isLoading && !stayCards ? <article className="curated-loading-card"><div className="spinner" /><strong>ORIN is matching stays to your profile.</strong><span>This usually takes a moment.</span></article> : null}{stayCards?.type === "stays" ? <StayCards options={stayCards.options} onSelect={onSelect} /> : null}{selectedStay && summary ? <BookingConfirmation option={selectedStay} summary={summary} onConfirm={onConfirm} passive /> : null}</section>;
}

function StayCards({ options, onSelect }: { options: CuratedStayOption[]; onSelect: (option: CuratedStayOption) => void }) {
  return <div className="results-carousel">{options.slice(0, 3).map((option) => <article className="hotel-card" key={option.hotelId}><img alt={option.hotelName} src={option.image} /><div className="hotel-card-body"><h2>{option.hotelName}</h2><div className="hotel-meta-row"><p><MapPin size={12} /> {option.location}</p><span>{formatCurrency(option.price, option.currency)}</span></div><p className="hotel-reason">Why ORIN picked this: {option.reasonForRecommendation}</p><div className="results-tags">{option.tags.map((tag) => <span key={`${option.hotelId}-${tag}`}>{tag}</span>)}</div><button className="auth-primary auth-primary--enabled hotel-book" onClick={() => onSelect(option)} type="button">Book Now <span className="button-arrow">→</span></button></div></article>)}</div>;
}

function BookingConfirmation({ option, summary, onConfirm, passive }: { option: CuratedStayOption; summary: BookingSummary; onConfirm: () => void; passive?: boolean }) {
  return <article className="summary-card"><span>BOOKING SUMMARY</span><p>{option.hotelName} • {summary.checkInDate} - {summary.checkOutDate} • {summary.guests} guests</p>{!passive ? <div className="summary-actions"><button className="summary-confirm" onClick={onConfirm} type="button">Confirm details</button></div> : null}</article>;
}

function PaymentSummary({ summary, paymentMethod, setPaymentMethod, approved, onFinalize, isFinalizing, passive }: { summary: BookingSummary; paymentMethod: PaymentMethod | null; setPaymentMethod: (method: PaymentMethod) => void; approved?: boolean; onFinalize: () => void; isFinalizing?: boolean; passive?: boolean }) {
  return <article className="payment-summary-card"><h2>PAYMENT SUMMARY</h2>{summary.priceLines.map((line) => <div className="payment-line" key={line.label}><span>{line.label}</span><b>{line.lineType === "discount" ? "-" : ""}{formatCurrency(Math.abs(line.amount), summary.currency)}</b></div>)}<div className="payment-total"><span>Total</span><b>{formatCurrency(summary.payableTotal, summary.currency)}</b></div><div className="setup-panel"><div className="setup-avatar"><Ticket size={18} /></div><div><span>ORIN POINTS</span><p>Redeeming {summary.pointsRedemption.pointsUsed} points for {formatCurrency(summary.pointsRedemption.discountAmount, summary.currency)} off</p></div></div>{!passive ? <><div className="payment-method-grid"><button className={cn("payment-method", paymentMethod === "pusd" && "payment-method--active")} onClick={() => setPaymentMethod("pusd")} type="button">$PUSD</button><button className={cn("payment-method", paymentMethod === "mastercard" && "payment-method--active")} onClick={() => setPaymentMethod("mastercard")} type="button">Mastercard</button></div><button className="auth-primary auth-primary--enabled payment-button" disabled={!paymentMethod || approved || isFinalizing} onClick={onFinalize} type="button">{approved ? "Booking approved" : isFinalizing ? "Finalizing..." : paymentMethod ? "Final approval" : "Select payment method"}</button></> : null}</article>;
}

function RoomScreen({ temp, setTemp, brightness, setBrightness, lighting, setLighting, music, musicUrl, setMusic, musicOn, setMusicOn, isSaving, onSave }: { temp: number; setTemp: (value: number) => void; brightness: number; setBrightness: (value: number) => void; lighting: LightingMode; setLighting: (value: LightingMode) => void; music: string; musicUrl: string; setMusic: (value: string) => void; musicOn: boolean; setMusicOn: (value: boolean) => void; isSaving: boolean; onSave: () => void }) {
  return <section className="room-screen"><header className="room-header"><div className="room-header-copy"><strong>Room Control</strong><span>Live canonical state</span></div><button className="bookmark-button" type="button"><Zap size={18} /></button></header><div className="preset-strip">{[{ label: "Relax", temp: 22, brightness: 35, lighting: "warm" as LightingMode, music: "Jazz" }, { label: "Focus", temp: 21, brightness: 85, lighting: "cold" as LightingMode, music: "Lo-Fi" }, { label: "Sleep", temp: 19, brightness: 10, lighting: "ambient" as LightingMode, music: "Ambient" }].map((preset) => <button className="preset-pill" key={preset.label} onClick={() => { setTemp(preset.temp); setBrightness(preset.brightness); setLighting(preset.lighting); setMusic(preset.music); setMusicOn(true); }} type="button">{preset.label}</button>)}</div><ControlPanel label="TEMPERATURE" value={temp} min={16} max={30} suffix="°C" onChange={setTemp} /><ControlPanel label="LIGHTS" value={brightness} min={0} max={100} suffix="%" onChange={setBrightness} /><article className="music-panel"><div className="music-panel-header"><strong>♫ MUSIC</strong><span>{musicOn ? music : "Off"}</span></div>{musicOn && musicUrl ? <audio className="music-url-player" controls src={musicUrl}>Your browser does not support audio playback.</audio> : null}<div className="music-options">{["Jazz", "Lo-Fi", "Ambient", "Classical"].map((option) => <button className={cn("music-option", musicOn && music === option && "music-option--active")} key={option} onClick={() => { setMusic(option); setMusicOn(true); }} type="button">{option}</button>)}<button className={cn("music-option", !musicOn && "music-option--active")} onClick={() => setMusicOn(false)} type="button">Off</button></div></article><button className="auth-primary auth-primary--enabled room-save" onClick={onSave} disabled={isSaving} type="button">{isSaving ? "Syncing..." : "Save My Setup"} <span className="button-arrow">→</span></button></section>;
}

function ControlPanel({ label, value, min, max, suffix, onChange }: { label: string; value: number; min: number; max: number; suffix: string; onChange: (value: number) => void }) {
  const percentage = ((value - min) / (max - min)) * 100;
  return <article className="control-panel"><div className="control-top"><strong>{label}</strong><b>{value}{suffix}</b></div><div className="slider-shell"><div className="slider-track" /><div className="slider-progress" style={{ width: `${percentage}%` }} /><input className="slider-input" max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} type="range" value={value} /></div><div className="control-range"><span>{min}{suffix}</span><span>{max}{suffix}</span></div></article>;
}

function ProfileScreen({ guestName, walletLabel, profileImage, persona, points, temp, brightness, lighting, music, onAvatarChange, onAirdropPusd, isAirdroppingPusd }: { guestName: string; walletLabel: string; profileImage: string | null; persona: string; points: number; temp: number; brightness: number; lighting: string; music: string; onAvatarChange: (event: React.ChangeEvent<HTMLInputElement>) => void; onAirdropPusd: () => void; isAirdroppingPusd: boolean }) {
  return <section className="mobile-profile mobile-profile--post-onboarding"><article className="identity-card"><div className="identity-top"><div className="identity-avatar">{profileImage ? <Image src={profileImage} alt="Profile" fill className="object-cover" unoptimized /> : <UserRound />}</div><div className="identity-copy"><strong>{guestName}</strong><span>{walletLabel}</span><p>Member since May 2026</p></div><label className="verified-badge"><Camera size={13} /> Photo<input className="hidden" type="file" accept="image/*" onChange={onAvatarChange} /></label></div><div className="identity-stats"><span>ORIN Points</span><strong className="identity-points">{points} pts</strong></div><div className="identity-meter"><div /></div><div className="identity-foot"><span>{persona}</span></div></article><div className="profile-section"><h2>Saved Preferences</h2><div className="profile-list-card">{[{ label: `Climate ${temp}°C`, icon: Thermometer }, { label: `Lighting ${lighting} / ${brightness}%`, icon: Lightbulb }, { label: `Music ${music}`, icon: Music }].map((item) => <div className="profile-row" key={item.label}><span className="profile-row-icon"><item.icon size={18} /></span><strong>{item.label}</strong></div>)}</div></div><div className="profile-section"><h2>Wallet</h2><div className="profile-wallet-card"><span className="profile-row-icon"><Wallet size={18} /></span><div className="profile-wallet-copy"><strong>Connected Wallet</strong><small>{walletLabel}</small></div><span className="wallet-ok"><Check size={16} /></span></div><button className="auth-primary auth-primary--enabled pusd-airdrop-button" onClick={onAirdropPusd} disabled={isAirdroppingPusd} type="button">{isAirdroppingPusd ? "Airdropping..." : "Airdrop $PUSD"}</button></div></section>;
}

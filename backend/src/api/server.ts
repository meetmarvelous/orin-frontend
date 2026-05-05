import Fastify from "fastify";
import cors, { type FastifyCorsOptions } from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { createClient } from "@deepgram/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transfer, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fastifyStatic from "@fastify/static";
import path from "path";
import { randomUUID } from "node:crypto";
import { validateEnvOrExit } from "../config/validate_env";
import { getEnv, getAllowedOrigins } from "../config/env";
import { stateProvider } from "../state";
import { createRequestLogger, logger } from "../shared/logger";
import { GuestContext, LlmError, OrinAgent } from "../ai_agent";
import { generateSha256Hash } from "../shared/hash";
import { getFeePayerKeypair, relayTransaction } from "../shared/feePayer";
import { RPC_ENDPOINT } from "../shared/constants";
import { FAST_INTENTS } from "../config/fast_intents";
import { getGuestProfile, updateGuestAvatar, updateGuestPersona } from "../state/FirestoreService";
import {
  searchStays,
  createQuote,
  createBooking,
  getBooking,
  cancelBooking,
  curatedSearch,
  DuffelError,
} from "../duffel/duffel.service";
import type { DuffelSearchRequest, DuffelBookingRequest, CuratedSearchRequest } from "../duffel/duffel.types";

/**
 * ORIN Production API Gateway
 * -------------------------------------------------------------
 * Receives voice-command payloads from upstream channels
 * (mobile app, web app, voice assistant webhook) and stages
 * them in persistent state for hash-lock verification by listener.
 */

validateEnvOrExit();
const env = getEnv();

// Eagerly validate + load the fee-payer keypair at startup.
// Fails fast if FEE_PAYER_PRIVATE_KEY is misconfigured rather than at relay time.
getFeePayerKeypair();

// Shared RPC connection used by the relay endpoint
const rpcConnection = new Connection(RPC_ENDPOINT, "confirmed");

const agent = new OrinAgent();

type VoiceCommandBody = {
  guestPda: string;
  userInput: string;
  guestContext: GuestContext;
};

type VoiceTestBody = {
  userInput: string;
  guestContext?: GuestContext;
  deviceId?: string;
};

type VoiceFastCached = {
  text: string;
  audioBase64: string;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// CORS ? Production-grade configuration
// ---------------------------------------------------------------------------
// ALLOWED_ORIGIN supports a comma-separated list of origins so this config
// works identically in local dev and production without code changes.
// The origin validator uses a Set for O(1) lookup regardless of list size.
// ---------------------------------------------------------------------------
const allowedOrigins = new Set(getAllowedOrigins());

/** HTTP methods exposed on every route */
const ALLOWED_METHODS: string[] = ["GET", "POST", "OPTIONS"];

/**
 * Request headers the client is permitted to send.
 * Must explicitly list every non-CORS-safe header the frontend uses.
 */
const ALLOWED_HEADERS: string[] = [
  "Content-Type",
  "Authorization",
  "X-API-KEY",
  "X-Request-ID",
];

/**
 * Response headers the browser is allowed to read from JavaScript.
 * Expose only what the frontend actually needs to inspect.
 */
const EXPOSED_HEADERS: string[] = ["X-Request-ID"];

const app = Fastify({ logger: false });

// ---------------------------------------------------------------------------
// Static file serving — music library
// ---------------------------------------------------------------------------
// Serves backend/public/ at the root URL.
// e.g. GET /music/Luxe%20Jazz%20Classics/track-1.mp3
app.register(fastifyStatic, {
  root: path.join(__dirname, "../../public"),
  prefix: "/",
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");
  },
});

// ---------------------------------------------------------------------------
// Production Logging Interceptors
// ---------------------------------------------------------------------------
// Injects a per-request logger into Fastify and logs detailed payload info.
// This provides complete visibility into frontend-backend data exchange while
// automatically skipping heavy binary/base64 log pollution.
// ---------------------------------------------------------------------------
declare module "fastify" {
  interface FastifyRequest {
    reqLogger: ReturnType<typeof createRequestLogger>;
  }
}

app.addHook("onRequest", async (request, reply) => {
  // 1. Inject a context-aware logger early in the request lifecycle
  request.reqLogger = createRequestLogger(request.headers["x-request-id"] as string | undefined);
});

app.addHook("preHandler", async (request, reply) => {
  // 2. Log exactly what the frontend sends (the raw Request Body)
  if (request.url.includes("/transcribe") || request.url.includes("/stt-stream")) {
    request.reqLogger.info({ method: request.method, url: request.url }, "==> [FRONTEND -> BACKEND] API Request (Multipart/Stream omitted)");
  } else {
    request.reqLogger.info({ 
      method: request.method, 
      url: request.url, 
      body: request.body 
    }, "==> [FRONTEND -> BACKEND] API Request");
  }
});

app.addHook("onSend", async (request, reply, payload) => {
  // 3. Log exactly what the backend returns to the frontend (the Response Body)
  // Masking large base64 outputs to prevent log flooding
  let safePayload = payload;
  try {
    if (typeof payload === "string" && payload.startsWith("{")) {
      const parsed = JSON.parse(payload);
      if (parsed.audioBase64) parsed.audioBase64 = "[TRUNCATED_AUDIO_BASE64]";
      if (parsed.transaction) parsed.transaction = "[TRUNCATED_TX_BASE64]";
      safePayload = parsed;
    }
  } catch (e) {
    // If parsing fails, fall back to string payload
  }

  request.reqLogger.info({ 
    method: request.method, 
    url: request.url, 
    statusCode: reply.statusCode,
    response: safePayload
  }, "<== [BACKEND -> FRONTEND] API Response");
});

const corsOptions: FastifyCorsOptions = {
  /**
   * Dynamic origin validator.
   * Returns `true` to echo the origin back (required for credentialed requests);
   * returns `false` to reject. Falls back to `true` for server-to-server requests
   * that carry no Origin header (e.g. curl health checks, Railway probe).
   */
  origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
    // Allow server-to-server requests that carry no Origin header (e.g. curl, health checks).
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' is not permitted.`), false);
  },
  methods: ALLOWED_METHODS,
  allowedHeaders: ALLOWED_HEADERS,
  exposedHeaders: EXPOSED_HEADERS,
  credentials: true,              // Required if the frontend ever sends cookies / auth headers.
  maxAge: 86_400,                 // Cache preflight for 24 h ? eliminates per-request OPTIONS round-trips.
  preflight: true,                // Fastify handles OPTIONS automatically.
  strictPreflight: false,         // Be lenient: non-preflight OPTIONS still succeed.
};

app.register(cors, corsOptions);
// Replaces Express 'multer.memoryStorage()' with Fastify's high-speed equivalent
app.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for audio uploads
  },
});
app.register(websocket);

// ---------------------------------------------------------------------------
// Fast voice response cache
// ---------------------------------------------------------------------------
// The purpose is to keep TTS under sub-second latency for frequent commands.
// We cache (a) a short ACK and (b) full audio for fast intents.
// This avoids repeated Groq + Deepgram calls for repeated user requests.
// ---------------------------------------------------------------------------
const VOICE_CACHE_TTL_MS = 10 * 60 * 1000;
const TTS_CACHE_TTL_MS = 10 * 60 * 1000;
const ACK_VARIATIONS = [
  "Got it, processing your request now.",
  "Understood, I am on it.",
  "Certainly. Handling that for you immediately.",
  "Confirmed. I will take care of it right away.",
  "Right away. Processing your command now."
];
const voiceCache = new Map<string, VoiceFastCached>();
const ttsCache = new Map<string, VoiceFastCached>();

function normalizeInput(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildCacheKey(userInput: string, guestContext: GuestContext): string {
  return `${normalizeInput(userInput)}::${guestContext.name.toLowerCase()}::${guestContext.loyaltyPoints}`;
}

function getVoiceCache(key: string): VoiceFastCached | null {
  const hit = voiceCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.createdAt > VOICE_CACHE_TTL_MS) {
    voiceCache.delete(key);
    return null;
  }
  return hit;
}

function setVoiceCache(key: string, value: VoiceFastCached): void {
  voiceCache.set(key, value);
}

function getTtsCache(key: string): VoiceFastCached | null {
  const hit = ttsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.createdAt > TTS_CACHE_TTL_MS) {
    ttsCache.delete(key);
    return null;
  }
  return hit;
}

function setTtsCache(key: string, value: VoiceFastCached): void {
  ttsCache.set(key, value);
}

function ttsKey(text: string): string {
  return normalizeInput(text);
}

function findFastIntentReply(userInput: string): string | null {
  const text = normalizeInput(userInput);
  const intent = FAST_INTENTS.find((it) => it.keys.some((k) => text.includes(k)));
  return intent?.reply ?? null;
}

async function prewarmAckOnly(): Promise<void> {
  try {
    for (let i = 0; i < ACK_VARIATIONS.length; i++) {
      const text = ACK_VARIATIONS[i];
      const cacheKey = `ack::${i}`;
      if (!voiceCache.has(cacheKey)) {
        const ackAudio = await agent.speak(text);
        setVoiceCache(cacheKey, {
          text,
          audioBase64: ackAudio.toString("base64"),
          createdAt: Date.now(),
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: message }, "prewarm_ack_variations_failed");
  }
}

async function prewarmServices(): Promise<void> {
  const warmContext: GuestContext = {
    name: "Warmup",
    loyaltyPoints: 0,
    history: ["boot"],
  };

  try {
    const text = await agent.generateQuickVoiceReply("Say: ORIN online.", warmContext, {
      timeoutMs: env.GROQ_TIMEOUT_BG_MS,
    });
    await agent.speak(text || "ORIN online.");

    for (const intent of FAST_INTENTS) {
      const key = `intent::${intent.keys[0]}`;
      if (!voiceCache.has(key)) {
        const audio = await agent.speak(intent.reply);
        setVoiceCache(key, {
          text: intent.reply,
          audioBase64: audio.toString("base64"),
          createdAt: Date.now(),
        });
        await new Promise(resolve => setTimeout(resolve, 500)); 
      }
    }

    logger.info({ preloaded_intents: FAST_INTENTS.length }, "prewarm_complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: message }, "prewarm_failed_non_blocking");
  }
}

function createDeepgramSocket(): WebSocket {
  const url =
    `wss://api.deepgram.com/v1/listen?model=${encodeURIComponent(env.DEEPGRAM_STT_MODEL)}&language=en&interim_results=true&endpointing=300&smart_format=true`;
  return new WebSocket(url, {
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
    },
  });
}

app.post<{ Body: VoiceCommandBody }>("/api/v1/voice-command", async (request, reply) => {
  const reqLogger = request.reqLogger;

  // Production Auth Check
  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_api_access");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  const { guestPda, userInput, guestContext } = request.body ?? ({} as VoiceCommandBody);

  if (!guestPda || !userInput || !guestContext) {
    reqLogger.error("invalid_request_body");
    return reply.status(400).send({
      error: "Invalid body. Required: guestPda, userInput, guestContext",
    });
  }

  try {
    // Inject persona from Firestore if available
    const profileData = await getGuestProfile(guestPda, 5);
    if (profileData && profileData.profile.persona) {
      guestContext.persona = profileData.profile.persona;
    }
    const recentPreferences = profileData?.preferences || [];

    // ?? Resolve the AI intent right now during the HTTPS request.
    // Because the blockchain Hash-Lock demands the user sign the EXACT payload Hash,
    // we cannot defer AI to the listener. The frontend MUST have the AI's hash to mint the TX.
    const aiResult = await agent.processCommand(userInput, guestContext);
    const aiHashHex = aiResult.hash.toString("hex");

    // Determine if the parsed command actually mutates the room into a valid state. 
    // We now rely on the AI's intelligent 'action_required' boolean flag.
    const requiresSignature = Boolean(aiResult.payload.action_required);

    // Stage it exactly like a manual bypass payload so the listener just verifies and executes
    await stateProvider.setDirectPayload(aiHashHex, aiResult.payload);
    reqLogger.info({ guest_pda: guestPda, hash: aiHashHex }, "ai_command_resolved_and_staged");

    return reply.status(200).send({
      status: "accepted",
      guestPda,
      hash: aiHashHex, // Send this critical piece to the frontend!
      aiResult: aiResult.payload, // Returned so frontend can see/preview the LLM's structured output
      requiresSignature,
      message: "Command parsed by AI. Awaiting on-chain hash-lock validation.",
    });
  } catch (error: any) {
    reqLogger.error({ error: error.message }, "ai_processing_error");
    return reply.status(500).send({ error: "Voice AI processing failed", details: error.message });
  } finally {
    // Asynchronously generate and update persona
    if (guestPda && userInput) {
      setTimeout(async () => {
        try {
          const profileData = await getGuestProfile(guestPda, 5);
          const history = profileData?.preferences || [];
          const generatedPersona = await agent.generateGuestPersona(
            guestContext,
            history,
            userInput,
            "Handled via /api/v1/voice-command"
          );
          if (generatedPersona) {
            await updateGuestPersona(guestPda, generatedPersona);
          }
        } catch (err) {
          reqLogger.error({ err }, "async_persona_generation_failed");
        }
      }, 0);
    }
  }
});

/**
 * DIRECT BYPASS ENDPOINT (Web2.5 High-Speed Channel)
 * -------------------------------------------------------------
 * For manual slider adjustments on the frontend that do not require
 * AI inference. Receives explicit JSON, computes the canonical hash,
 * and caches it directly in Redis awaiting Solana confirmation.
 */
interface ManualPreferencesBody {
  guestPda: string;
  /**
   * Full preferences payload. Must include:
   *   - brightness: number (0–100, required)
   *   - music: string (track name or "" for no music, optional defaults to "")
   *   - lighting: "warm" | "cold" | "ambient"
   *   - temp: number
   */
  preferences: Record<string, unknown>;
  guestContext?: GuestContext;
}

app.post<{ Body: ManualPreferencesBody }>("/api/v1/preferences", async (request, reply) => {
  const reqLogger = request.reqLogger;

  // Production Auth Check: Protect memory exhaust attacks from unauthorized payloads
  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_bypass_access");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  const { guestPda, preferences, guestContext } = request.body || {};

  // Validate required fields
  if (!guestPda || !preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    reqLogger.error("invalid_preferences_body");
    return reply.status(400).send({ error: "Invalid body. Required: guestPda and preferences object." });
  }

  // brightness is required inside preferences
  const brightness = preferences.brightness;
  if (typeof brightness !== "number" || (brightness as number) < 0 || (brightness as number) > 100) {
    return reply.status(400).send({
      error: "Invalid body. preferences.brightness is required and must be a number between 0 and 100.",
    });
  }

  // music defaults to "" if not provided (no music)
  if (typeof preferences.music !== "string") {
    preferences.music = "";
  }

  // Hash ONLY the preferences canonical body — matching the AI agent output schema
  const hashHex = generateSha256Hash(preferences).toString("hex");

  await stateProvider.setDirectPayload(hashHex, preferences);
  reqLogger.info({ guest_pda: guestPda, hash: hashHex, brightness, music: preferences.music }, "direct_payload_stored");

  return reply.status(200).send({
    status: "success",
    info: "Payload staged in Redis cache bypassing AI. Awaiting Solana Hash Verification signal.",
    hash: hashHex,
  });
});

/**
 * VOICE TRANSCRIPTION ENDPOINT (AI Interface Channel)
 * -------------------------------------------------------------
 * Takes incoming audio data (multipart/form-data), transcribes it
 * using Deepgram Nova-2 via their in-memory buffers (zero disk I/O),
 * and returns the structured LLM-ready text string.
 */
app.post("/api/v1/transcribe", async (request, reply) => {
  const reqLogger = request.reqLogger;

  // Production Auth Check: Protect costly upstream Deepgram tokens
  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_transcription_access");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  try {
    const data = await request.file();
    if (!data) {
      reqLogger.error("no_audio_file");
      return reply.status(400).send({ error: "No audio file provided in the payload." });
    }

    const audioBuffer = await data.toBuffer();

    const deepgramApiKey = env.DEEPGRAM_API_KEY;
    if (!deepgramApiKey) {
      reqLogger.error("deepgram_key_missing");
      return reply.status(500).send({ error: "Internal Server Error. Deepgram API configuration missing." });
    }

    const deepgram = createClient(deepgramApiKey);

    // Deepgram allows sending pure Buffers natively if we provide the exact configuration
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: env.DEEPGRAM_STT_MODEL,
        smart_format: true,
      }
    );

    if (error) {
      reqLogger.error({ error }, "deepgram_api_failure");
      return reply.status(500).send({ error: "Transcription failed.", details: error.message });
    }

    // Safely extract the primary transcript result
    const transcript = result?.results?.channels[0]?.alternatives[0]?.transcript || "";

    reqLogger.info({ bytes: audioBuffer.byteLength, transcript_length: transcript.length }, "audio_transcribed");
    return reply.status(200).send({
      status: "success",
      text: transcript,
    });
  } catch (error: any) {
    reqLogger.error({ error: error.message }, "transcription_endpoint_error");
    return reply.status(500).send({
      error: "Internal server error during transcription.",
      details: error.message,
    });
  }
});

/**
 * DIRECT TEXT-TO-SPEECH (TTS) ENDPOINT
 * -------------------------------------------------------------
 * Utility endpoint to convert arbitrary text into high-fidelity audio blobs.
 * Used for dynamic UI announcements, property welcomes, or system notifications.
 * Bypasses AI intent detection to provide zero-overhead voice conversion.
 */
interface TtsBody {
  text: string;
  voiceModel?: string;
}

app.post<{ Body: TtsBody }>("/api/v1/tts", async (request, reply) => {
  const reqLogger = request.reqLogger;
  const t0 = Date.now();

  // 1. Production Security Gate: Verify API Key from headers
  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_tts_access_attempt");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  const { text} = request.body;

  // 2. Input Integrity Validation
  if (!text || !text.trim()) {
    return reply.status(400).send({ error: "Required field 'text' is missing or empty." });
  }

  try {
    reqLogger.info({ text_length: text.length }, "tts_conversion_started");

    // 3. Invoke the Federated Router Speak method (Edge -> Cartesia -> Deepgram)
    const audioBuffer = await agent.speak(text);
    
    const latency = Date.now() - t0;
    reqLogger.info({ latency_ms: latency }, "tts_conversion_success");

    // 4. Return standard response payload with audio as Base64 string
    return reply.send({
      status: "ok",
      mimeType: "audio/mpeg",
      audioBase64: audioBuffer.toString("base64"),
      text: text,
      latencyMs: latency
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown TTS failure";
    reqLogger.error({ err: message }, "tts_conversion_critical_error");

    return reply.status(500).send({
      error: "TTS Generation failed",
      details: message
    });
  }
});

/**
 * DEVICE STATUS ENDPOINT
 * -------------------------------------------------------------
 *  * Returns a real-time snapshot of the current physical room state as
 * maintained by the MQTT Device State Store (mqtt_mock.ts).
 *
 * The snapshot is updated synchronously every time the Solana listener
 * validates a new hash-lock and publishes to the MQTT broker.
 * No extra database round-trip is required — this is a pure in-memory read.
 *
 * Response schema:
 *   roomId        — The logical room identifier ("room101" in MVP)
 *   hue           — Philips Hue state: { color, brightness, on }
 *   nest          — Google Nest state: { temp, mode }
 *   lastUpdatedAt — ISO-8601 timestamp of the last confirmed update
 *   lastGuestPda  — Solana PDA of the guest who triggered the last change
 *
 * The roomId is derived from the guestPda (first 4 chars), matching
 * the format used by listener.ts when writing to Redis.
 *
 * Query Parameters:
 *   guestPda  (recommended) — The guest's Solana PDA. roomId will be
 *             auto-derived as "Room_<first4>".
 *   roomId    (override)    — Pass an explicit roomId if needed.
 *
 * Example:
 *   GET /api/v1/device/status?guestPda=8yiszuCmH9...
 *   GET /api/v1/device/status?roomId=Room_8yis
 */
app.get<{ Querystring: { guestPda?: string; roomId?: string } }>(
  "/api/v1/device/status",
  async (request, reply) => {
    const reqLogger = request.reqLogger;

    // Production Security Gate
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== env.API_KEY) {
      reqLogger.warn({ origin: request.headers.origin }, "unauthorized_device_status_access");
      return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
    }

    const { guestPda, roomId: roomIdParam } = request.query;

    // Derive roomId: explicit override > auto-derive from guestPda > reject
    let roomId: string;
    if (roomIdParam) {
      roomId = roomIdParam;
    } else if (guestPda) {
      // Must match listener.ts: "Room_" + guestPda.slice(0, 4)
      roomId = `Room_${guestPda.slice(0, 4)}`;
    } else {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Query parameter 'guestPda' or 'roomId' is required.",
      });
    }

    try {
      const snapshot = await stateProvider.getDeviceState(roomId);
      const result = snapshot ?? {
        roomId,
        hue: { color: "#FFFFFF", brightness: 80, on: true },
        nest: { temp: 22, mode: "AUTO" },
        music: "",
        lastUpdatedAt: null,
        lastGuestPda: null,
      };

      reqLogger.info({ roomId, lastUpdatedAt: result.lastUpdatedAt }, "device_status_queried");
      return reply.send({ status: "ok", device: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      reqLogger.error({ err: message }, "device_status_read_error");
      return reply.status(500).send({ error: "Failed to read device state", details: message });
    }
  }
);


/**
 * GUEST PROFILE ENDPOINT
 * -------------------------------------------------------------
 * Reads a guest's Firestore profile (guestPda, avatarUrl, createdAt, lastSeenAt)
 * and their N most recent preference sessions (lighting, hue, nest, music, etc.).
 *
 * This is the CRM/analytics layer — Redis serves real-time state, Firestore
 * serves historical preferences and identity data.
 *
 * Query Parameters:
 *   guestPda  (required) — The guest's Solana public key
 *   limit     (optional) — Max sessions to return, default 10, max 50
 *
 * Example:
 *   GET /api/v1/guest/profile?guestPda=7h6Q5TPy...
 *
 * TODO: Future implementation will include user signature verification.
 */
app.get<{ Querystring: { guestPda?: string; limit?: string } }>(
  "/api/v1/guest/profile",
  async (request, reply) => {
    const reqLogger = request.reqLogger;

    // Security Gate
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== env.API_KEY) {
      reqLogger.warn({ origin: request.headers.origin }, "unauthorized_guest_profile_access");
      return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
    }

    const { guestPda, limit: limitStr } = request.query;
    if (!guestPda) {
      return reply.status(400).send({ error: "Query parameter 'guestPda' is required." });
    }

    // Clamp limit to a safe range
    const limit = Math.min(Math.max(parseInt(limitStr ?? "10", 10) || 10, 1), 50);

    try {
      const result = await getGuestProfile(guestPda, limit);

      if (!result) {
        return reply.status(404).send({
          error: "Guest not found",
          message: "No Firestore profile exists for this guestPda. Guest must complete at least one verified command first.",
        });
      }

      reqLogger.info(
        { guestPda, sessionsReturned: result.preferences.length },
        "guest_profile_queried"
      );

      return reply.send({
        status: "ok",
        guestPda,
        profile: result.profile,
        preferences: result.preferences,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      reqLogger.error({ guestPda, err: message }, "guest_profile_query_error");
      return reply.status(500).send({ error: "Failed to query guest profile", details: message });
    }
  }
);

/**
 * GUEST AVATAR UPDATE ENDPOINT
 * -------------------------------------------------------------
 * Updates the avatar URL for a specific guest in Firestore.
 *
 * Body Parameters:
 *   guestPda   (required) — The guest's Solana public key
 *   avatarUrl  (required) — The new avatar URL link
 *
 * Example:
 *   POST /api/v1/guest/avatar
 *   { "guestPda": "7h6Q...", "avatarUrl": "https://..." }
 *
 * TODO: Future implementation will include user signature verification.
 */
interface GuestAvatarBody {
  guestPda: string;
  avatarUrl: string;
}

app.post<{ Body: GuestAvatarBody }>(
  "/api/v1/guest/avatar_update",
  async (request, reply) => {
    const reqLogger = request.reqLogger;

    // Security Gate
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== env.API_KEY) {
      reqLogger.warn({ origin: request.headers.origin }, "unauthorized_guest_avatar_update_access");
      return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
    }

    const { guestPda, avatarUrl } = request.body;
    if (!guestPda || !avatarUrl) {
      return reply.status(400).send({ error: "Body parameters 'guestPda' and 'avatarUrl' are required." });
    }

    try {
      await updateGuestAvatar(guestPda, avatarUrl);

      reqLogger.info({ guestPda, avatarUrl }, "guest_avatar_update_processed");

      return reply.send({
        status: "ok",
        message: "Guest avatar updated successfully.",
        guestPda,
        avatarUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      reqLogger.error({ guestPda, err: message }, "guest_avatar_update_error");
      return reply.status(500).send({ error: "Failed to update guest avatar", details: message });
    }
  }
);


/**
 * VOICE FAST ENDPOINT (Low-latency voice reply)
 * -------------------------------------------------------------
 * Returns a cached or fast LLM response + TTS audio for quick replies.
 * This endpoint is additive (does not replace the core hash-lock flow).
 */
app.post<{ Body: VoiceTestBody }>("/api/v1/voice-fast", async (request, reply) => {
  const reqLogger = request.reqLogger;
  const t0 = Date.now();

  // Production Auth Check
  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_voice_fast_access");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  const { userInput, guestContext, deviceId } = request.body ?? ({} as VoiceTestBody);

  if (!userInput || !userInput.trim()) {
    return reply.status(400).send({ error: "userInput is required" });
  }

  const storedPrefs = deviceId ? await stateProvider.getUserPreferences(deviceId) : null;
  const effectiveGuestContext: GuestContext = guestContext ?? {
    name: storedPrefs?.name || "User",
    loyaltyPoints: storedPrefs?.loyaltyPoints ?? 0,
    history: storedPrefs?.history ?? [],
  };

  try {
    const cacheKey = buildCacheKey(userInput, effectiveGuestContext);
    const cached = getVoiceCache(cacheKey);
    if (cached) {
      const tHit = Date.now();
      reqLogger.info({ total_ms: tHit - t0 }, "voice_fast_cache_hit");
      return reply.send({
        status: "ok",
        mimeType: "audio/mpeg",
        audioBase64: cached.audioBase64,
        text: cached.text,
        latencyMs: { llm: 0, tts: 0, total: tHit - t0 },
        cached: true,
        ack: false,
      });
    }

    const fastReply = findFastIntentReply(userInput);
    if (fastReply) {
      const intentKey = FAST_INTENTS.find((it) => it.reply === fastReply)?.keys[0] ?? "intent";
      const prebuilt = getVoiceCache(`intent::${intentKey}`);

      if (prebuilt) {
        setVoiceCache(cacheKey, { ...prebuilt, createdAt: Date.now() });
        const tHit = Date.now();
        reqLogger.info({ total_ms: tHit - t0 }, "voice_fast_intent_prebuilt_hit");
        return reply.send({
          status: "ok",
          mimeType: "audio/mpeg",
          audioBase64: prebuilt.audioBase64,
          text: prebuilt.text,
          latencyMs: { llm: 0, tts: 0, total: tHit - t0 },
          cached: true,
          fastIntent: true,
          ack: false,
        });
      }

      const tA = Date.now();
      const cachedTts = getTtsCache(ttsKey(fastReply));
      const audio = cachedTts ? Buffer.from(cachedTts.audioBase64, "base64") : await agent.speak(fastReply);
      const tB = Date.now();
      const payload = {
        text: fastReply,
        audioBase64: audio.toString("base64"),
        createdAt: Date.now(),
      };
      setTtsCache(ttsKey(fastReply), payload);
      setVoiceCache(cacheKey, payload);
      reqLogger.info({ total_ms: tB - t0 }, "voice_fast_intent_tts_only");
      const responsePayload = {
        status: "ok",
        mimeType: "audio/mpeg",
        audioBase64: payload.audioBase64,
        text: payload.text,
        latencyMs: { llm: 0, tts: tB - tA, total: tB - t0 },
        cached: false,
        fastIntent: true,
        ack: false,
      };

      if (deviceId) {
        const updatedHistory = [userInput, ...(effectiveGuestContext.history ?? [])].slice(0, 10);
        await stateProvider.setUserPreferences(deviceId, {
          name: effectiveGuestContext.name,
          loyaltyPoints: effectiveGuestContext.loyaltyPoints,
          history: updatedHistory,
        });
      }

      return reply.send(responsePayload);
    }

    const t1 = Date.now();

    // -------------------------------------------------------------------------
    // STRATEGY SWITCH: USE_QUICK_REPLY_ACK
    // When ON  → skip the pre-warmed ACK cache; call LLM + TTS synchronously
    //            so the reply is context-aware and personalized every time.
    // When OFF → pick a random pre-warmed ACK phrase for <5ms response time,
    //            then compute the real reply in the background (setImmediate).
    // -------------------------------------------------------------------------
    if (env.USE_QUICK_REPLY_ACK) {
      // Synchronous path: wait for LLM to generate a contextual quick reply,
      // then synthesize it through the Federated TTS Router.
      const quickText = await agent.generateQuickVoiceReply(userInput, effectiveGuestContext, {
        timeoutMs: env.GROQ_TIMEOUT_BG_MS,
      });
      reqLogger.info({ quickText }, "quick_reply_ack_generated");

      const tLlm = Date.now();
      const cachedTts = getTtsCache(ttsKey(quickText));
      const audioBuffer = cachedTts
        ? Buffer.from(cachedTts.audioBase64, "base64")
        : await agent.speak(quickText);
      const tTts = Date.now();

      // Cache for next time this same phrase is requested
      const entry = { text: quickText, audioBase64: audioBuffer.toString("base64"), createdAt: Date.now() };
      setVoiceCache(cacheKey, entry);
      setTtsCache(ttsKey(quickText), entry);

      reqLogger.info({ llm_ms: tLlm - t1, tts_ms: tTts - tLlm, total_ms: tTts - t0 }, "voice_fast_quick_reply_ack");

      if (deviceId) {
        const updatedHistory = [userInput, ...(effectiveGuestContext.history ?? [])].slice(0, 10);
        await stateProvider.setUserPreferences(deviceId, {
          name: effectiveGuestContext.name,
          loyaltyPoints: effectiveGuestContext.loyaltyPoints,
          history: updatedHistory,
        });
      }

      return reply.send({
        status: "ok",
        mimeType: "audio/mpeg",
        audioBase64: audioBuffer.toString("base64"),
        text: quickText,
        latencyMs: { llm: tLlm - t1, tts: tTts - tLlm, total: tTts - t0 },
        cached: false,
        fastIntent: false,
        ack: false,
      });
    }

    // Pre-warmed ACK path (USE_QUICK_REPLY_ACK=false): pick a random variation
    // and respond instantly; compute the meaningful reply in the background.
    const ackIdx = Math.floor(Math.random() * ACK_VARIATIONS.length);
    const ack = getVoiceCache(`ack::${ackIdx}`);
    if (ack) {
      // Return ACK immediately and compute full response in background.
      setImmediate(async () => {
        try {
          const quickText = await agent.generateQuickVoiceReply(userInput, effectiveGuestContext, {
            timeoutMs: env.GROQ_TIMEOUT_BG_MS,
          });
          reqLogger.info({ quickText }, "quick_text_generated");
          const t2 = Date.now();
          const cachedTts = getTtsCache(ttsKey(quickText));
          const audioBuffer = cachedTts
            ? Buffer.from(cachedTts.audioBase64, "base64")
            : await agent.speak(quickText);
          const t3 = Date.now();

          setVoiceCache(cacheKey, {
            text: quickText,
            audioBase64: audioBuffer.toString("base64"),
            createdAt: Date.now(),
          });
          setTtsCache(ttsKey(quickText), {
            text: quickText,
            audioBase64: audioBuffer.toString("base64"),
            createdAt: Date.now(),
          });

          reqLogger.info({ llm_ms: t2 - t1, tts_ms: t3 - t2, total_ms: t3 - t0 }, "voice_fast_async_cached");
          if (deviceId) {
            const updatedHistory = [userInput, ...(effectiveGuestContext.history ?? [])].slice(0, 10);
            await stateProvider.setUserPreferences(deviceId, {
              name: effectiveGuestContext.name,
              loyaltyPoints: effectiveGuestContext.loyaltyPoints,
              history: updatedHistory,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reqLogger.warn({ err: message }, "voice_fast_async_error");
        }
      });

      const tAck = Date.now();
      reqLogger.info({ total_ms: tAck - t0 }, "voice_fast_ack");
      const responsePayload = {
        status: "ok",
        mimeType: "audio/mpeg",
        audioBase64: ack.audioBase64,
        text: ack.text,
        latencyMs: { llm: 0, tts: 0, total: tAck - t0 },
        cached: true,
        fastIntent: false,
        ack: true,
      };

      if (deviceId) {
        const updatedHistory = [userInput, ...(effectiveGuestContext.history ?? [])].slice(0, 10);
        await stateProvider.setUserPreferences(deviceId, {
          name: effectiveGuestContext.name,
          loyaltyPoints: effectiveGuestContext.loyaltyPoints,
          history: updatedHistory,
        });
      }

      return reply.send(responsePayload);
    }

    const quickText = await agent.generateQuickVoiceReply(userInput, effectiveGuestContext, {
      timeoutMs: env.GROQ_TIMEOUT_BG_MS,
    });
    const t2 = Date.now();
    const cachedTts = getTtsCache(ttsKey(quickText));
    const audioBuffer = cachedTts ? Buffer.from(cachedTts.audioBase64, "base64") : await agent.speak(quickText);
    const t3 = Date.now();

    setVoiceCache(cacheKey, {
      text: quickText,
      audioBase64: audioBuffer.toString("base64"),
      createdAt: Date.now(),
    });
    setTtsCache(ttsKey(quickText), {
      text: quickText,
      audioBase64: audioBuffer.toString("base64"),
      createdAt: Date.now(),
    });

    reqLogger.info({ llm_ms: t2 - t1, tts_ms: t3 - t2, total_ms: t3 - t0 }, "voice_fast_success");

    const responsePayload = {
      status: "ok",
      mimeType: "audio/mpeg",
      audioBase64: audioBuffer.toString("base64"),
      text: quickText,
      latencyMs: { llm: t2 - t1, tts: t3 - t2, total: t3 - t0 },
      cached: false,
      fastIntent: false,
      ack: false,
    };

    if (deviceId) {
      const updatedHistory = [userInput, ...(effectiveGuestContext.history ?? [])].slice(0, 10);
      await stateProvider.setUserPreferences(deviceId, {
        name: effectiveGuestContext.name,
        loyaltyPoints: effectiveGuestContext.loyaltyPoints,
        history: updatedHistory,
      });
    }

    return reply.send(responsePayload);
  } catch (error) {
    if (error instanceof LlmError && (error.kind === "timeout" || error.kind === "quota")) {
      const tFallbackStart = Date.now();
      const fallbackReply =
        findFastIntentReply(userInput) ?? "Disculp?, tuve un problema de red. ?Pod?s repetir?";

      try {
        const cachedTts = getTtsCache(ttsKey(fallbackReply));
        const audioBuffer = cachedTts
          ? Buffer.from(cachedTts.audioBase64, "base64")
          : await agent.speak(fallbackReply);
        const tFallbackEnd = Date.now();
        setTtsCache(ttsKey(fallbackReply), {
          text: fallbackReply,
          audioBase64: audioBuffer.toString("base64"),
          createdAt: Date.now(),
        });
        reqLogger.warn(
          {
            reason: error.kind,
            total_ms: tFallbackEnd - t0,
          },
          "voice_fast_fallback"
        );

        return reply.send({
          status: "ok",
          mimeType: "audio/mpeg",
          audioBase64: audioBuffer.toString("base64"),
          text: fallbackReply,
          latencyMs: { llm: 0, tts: tFallbackEnd - tFallbackStart, total: tFallbackEnd - t0 },
          cached: false,
          fastIntent: Boolean(findFastIntentReply(userInput)),
          fallback: true,
          ack: false,
        });
      } catch (fallbackError) {
        const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        reqLogger.error({ err: message }, "voice_fast_fallback_error");
        return reply.status(503).send({ error: message });
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    reqLogger.error({ err: message }, "voice_fast_error");
    return reply.status(500).send({ error: message });
  }
});

/**
 * STREAMING STT ENDPOINT (WebSocket)
 * -------------------------------------------------------------
 * Streams microphone audio to Deepgram and relays partial/final transcripts.
 * Includes a short LLM reply + TTS once a final transcript arrives.
 */
app.get("/api/v1/stt-stream", { websocket: true }, (connection: any, req: any) => {
  // Enforce the same API key auth for websocket upgrades as HTTP routes.
  const apiKey = req?.headers?.["x-api-key"];
  if (apiKey !== env.API_KEY) {
    connection.socket.close();
    return;
  }

  const clientSocket = connection.socket as WebSocket;
  const dgSocket = createDeepgramSocket();
  const sessionId = randomUUID();
  const t0 = Date.now();
  let firstTokenAt: number | null = null;
  let transcript = "";
  let replySent = false;

  const sendClient = (data: unknown) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify(data));
    }
  };

  dgSocket.on("open", () => {
    sendClient({ type: "ready" });
    logger.info({ session_id: sessionId }, "stt_stream_open");
  });

  dgSocket.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString()) as any;
      const text = evt?.channel?.alternatives?.[0]?.transcript as string | undefined;
      const isFinal = Boolean(evt?.is_final);
      if (text && text.trim()) {
        if (!firstTokenAt) firstTokenAt = Date.now();
        if (isFinal) transcript = `${transcript} ${text}`.trim();
        sendClient({ type: "transcript", text, final: isFinal });

        if (isFinal && !replySent) {
          replySent = true;
          (async () => {
            try {
              const quickText = await agent.generateQuickVoiceReply(text, {
                name: "User",
                loyaltyPoints: 0,
                history: [],
              });
              const audioBuffer = await agent.speak(quickText);
              sendClient({
                type: "reply",
                text: quickText,
                mimeType: "audio/mpeg",
                audioBase64: audioBuffer.toString("base64"),
              });
            } catch (err) {
              sendClient({ type: "error", error: (err as Error)?.message ?? String(err) });
            }
          })();
        }
      }
    } catch {
      // no-op
    }
  });

  dgSocket.on("error", (err) => {
    sendClient({ type: "error", error: err.message });
  });

  clientSocket.on("message", (msg: any, isBinary: boolean) => {
    if (isBinary) {
      if (dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(msg);
      }
      return;
    }

    try {
      const cmd = JSON.parse(msg.toString()) as { type?: string };
      if (cmd.type === "stop") {
        if (dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(JSON.stringify({ type: "CloseStream" }));
          dgSocket.close();
        }
        const tDone = Date.now();
        logger.info(
          {
            session_id: sessionId,
            first_token_ms: firstTokenAt ? firstTokenAt - t0 : null,
            total_ms: tDone - t0,
          },
          "stt_stream_done"
        );
        sendClient({ type: "done", text: transcript.trim() });
      }
    } catch {
      // no-op
    }
  });

  clientSocket.on("close", () => {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(JSON.stringify({ type: "CloseStream" }));
      dgSocket.close();
    }
    const tClose = Date.now();
    logger.info(
      {
        session_id: sessionId,
        first_token_ms: firstTokenAt ? firstTokenAt - t0 : null,
        total_ms: tClose - t0,
      },
      "stt_stream_closed"
    );
  });
});

/**
 * GAS RELAY ENDPOINT (FeePayer / Account Abstraction)
 * -------------------------------------------------------------
 * Accepts a base64-encoded, PARTIALLY-SIGNED Solana transaction
 * from the frontend. The guest wallet has already signed the
 * instruction-authorizing signature. This endpoint adds the
 * server's fee-payer co-signature so the guest pays zero gas.
 *
 * Security model:
 *   - X-API-KEY auth required (same as all other routes).
 *   - The Anchor program's `has_one = owner` constraint ensures
 *     the server's fee-payer key cannot forge guest instructions.
 *   - We validate feePayer matches our server key before signing.
 *   - recentBlockhash presence is enforced to block replay attacks.
 */
app.post<{ Body: { transaction: string } }>("/api/v1/relay", async (request, reply) => {
  const reqLogger = request.reqLogger;

  // Auth guard
  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_relay_access");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  const { transaction } = request.body ?? {};

  if (!transaction || typeof transaction !== "string") {
    reqLogger.error("missing_transaction_payload");
    return reply.status(400).send({
      error: "Invalid body. Required: { transaction: string } (base64-encoded serialized Transaction)",
    });
  }

  try {
    reqLogger.info("relay_request_received");
    const result = await relayTransaction(rpcConnection, transaction);
    reqLogger.info(
      { signature: result.signature, fee_payer: result.feePayerPubkey },
      "relay_success"
    );
    return reply.status(200).send({
      status: "success",
      signature: result.signature,
      feePayerPubkey: result.feePayerPubkey,
      message: "Transaction co-signed and broadcast. Gas subsidized by ORIN.",
    });
  } catch (error: any) {
    reqLogger.error({ error: error.message }, "relay_error");
    return reply.status(500).send({
      error: "Relay failed.",
      details: error.message,
    });
  }
});

/**
 * PUSD FAUCET ENDPOINT
 * -------------------------------------------------------------
 * Transfers 1000 PUSD to the provided wallet address for testing purposes.
 */
app.post<{ Body: { walletAddress: string } }>("/api/v1/faucet/pusd", async (request, reply) => {
  const reqLogger = request.reqLogger;

  const { walletAddress } = request.body ?? {};
  if (!walletAddress) {
    return reply.status(400).send({ error: "Required: walletAddress" });
  }

  let recipientPubKey: PublicKey;
  try {
    recipientPubKey = new PublicKey(walletAddress);
  } catch (err) {
    return reply.status(400).send({ error: "Invalid walletAddress format" });
  }

  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const feePayer = getFeePayerKeypair();
  const mintAddress = new PublicKey(env.PUSD_TOKEN_MINT_ADDRESS);
  const amountToAirdrop = 1000 * 1000000; // 1000 PUSD (assuming 6 decimals)

  try {
    reqLogger.info({ walletAddress }, "pusd_faucet_request_initiated");

    // Helper function to handle Devnet race conditions where the account is created but not yet visible to the RPC node.
    async function getOrCreateATARetry(pubKey: PublicKey) {
      let attempts = 0;
      while (attempts < 5) {
        try {
          return await getOrCreateAssociatedTokenAccount(
            connection,
            feePayer,
            mintAddress,
            pubKey,
            false,
            "confirmed",
            undefined,
            TOKEN_2022_PROGRAM_ID
          );
        } catch (e: any) {
          attempts++;
          reqLogger.warn({ attempt: attempts, err: e.message || String(e) }, "getOrCreateATA failed, retrying...");
          if (attempts >= 5) {
            throw e;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempts));
        }
      }
      throw new Error("Failed to get or create ATA after multiple attempts");
    }

    // Get the token account of the fromWallet address
    let fromTokenAccount;
    try {
      fromTokenAccount = await getOrCreateATARetry(feePayer.publicKey);
    } catch (e) {
      reqLogger.error({ err: e }, "Failed to get/create FROM token account");
      throw e;
    }

    // Get the token account of the toWallet address
    let toTokenAccount;
    try {
      toTokenAccount = await getOrCreateATARetry(recipientPubKey);
    } catch (e) {
      reqLogger.error({ err: e }, "Failed to get/create TO token account");
      throw e;
    }

    // Prevent abuse: check if recipient already has >= 2000 PUSD
    const maxAllowedBalance = BigInt(2000 * 1000000); // 2000 PUSD with 6 decimals
    if (toTokenAccount.amount >= maxAllowedBalance) {
      reqLogger.warn(
        { walletAddress, currentBalance: toTokenAccount.amount.toString() },
        "pusd_faucet_rejected_balance_too_high"
      );
      return reply.status(403).send({
        error: "Balance too high",
        details: "This wallet already has 2000 or more test PUSD. Faucet limit reached.",
      });
    }

    // Transfer the tokens
    let signature;
    let transferAttempts = 0;
    while (transferAttempts < 5) {
      try {
        signature = await transfer(
          connection,
          feePayer,
          fromTokenAccount.address,
          toTokenAccount.address,
          feePayer.publicKey,
          amountToAirdrop,
          [],
          undefined,
          TOKEN_2022_PROGRAM_ID
        );
        break; // Success
      } catch (e: any) {
        transferAttempts++;
        reqLogger.warn({ attempt: transferAttempts, err: e.message || String(e) }, "Transfer failed, retrying...");
        if (transferAttempts >= 5) {
          throw e;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * transferAttempts));
      }
    }

    reqLogger.info({ walletAddress, signature }, "pusd_faucet_transfer_success");

    return reply.send({
      status: "ok",
      message: "1000 PUSD successfully transferred.",
      signature,
    });
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    const logs = error.logs ? error.logs : undefined;
    reqLogger.error({ error: msg, logs, rawError: error, stack: error.stack }, "pusd_faucet_transfer_error");
    return reply.status(500).send({ error: "Failed to transfer PUSD", details: msg, logs, stack: error.stack, rawErrorName: error.name });
  }
});

// ============================================================================
// DUFFEL STAYS API — Hotel Search → Quote → Booking Pipeline
// ============================================================================
// All routes are protected by the same X-API-KEY auth used elsewhere.
// We NEVER forward raw Duffel blobs to the frontend — only slim Card shapes.
// All routes under /api/v1/stays/* follow the 3-step booking lifecycle.
// ============================================================================

/**
 * STEP 1 — HOTEL SEARCH
 * -------------------------------------------------------------
 * Accepts a structured search request and returns the top 3
 * curated hotel cards filtered by review quality & price-value score.
 *
 * Supports two search modes (Duffel requirement — one or the other):
 *   - location  : { latitude, longitude, radius }
 *   - accommodation: { id }
 *
 * Body: DuffelSearchRequest (see duffel.types.ts)
 *
 * Example:
 *   POST /api/v1/stays/search
 *   {
 *     "check_in_date": "2024-06-04",
 *     "check_out_date": "2024-06-07",
 *     "rooms": 1,
 *     "guests": [{ "type": "adult" }],
 *     "location": { "latitude": 51.5071, "longitude": -0.1416, "radius": 5 }
 *   }
 */
interface StaysSearchBody {
  check_in_date: string;
  check_out_date: string;
  rooms: number;
  guests: { type: "adult" | "child"; age?: number }[];
  location?: { latitude: number; longitude: number; radius?: number };
  accommodation?: { id: string };
  free_cancellation_only?: boolean;
  instant_payment?: boolean;
}

app.post<{ Body: StaysSearchBody }>("/api/v1/stays/search", async (request, reply) => {
  const reqLogger = request.reqLogger;

  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_stays_search");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  if (!env.DUFFEL_API_KEY) {
    return reply.status(503).send({ error: "Duffel integration is not configured. Add DUFFEL_API_KEY to .env." });
  }

  const {
    check_in_date,
    check_out_date,
    rooms,
    guests,
    location,
    accommodation,
    free_cancellation_only,
    instant_payment,
  } = request.body ?? ({} as StaysSearchBody);

  if (!check_in_date || !check_out_date || !rooms || !guests?.length) {
    return reply.status(400).send({
      error: "Required: check_in_date, check_out_date, rooms, guests. Plus one of: location or accommodation.",
    });
  }
  if (!location && !accommodation) {
    return reply.status(400).send({
      error: "Provide either 'location' (lat/lon/radius) or 'accommodation' (id).",
    });
  }

  // Build the typed Duffel request
  const duffelParams: DuffelSearchRequest = {
    check_in_date,
    check_out_date,
    rooms,
    guests,
    free_cancellation_only,
    instant_payment,
    ...(location
      ? {
          location: {
            radius: location.radius ?? 5,
            geographic_coordinates: {
              latitude: location.latitude,
              longitude: location.longitude,
            },
          },
        }
      : { accommodation }),
  };

  try {
    const result = await searchStays(duffelParams);
    reqLogger.info(
      { total_found: result.total_found, returned: result.hotels.length },
      "stays_search_success"
    );
    return reply.send({
      status: "ok",
      hotels: result.hotels,
      total_found: result.total_found,
      search_created_at: result.search_created_at,
    });
  } catch (err) {
    if (err instanceof DuffelError) {
      reqLogger.error({ code: err.duffelCode, status: err.status }, "duffel_search_error");
      return reply.status(err.status >= 400 && err.status < 500 ? 400 : 502).send({
        error: "Hotel search failed",
        code: err.duffelCode,
        details: err.message,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    reqLogger.error({ err: msg }, "stays_search_unexpected_error");
    return reply.status(500).send({ error: "Internal error during hotel search", details: msg });
  }
});

/**
 * STEP 2 — CREATE QUOTE
 * -------------------------------------------------------------
 * Locks in the current price for a specific rate_id.
 * Returns a quote_id required for the final booking step.
 * Rate IDs come from a previous /stays/search response.
 *
 * Body: { rate_id: string }
 *
 * Example:
 *   POST /api/v1/stays/quote
 *   { "rate_id": "rat_0000ARxBI85qTkbVapZDD2" }
 */
app.post<{ Body: { rate_id: string } }>("/api/v1/stays/quote", async (request, reply) => {
  const reqLogger = request.reqLogger;

  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_stays_quote");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  if (!env.DUFFEL_API_KEY) {
    return reply.status(503).send({ error: "Duffel integration is not configured." });
  }

  const { rate_id } = request.body ?? {};
  if (!rate_id) {
    return reply.status(400).send({ error: "Required: rate_id" });
  }

  try {
    const quote = await createQuote(rate_id);
    reqLogger.info({ quote_id: quote.quote_id, total: quote.total_amount }, "stays_quote_success");
    return reply.send({ status: "ok", quote });
  } catch (err) {
    if (err instanceof DuffelError) {
      reqLogger.error({ code: err.duffelCode, status: err.status }, "duffel_quote_error");
      return reply.status(err.status >= 400 && err.status < 500 ? 400 : 502).send({
        error: "Quote creation failed",
        code: err.duffelCode,
        details: err.message,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: "Internal error during quote creation", details: msg });
  }
});

/**
 * STEP 3 — CREATE BOOKING
 * -------------------------------------------------------------
 * Submits the final reservation using a confirmed quote_id.
 * Returns a booking confirmation with hotel reference code.
 *
 * For Sandbox (Test Token): omit `payment` field — Duffel deducts from balance.
 * For Production: pass `payment.three_d_secure_session_id`.
 *
 * Body: DuffelBookingRequest
 *
 * Example (Sandbox):
 *   POST /api/v1/stays/book
 *   {
 *     "quote_id": "quo_0000AS0NZdKjjnnHZmSUbI",
 *     "email": "guest@orin.ai",
 *     "phone_number": "+1234567890",
 *     "guests": [{ "given_name": "James", "family_name": "Chen" }]
 *   }
 */
app.post<{ Body: DuffelBookingRequest & { payment_method?: "fiat" | "PUSD"; amount_usd?: number } }>("/api/v1/stays/book", async (request, reply) => {
  const reqLogger = request.reqLogger;

  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_stays_book");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  if (!env.DUFFEL_API_KEY) {
    return reply.status(503).send({ error: "Duffel integration is not configured." });
  }

  const body = request.body ?? ({} as any);
  const { quote_id, email, phone_number, guests, payment_method, amount_usd } = body;
  
  if (!quote_id || !email || !phone_number || !guests?.length) {
    return reply.status(400).send({
      error: "Required: quote_id, email, phone_number, guests (min 1 with given_name + family_name)",
    });
  }

  // --- CRYPTO (PUSD) PAYMENT FLOW ---
  if (payment_method === "PUSD") {
    if (!amount_usd) {
      return reply.status(400).send({ error: "Required: amount_usd when using PUSD payment method" });
    }

    // Generate a canonical payload for the frontend to sign (similar to Hash-Lock)
    const payload = {
      quote_id,
      amount: amount_usd,
      currency: "PUSD",
      timestamp: Date.now()
    };
    const hashHex = generateSha256Hash(payload).toString("hex");

    // Stage the pending booking in Redis. The listener will finalize the Duffel booking
    // once the blockchain transaction confirms the PUSD transfer with this memo hash.
    await stateProvider.setDirectPayload(hashHex, {
      type: "PUSD_BOOKING",
      booking_details: request.body
    });

    reqLogger.info({ quote_id, amount_usd, hash: hashHex }, "pusd_booking_initiated");

    // We dynamically derive the pubkey from the configured private key to ensure they always match
    const feePayerPubkey = getFeePayerKeypair().publicKey.toBase58();

    // Return exactly what the frontend needs to trigger the wallet transaction
    return reply.send({
      status: "accepted",
      action_required: true,
      message: "Payment required. Please approve the PUSD transaction in your wallet.",
      payment_details: {
        mint: env.PUSD_TOKEN_MINT_ADDRESS,
        amount: amount_usd,
        decimals: 6, // Assuming standard 6 decimals for stablecoins
        memo_hash: hashHex,
        recipient: feePayerPubkey // Orin treasury address
      }
    });
  }

  // --- FIAT/DEFAULT FLOW ---
  try {
    const confirmation = await createBooking(request.body);
    reqLogger.info(
      { booking_id: confirmation.booking_id, reference: confirmation.reference, status: confirmation.status },
      "stays_booking_success"
    );
    return reply.send({ status: "ok", booking: confirmation });
  } catch (err) {
    if (err instanceof DuffelError) {
      reqLogger.error({ code: err.duffelCode, status: err.status }, "duffel_booking_error");
      return reply.status(err.status >= 400 && err.status < 500 ? 400 : 502).send({
        error: "Booking creation failed",
        code: err.duffelCode,
        details: err.message,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: "Internal error during booking", details: msg });
  }
});


/**
 * GET BOOKING STATUS
 * -------------------------------------------------------------
 * Retrieves the current state of an existing booking by ID.
 *
 * Example:
 *   GET /api/v1/stays/bookings/bok_0000BTVRuKZTavzrZDJ4cb
 */
app.get<{ Params: { booking_id: string } }>(
  "/api/v1/stays/bookings/:booking_id",
  async (request, reply) => {
    const reqLogger = request.reqLogger;

    const apiKey = request.headers["x-api-key"];
    if (apiKey !== env.API_KEY) {
      return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
    }
    if (!env.DUFFEL_API_KEY) {
      return reply.status(503).send({ error: "Duffel integration is not configured." });
    }

    const { booking_id } = request.params;
    try {
      const booking = await getBooking(booking_id);
      reqLogger.info({ booking_id, status: booking.status }, "stays_get_booking_success");
      return reply.send({ status: "ok", booking });
    } catch (err) {
      if (err instanceof DuffelError) {
        return reply.status(err.status === 404 ? 404 : 502).send({
          error: "Failed to retrieve booking",
          code: err.duffelCode,
          details: err.message,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: "Internal error", details: msg });
    }
  }
);

/**
 * CANCEL BOOKING
 * -------------------------------------------------------------
 * Cancels a confirmed booking. No refund logic is handled here —
 * cancellation policy is embedded in the original quote card.
 *
 * Example:
 *   POST /api/v1/stays/bookings/bok_xxx/cancel
 */
app.post<{ Params: { booking_id: string } }>(
  "/api/v1/stays/bookings/:booking_id/cancel",
  async (request, reply) => {
    const reqLogger = request.reqLogger;

    const apiKey = request.headers["x-api-key"];
    if (apiKey !== env.API_KEY) {
      return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
    }
    if (!env.DUFFEL_API_KEY) {
      return reply.status(503).send({ error: "Duffel integration is not configured." });
    }

    const { booking_id } = request.params;
    try {
      const result = await cancelBooking(booking_id);
      reqLogger.info({ booking_id, status: result.status }, "stays_cancel_booking_success");
      return reply.send({ status: "ok", booking_id: result.booking_id, booking_status: result.status });
    } catch (err) {
      if (err instanceof DuffelError) {
        return reply.status(err.status === 404 ? 404 : 502).send({
          error: "Cancellation failed",
          code: err.duffelCode,
          details: err.message,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: "Internal error during cancellation", details: msg });
    }
  }
);

/**
 * CURATED HOTEL SEARCH — Primary frontend endpoint
 * -------------------------------------------------------
 * This is the ONLY endpoint the frontend chat flow calls for hotels.
 * It returns a CuratedStayResponse matching frontend/src/lib/curatedBookingContract.ts
 * exactly — no field-name translation needed on the frontend side.
 *
 * In mock mode: returns the same 3 curated demo hotels with dynamic night counts.
 * In live mode:  runs a Duffel search + AI ranking → maps to contract shape.
 *
 * Body: CuratedSearchRequest
 *
 * Example:
 *   POST /api/v1/stays/curated-search
 *   {
 *     "check_in_date": "2026-06-10",
 *     "check_out_date": "2026-06-13",
 *     "guests": 2,
 *     "location": { "latitude": 51.5071, "longitude": -0.1416},
 *     "conversation_summary": "I want a calm premium stay with good WiFi",
 *     "loyalty_points": 1200
 *   }
 *
 * Response conforms to: CuratedStayResponse (frontend contract)
 */
app.post<{ Body: CuratedSearchRequest }>("/api/v1/stays/curated-search", async (request, reply) => {
  const reqLogger = request.reqLogger;

  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    reqLogger.warn({ origin: request.headers.origin }, "unauthorized_curated_search");
    return reply.status(401).send({ error: "Unauthorized. Valid X-API-KEY required." });
  }

  const { check_in_date, check_out_date, guests, location, accommodation } =
    request.body ?? ({} as CuratedSearchRequest);

  if (!check_in_date || !check_out_date || !guests) {
    return reply.status(400).send({
      error: "Required: check_in_date, check_out_date, guests. Plus one of: location or accommodation.",
    });
  }
  if (!location && !accommodation) {
    return reply.status(400).send({
      error: "Provide either 'location' (lat/lon) or 'accommodation' ({id}).",
    });
  }

  try {
    const result = await curatedSearch(request.body);
    reqLogger.info({ count: result.options.length }, "curated_search_success");
    return reply.send(result); // response IS the CuratedStayResponse — no wrapper
  } catch (err) {
    if (err instanceof DuffelError) {
      reqLogger.error({ code: err.duffelCode, status: err.status }, "curated_search_duffel_error");
      return reply.status(err.status >= 400 && err.status < 500 ? 400 : 502).send({
        error: "Curated hotel search failed",
        code: err.duffelCode,
        details: err.message,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    reqLogger.error({ err: msg }, "curated_search_unexpected_error");
    return reply.status(500).send({ error: "Internal error during curated search", details: msg });
  }
});

app.get("/api/v1/warmup", async () => ({ status: "warm", cacheSize: voiceCache.size }));
app.get("/health", async () => ({ status: "ok" }));

/**
 * Starts Fastify server with validated env configuration.
 */
export async function startApiServer(): Promise<void> {
  await prewarmAckOnly();
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info({ host: env.API_HOST, port: env.API_PORT }, "api_server_started");
  setImmediate(() => {
    prewarmServices().catch((err) => {
      logger.warn({ err: err?.message ?? String(err) }, "prewarm_services_error");
    });
  });
}

if (require.main === module) {
  startApiServer().catch((err) => {
    logger.error({ err: err.message }, "api_server_start_error");
    process.exit(1);
  });
}

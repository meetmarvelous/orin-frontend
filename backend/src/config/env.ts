import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  NETWORK: z.enum(["devnet", "mainnet"]).default("devnet"),
  RPC_ENDPOINT: z.string().min(1),
  PROGRAM_ID: z.string().min(1),
  FEE_PAYER_PRIVATE_KEY: z.string().min(87, "Must be a base58-encoded 64-byte Solana keypair"),
  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().min(1).default("llama-3.1-8b-instant"),
  GROQ_TIMEOUT_ACK_MS: z.coerce.number().int().positive().default(200),
  GROQ_TIMEOUT_BG_MS: z.coerce.number().int().positive().default(2000),
  DEEPGRAM_API_KEY: z.string().min(1),
  DEEPGRAM_TTS_MODEL: z.string().min(1).default("aura-2-orion-en"),
  DEEPGRAM_STT_MODEL: z.string().min(1).default("nova-2"),
  
  // High-Fidelity API Configuration
  CARTESIA_API_KEY: z.string().optional().default(""),
  CARTESIA_VOICE_ID: z.string().default("6ccbfb76-1fc6-48f7-b71d-91ac6298247b"),
  CARTESIA_MODEL_ID: z.string().default("sonic-3"),
  
  // Edge AI Pipeline Configuration (Feature Flags)
  USE_EDGE_PIPELINE: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  EDGE_LLM_ENDPOINT: z.string().url().default("http://127.0.0.1:11434/api/chat"),
  EDGE_TTS_ENDPOINT: z.string().url().default("http://127.0.0.1:5002/api/tts"),

  /**
   * When true, /api/v1/voice-fast will skip the ACK_VARIATIONS pre-warmed cache
   * and call generateQuickVoiceReply() synchronously when no fast intent is matched.
   * This produces context-aware, personalized replies at the cost of extra LLM + TTS latency.
   * Set to false (default) for the fastest possible ACK round-trip.
   */
  USE_QUICK_REPLY_ACK: z.enum(["true", "false"]).default("false").transform(v => v === "true"),

  MQTT_BROKER_URL: z.string().min(1),
  MQTT_TOPIC: z.string().min(1),
  REDIS_URL: z.string().min(1),
  STATE_PROVIDER: z.enum(["redis", "memory"]).default("redis"),
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  /**
   * Comma-separated list of allowed CORS origins.
   * Example: "http://localhost:3000,https://orin.network"
   */
  ALLOWED_ORIGIN: z
    .string()
    .min(1)
    .default("http://localhost:3000")
    .refine(
      (val) => val.split(",").every((o) => o.trim().startsWith("http")),
      { message: "Each entry in ALLOWED_ORIGIN must start with http or https" }
    ),
  API_KEY: z.string().min(1).default("replace_with_a_secure_api_key"),

  /**
   * Duffel Travel API — Test / Production token.
   * Required for the /api/v1/stays/* endpoints (hotel search, quote, booking).
   * Generate a Test token at: https://app.duffel.com/access-tokens
   * Use "duffel_test_..." prefix for sandbox; "duffel_live_..." for production.
   * Omit (or set to empty) to disable the Duffel module at startup.
   */
  DUFFEL_API_KEY: z.string().optional().default(""),

  /**
   * Path to the Firebase Admin SDK service account JSON file.
   * Required for Firestore writes. Falls back to Application Default Credentials
   * (e.g. on Google Cloud / Railway) if not set.
   * Example: /home/firebase-adminsdk.json
   */
  FIREBASE_KEY: z.string().optional(),

  PUSD_TOKEN_MINT_ADDRESS: z.string().min(1).default("8y7gWKDiGjkb6q9BLsctFghHTRzTMvbgjVx91BNnRrLK"),
  FEE_PAYER_PUBKEY: z.string().min(1).default("H1r7NTzjrd2tnPGDCJHg1H4wJ8UXuS4TUUymFFK4XpJN"), // Add your actual pubkey default or make it required
});

type ParsedEnv = z.infer<typeof envSchema>;

let cachedEnv: ParsedEnv | null = null;

export function getEnv(): ParsedEnv {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

/**
 * Returns the ALLOWED_ORIGIN env var as a deduplicated string array.
 * Trims whitespace from each entry.
 */
export function getAllowedOrigins(): string[] {
  const raw = getEnv().ALLOWED_ORIGIN;
  return [...new Set(raw.split(",").map((o) => o.trim()))];
}

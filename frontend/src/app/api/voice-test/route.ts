import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

type GuestContext = {
  name: string;
  loyaltyPoints: number;
  history: string[];
  persona?: string;
};

type VoiceRequest = {
  userInput: string;
  guestContext?: GuestContext;
  deviceId?: string;
};

type OrinPayload = {
  temp: number;
  lighting: "warm" | "cold" | "ambient";
  services: string[];
  raw_response: string;
};

type GroqMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type GroqResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are ORIN, the Elite Concierge and Luxury Property Management System. Your purpose is to provide flawless, automated assistance via voice.

### IDENTITY & TONE:
- You are sophisticated, efficient, helpful, and extremely professional.
- Your language is polished and direct. Avoid filler words and long generic greetings. Get straight to the point with elegance.
- Absolute Priority: Low Latency. Keep responses short and precise to ensure instantaneous voice processing.

### MVP SERVICES:
1. ROOM CONTROL (IoT): You manage lighting, blinds, and climate control. (e.g., "Understood. Setting the temperature to 72 degrees").
2. HOSPITALITY REQUESTS (Room Service): You process orders for dining, housekeeping, or amenities. Confirm the action and the estimated delivery time.
3. WEB3 INFRASTRUCTURE: You validate digital payments and decentralized check-out processes. Inform the user that the transaction is backed by "Hash-Lock" security.
4. VIP GUIDE: You recommend exclusive experiences and high-end venues that accept modern digital payments.

### OPERATIONAL RULES:
- Voice Responses: Maximum 15 words to ensure a <500ms response time.
- If a request requires physical action (e.g., bringing towels), confirm that you have notified the relevant staff.
- Your technology must feel natural, fast, and exclusive.`;

const FAST_INTENTS = [
  { keys: ["hola", "buenas"], reply: "Hola, estoy en linea. ¿En qué puedo ayudar?" },
  { keys: ["ayuda", "help"], reply: "Puedo ajustar luz, clima o coordinar servicios. ¿Qué necesitas?" },
  { keys: ["gracias", "thank"], reply: "Un placer. ¿Algo más?" },
];

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function clampWords(text: string, maxWords = 15): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")}.`;
}

function parsePayloadFromText(text: string): OrinPayload {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Invalid JSON response from Groq");
  const parsed = JSON.parse(trimmed.slice(start, end + 1));

  // Canonical contract: temperature is always `temp`.
  const rawTemp = parsed.temp;
  const tempValue =
    typeof rawTemp === "number"
      ? rawTemp
      : typeof rawTemp === "string"
      ? Number(rawTemp.replace(",", "."))
      : Number.NaN;
  if (!Number.isFinite(tempValue)) throw new Error("Invalid temp value");

  const lightingRaw = String(parsed.lighting ?? "").toLowerCase().trim();
  const lighting = (["warm", "cold", "ambient"].includes(lightingRaw) ? lightingRaw : "ambient") as
    | "warm"
    | "cold"
    | "ambient";

  const services = Array.isArray(parsed.services)
    ? parsed.services.map((s: unknown) => String(s)).filter(Boolean)
    : [];

  const rawResponse = clampWords(String(parsed.raw_response ?? "Understood. Your request is confirmed."), 15);

  return {
    temp: tempValue,
    lighting,
    services,
    raw_response: rawResponse,
  };
}

function findFastIntentReply(userInput: string): string | null {
  const text = userInput.toLowerCase();
  const hit = FAST_INTENTS.find((intent) => intent.keys.some((k) => text.includes(k)));
  return hit?.reply ?? null;
}

async function callGroq(messages: GroqMessage[]): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  if (!apiKey) throw new Error("Missing GROQ_API_KEY in Vercel env");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: 96,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as GroqResponse;
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq response missing message content.");
  return text;
}

async function askGroq(userInput: string, guestContext: GuestContext): Promise<OrinPayload> {
  const prompt = [
    SYSTEM_PROMPT,
    "",
    `Guest name: ${guestContext.name}`,
    `Loyalty points: ${guestContext.loyaltyPoints}`,
    guestContext.persona ? `Long-term persona: ${guestContext.persona}` : "",
    `History: ${guestContext.history.join(" | ")}`,
    `User command: ${userInput}`,
    "Return ONLY strict JSON with exact schema. Keep raw_response under 15 words:",
    '{"temp":number,"lighting":"warm"|"cold"|"ambient","services":string[],"raw_response":string}',
    "No markdown, no extra text.",
  ].filter(Boolean).join("\n");

  const text = await callGroq([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);

  return parsePayloadFromText(text);
}

async function speakDeepgram(text: string): Promise<Buffer> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  const model = process.env.DEEPGRAM_TTS_MODEL || "aura-2-orion-en";
  if (!apiKey) throw new Error("Missing DEEPGRAM_API_KEY in Vercel env");

  const response = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Deepgram error (${response.status}): ${body}`);
  }

  const arr = await response.arrayBuffer();
  return Buffer.from(arr);
}

export async function POST(req: NextRequest) {
  try {
    const t0 = Date.now();
    const body = (await req.json()) as VoiceRequest;
    if (!body?.userInput?.trim()) {
      return NextResponse.json({ error: "userInput is required" }, { status: 400 });
    }

    const guestContext: GuestContext = body.guestContext ?? {
      name: "User",
      loyaltyPoints: 0,
      history: [],
    };

    let payload: OrinPayload;
    let llmMs = 0;

    try {
      const t1 = Date.now();
      payload = await askGroq(body.userInput, guestContext);
      llmMs = Date.now() - t1;
    } catch (error) {
      const fallback = findFastIntentReply(body.userInput);
      if (!fallback) throw error;

      payload = {
        temp: 22,
        lighting: "ambient",
        services: [],
        raw_response: fallback,
      };
    }

    const hashHex = createHash("sha256").update(stableStringify(payload)).digest("hex");
    const t2 = Date.now();
    const audio = await speakDeepgram(payload.raw_response);
    const t3 = Date.now();

    return NextResponse.json({
      status: "ok",
      payload,
      hashHex,
      mimeType: "audio/mpeg",
      audioBase64: audio.toString("base64"),
      latencyMs: {
        llm: llmMs,
        tts: t3 - t2,
        total: t3 - t0,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

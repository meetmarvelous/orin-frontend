/**
 * Backend API client
 * ---------------------------------------------------
 * Typed wrapper for the ORIN backend REST endpoints.
 * Matches the contract defined in backend/src/api/server.ts.
 */

/** Must match backend/src/ai_agent.ts GuestContext */
export interface AiResultPayload {
  temp?: number;
  lighting?: "warm" | "cold" | "ambient";
  brightness?: number;
  music?: string;
  musicOn?: boolean;
  services?: string[];
  raw_response?: string;
  text?: string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface GuestContext {
  name: string;
  loyaltyPoints: number;
  history: string[];
  persona?: string;
  currentPreferences?: {
    temp?: number;
    lighting?: string;
    brightness?: number;
    musicOn?: boolean;
    services?: string[];
    raw_response?: string;
  };
}

export interface VoiceCommandRequest {
  guestPda: string;
  userInput: string;
  guestContext: GuestContext;
}

export interface VoiceCommandResponse {
  status: "accepted";
  guestPda: string;
  message: string;
  hash: string;
  requiresSignature?: boolean;
  aiResult?: AiResultPayload;
}

export interface ManualPreferencesRequest {
  guestPda: string;
  preferences: {
    temp: number;
    lighting: "warm" | "cold" | "ambient";
    brightness: number;
    music: string;
  };
}

export interface ManualPreferencesResponse {
  status: "success";
  info: string;
  hash: string;
  requiresSignature?: boolean;
}

/**
 * Backend API base URL.
 * In production this should come from NEXT_PUBLIC_API_URL env var.
 * Falls back to localhost:3001 for local development.
 */
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

function getApiHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
  if (!API_KEY) {
    throw new Error("Missing NEXT_PUBLIC_API_KEY. Please set it in your frontend environment.");
  }
  return {
    "X-API-KEY": API_KEY,
    ...extraHeaders,
  };
}

/**
 * Step A: Sends the raw voice command / preferences to the backend.
 * The backend stages this as a "pending command" in Redis, awaiting
 * hash-lock verification from the Solana listener.
 *
 * @param payload - The voice command request body
 * @returns Accepted response from the backend
 * @throws Error if the request fails or returns non-202
 */
export async function stageVoiceCommand(
  payload: VoiceCommandRequest
): Promise<VoiceCommandResponse> {
  const response = await fetch(`${API_BASE}/api/v1/voice-command`, {
    method: "POST",
    headers: getApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `API error (${response.status}): ${errorBody}`
    );
  }

  return response.json();
}

/**
 * Step A (Bypass): Sends raw preferences to the high-speed bypass endpoint.
 * This skips AI inference for instant (O(ms)) manual UI controls.
 *
 * @param payload - The manual preferences request body
 * @returns Accepted response from the backend
 */
export async function stageManualPreferences(
  payload: ManualPreferencesRequest
): Promise<ManualPreferencesResponse> {
  const response = await fetch(`${API_BASE}/api/v1/preferences`, {
    method: "POST",
    headers: getApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API error (${response.status}): ${errorBody}`);
  }

  return response.json();
}

/**
 * Health check for the backend API.
 */
export async function checkApiHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sends a raw audio blob to the backend for AI transcription
 */
export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const formData = new FormData();
  formData.append("audio", audioBlob, "recording.webm");

  const response = await fetch(`${API_BASE}/api/v1/transcribe`, {
    method: "POST",
    headers: getApiHeaders(),
    // Don't set Content-Type header manually when sending FormData,
    // fetch will automatically set it to multipart/form-data
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Transcription API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data.text;
}

export interface RelayResponse {
  status: "success";
  signature: string;
  feePayerPubkey: string;
  message: string;
}

/**
 * Gas Relay: submits a partially-signed, base64-serialized Transaction
 * to the backend fee-payer, which co-signs and broadcasts it to Solana.
 * The guest pays ZERO on-chain fees.
 *
 * Usage:
 *   1. Build the transaction with feePayer = server's public key.
 *   2. Guest wallet partial-signs (authorizes the instruction).
 *   3. Serialize with requireAllSignatures: false and base64-encode.
 *   4. Call this function — the server adds the fee-payer signature.
 *
 * @param serializedTx - base64-encoded partially-signed Transaction bytes
 */
export async function relayTransaction(serializedTx: string): Promise<RelayResponse> {
  const response = await fetch(`${API_BASE}/api/v1/relay`, {
    method: "POST",
    headers: getApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ transaction: serializedTx }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Relay API error (${response.status}): ${errorBody}`);
  }

  return response.json();
}


/**
 * Fast Voice Feedback (Low-Latency TTS)
 * Generates an instant audio response from the LLM, useful for masking
 * the delay while a blockchain transaction completes in the background.
 */
export async function fetchFastVoiceReply(payload: {
  userInput: string;
  guestContext?: GuestContext;
  deviceId?: string;
}): Promise<{
  status: string;
  mimeType: string;
  audioBase64: string;
  text?: string;
  fastIntent?: boolean;
  aiResult?: AiResultPayload;
}> {
  const response = await fetch(`${API_BASE}/api/v1/voice-fast`, {
    method: "POST",
    headers: getApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Fast Voice API error (${response.status}): ${errorBody}`);
  }

  return response.json();
}

export interface RoomDeviceState {
  roomId: string;
  hue: {
    color: string;
    brightness: number;
    on: boolean;
  };
  lighting: "warm" | "cold" | "ambient";
  nest: {
    temp: number;
    mode: string;
  };
  music: string;
  lastUpdatedAt: string | null;
  lastGuestPda: string | null;
}

export interface DeviceStatusResponse {
  status: string;
  device: RoomDeviceState;
}

export interface TtsResponse {
  status: string;
  mimeType: string;
  audioBase64: string;
  text: string;
  latencyMs: number;
}

export interface GuestProfileRecord {
  guestPda: string;
  avatarUrl?: string;
  persona?: string;
  createdAt?: string;
  lastSeenAt?: string;
  [key: string]: unknown;
}

export interface GuestProfileApiResponse {
  status: string;
  guestPda: string;
  profile?: GuestProfileRecord;
  preferences?: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isNumericLike(value: unknown): value is number | string {
  return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
}

/**
 * GET /api/v1/device/status?guestPda=<YOUR_PDA>
 * Fetches the current live state of the room devices for a specific guest.
 */
export async function fetchDeviceStatus(guestPda: string): Promise<RoomDeviceState> {
  const response = await fetch(`${API_BASE}/api/v1/device/status?guestPda=${guestPda}`, {
    method: "GET",
    headers: getApiHeaders(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Device status API error (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as DeviceStatusResponse | RoomDeviceState;
  const normalizedDevice = (data as DeviceStatusResponse).device ?? (data as RoomDeviceState);

  if (!normalizedDevice || typeof normalizedDevice !== "object") {
    throw new Error("Device status API returned malformed payload: missing device state.");
  }

  if (!isRecord(normalizedDevice.nest) || !isNumericLike(normalizedDevice.nest.temp)) {
    throw new Error("Device status API returned malformed payload: missing nest.temp.");
  }

  if (!isRecord(normalizedDevice.hue) || !isNumericLike(normalizedDevice.hue.brightness)) {
    throw new Error("Device status API returned malformed payload: missing hue.brightness.");
  }

  if (
    normalizedDevice.lighting !== undefined &&
    normalizedDevice.lighting !== "warm" &&
    normalizedDevice.lighting !== "cold" &&
    normalizedDevice.lighting !== "ambient"
  ) {
    throw new Error("Device status API returned malformed payload: invalid lighting.");
  }

  return normalizedDevice;
}

/**
 * POST /api/v1/tts
 * Converts arbitrary text into high-fidelity voice audio.
 */
export async function fetchTtsAudio(text: string): Promise<TtsResponse> {
  const response = await fetch(`${API_BASE}/api/v1/tts`, {
    method: "POST",
    headers: getApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`TTS API error (${response.status}): ${errorBody}`);
  }

  return response.json();
}

export async function fetchGuestProfileApi(guestPda: string): Promise<GuestProfileApiResponse> {
  const response = await fetch(`${API_BASE}/api/v1/guest/profile?guestPda=${guestPda}`, {
    headers: getApiHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Profile API error: ${response.status}`);
  }
  return response.json();
}

export async function updateGuestAvatar(guestPda: string, avatarUrl: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/guest/avatar_update`, {
    method: "POST",
    headers: getApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ guestPda, avatarUrl }),
  });
  if (!response.ok) {
    throw new Error(`Avatar Update API error: ${response.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Duffel Stays — Curated Hotel Search
// ─────────────────────────────────────────────────────────────────────────────
// These types EXACTLY mirror backend/src/duffel/duffel.types.ts.
// They are intentionally duplicated here to keep the frontend self-contained.
// Source of truth for field names: backend CuratedSearchRequest / CuratedStayResponse.
// ─────────────────────────────────────────────────────────────────────────────

export interface CuratedSearchRequest {
  check_in_date: string;        // YYYY-MM-DD
  check_out_date: string;       // YYYY-MM-DD
  guests: number;
  location?: { latitude: number; longitude: number; radius?: number };
  accommodation?: { id: string };
  conversation_summary?: string;  // What the user said to ORIN
  loyalty_points?: number;
}

export interface CuratedStayOption {
  hotelId: string;
  hotelName: string;
  location: string;
  price: number;
  currency: string;
  tags: string[];
  reasonForRecommendation: string;
  pointsEarn: number;
  nightlyDetails: {
    nights: number;
    ratePerNight: number;
    totalBeforeTax: number;
  };
  cancellationPolicy: string;
  image: string;
}

export interface CuratedStayResponse {
  conversationSummary: string;
  options: [CuratedStayOption, CuratedStayOption] | [CuratedStayOption, CuratedStayOption, CuratedStayOption];
  rankingMetadata: {
    rankedBy: "orin-ai";
    confidenceScore: number;
    generatedAt: string;
  };
  nextAction: string;
}

export interface BookingPriceLine {
  label: string;
  amount: number;
  lineType: "base" | "tax" | "discount";
}

export interface PointsRedemption {
  pointsUsed: number;
  discountAmount: number;
}

export interface BookingSummary {
  checkInDate: string;
  checkOutDate: string;
  guests: number;
  selectedOption: CuratedStayOption;
  priceLines: BookingPriceLine[];
  pointsRedemption: PointsRedemption;
  payableTotal: number;
  currency: string;
}

/**
 * POST /api/v1/stays/curated-search
 *
 * The primary hotel search call for the chat-first frontend flow.
 * Returns a CuratedStayResponse (2-3 AI-ranked hotel options) that
 * exactly matches the shape defined in curatedBookingContract.ts.
 *
 * The response can be used directly in the UI without any transformation.
 *
 * @example
 *   const stays = await fetchCuratedStays({
 *     check_in_date: "2026-06-10",
 *     check_out_date: "2026-06-13",
 *     guests: 2,
 *     location: { latitude: 40.7128, longitude: -74.006 },
 *     conversation_summary: "I want a calm premium stay with good WiFi",
 *     loyalty_points: guestContext.loyaltyPoints,
 *   });
 */
export async function fetchCuratedStays(
  params: CuratedSearchRequest
): Promise<CuratedStayResponse> {
  const response = await fetch(`${API_BASE}/api/v1/stays/curated-search`, {
    method: "POST",
    headers: getApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Curated search API error (${response.status}): ${errorBody}`);
  }

  return response.json();
}

/**
 * Builds a BookingSummary from a selected CuratedStayOption.
 *
 * This is a PURE CLIENT-SIDE function — no backend call needed.
 * The backend manages the full /stays/quote + /stays/book flow;
 * this function is only for building the confirmation preview UI.
 *
 * @param selectedOption   - The hotel the user picked
 * @param checkInDate      - YYYY-MM-DD
 * @param checkOutDate     - YYYY-MM-DD
 * @param guests           - Number of guests
 * @param loyaltyPoints    - Points the guest wants to redeem (0 = none)
 */
export function buildBookingSummary(
  selectedOption: CuratedStayOption,
  checkInDate: string,
  checkOutDate: string,
  guests: number,
  loyaltyPoints = 0
): BookingSummary {
  const { totalBeforeTax, nights } = selectedOption.nightlyDetails;
  const taxAmount = Math.round(totalBeforeTax * 0.1);
  const maxDiscount = Math.round(totalBeforeTax * 0.08);
  const discountAmount = Math.min(Math.floor(loyaltyPoints / 10), maxDiscount);

  const pointsRedemption: PointsRedemption = {
    pointsUsed: Math.min(loyaltyPoints, discountAmount * 10),
    discountAmount,
  };

  const priceLines: BookingPriceLine[] = [
    {
      label: `Deluxe stay x ${nights} night(s)`,
      amount: totalBeforeTax,
      lineType: "base",
    },
    {
      label: "Tax & fees (10%)",
      amount: taxAmount,
      lineType: "tax",
    },
    {
      label: "ORIN points discount",
      amount: -discountAmount,
      lineType: "discount",
    },
  ];

  return {
    checkInDate,
    checkOutDate,
    guests,
    selectedOption,
    priceLines,
    pointsRedemption,
    payableTotal: totalBeforeTax + taxAmount - discountAmount,
    currency: selectedOption.currency,
  };
}

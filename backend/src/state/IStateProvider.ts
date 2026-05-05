import { GuestContext, OrinAgentOutput } from "../ai_agent";
export { GuestContext, OrinAgentOutput };

/**
 * State provider contracts
 * -------------------------------------------------------------
 * Abstracts persistence so runtime logic is storage-agnostic.
 * Implementations can target Redis, Postgres, DynamoDB, etc.
 */

export interface PendingCommand {
  guestPda: string;
  userInput: string;
  guestContext: GuestContext;
  createdAt: number;
}

export interface ValidatedState {
  guestPda: string;
  hashHex: string;
  payload: OrinAgentOutput;
  validatedAt: number;
}

/**
 * Physical room device state — written by listener after each MQTT publish.
 * Stored in Redis so both api and listener processes share truth.
 */
export interface RoomDeviceState {
  /** Logical room identifier */
  roomId: string;
  /** Philips Hue lighting */
  hue: {
    color: string;     // hex e.g. "#FFB347"
    brightness: number; // 0–100
    on: boolean;
  };
  /** Semantic lighting mode — "warm" | "cold" | "ambient" */
  lighting: "warm" | "cold" | "ambient";
  /** Google Nest climate */
  nest: {
    temp: number;
    mode: "HEAT" | "COOL" | "AUTO" | "OFF";
  };
  /** Music player — name from the MUSIC_LIST, or "" when off */
  music: string;
  /** Resolved playable URL for the frontend */
  music_url?: string;
  /** ISO-8601 timestamp of last update */
  lastUpdatedAt: string;
  /** Solana PDA of guest who triggered the last change */
  lastGuestPda: string | null;
}

export interface UserPreferences {
  name: string;
  loyaltyPoints: number;
  history: string[];
}

export interface IStateProvider {
  // Hash deduplication and replay protection.
  getLastProcessedHash(guestPda: string): Promise<string | null>;
  setLastProcessedHash(guestPda: string, hashHex: string): Promise<void>;

  // Command staging from API ingress before on-chain verification.
  setPendingCommand(command: PendingCommand): Promise<void>;
  getPendingCommand(guestPda: string): Promise<PendingCommand | null>;
  clearPendingCommand(guestPda: string): Promise<void>;

  // Audit trail for validated hash-lock decisions.
  setValidatedState(state: ValidatedState): Promise<void>;

  // User/device preferences.
  getUserPreferences(deviceId: string): Promise<UserPreferences | null>;
  setUserPreferences(deviceId: string, prefs: UserPreferences): Promise<void>;

  /**
   * DIRECT BYPASS (Manual slider or pre-calculated AI)
   * Stores the full payload indexed by its SHA-256 hash.
   * The listener will use this to skip AI inference if the hash matches.
   */
  setDirectPayload(hashHex: string, payload: any): Promise<void>;
  getDirectPayload(hashHex: string): Promise<any | null>;

  /**
   * ROOM DEVICE STATE
   * Full physical snapshot written by listener after every verified MQTT publish.
   * Keyed by roomId so multiple rooms are isolated.
   * Readable by any process (api, listener) via Redis.
   */
  setDeviceState(roomId: string, state: RoomDeviceState): Promise<void>;
  getDeviceState(roomId: string): Promise<RoomDeviceState | null>;
}

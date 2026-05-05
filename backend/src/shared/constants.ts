import { PublicKey } from "@solana/web3.js";
import { getEnv } from "../config/env";

/**
 * Shared runtime constants
 * -------------------------------------------------------------
 * Keep protocol/runtime constants centralized so all modules
 * (API, listeners, simulators) use the same values and avoid
 * silent drift caused by local hardcoded strings.
 */

const env = getEnv();

export const NETWORK = env.NETWORK;
export const RPC_ENDPOINT = env.RPC_ENDPOINT;
export const PROGRAM_ID = new PublicKey(env.PROGRAM_ID);

export const ANCHOR_ACCOUNTS = {
  GUEST_IDENTITY: "GuestIdentity",
} as const;

export const IO_TOPICS = {
  ROOM_CONTROL: env.MQTT_TOPIC,
} as const;

export const PATHS = {
  IDL_PATH: "../src/idl/orin_identity.json",
  AUDIO_OUTPUT: "../response.mp3",
} as const;

import * as mqtt from "mqtt";
import { logger } from "./shared/logger";

/**
 * MQTT Bridge & Device State Store
 * -------------------------------------------------------------
 * Two responsibilities:
 *  1. Publish IoT control messages to the MQTT broker (Philips Hue, Google Nest, etc.)
 *  2. Maintain an in-process mirror of the last confirmed device state so that the
 *     REST API can serve it without an extra round-trip to Redis or the broker.
 *
 * NOTE: This module intentionally avoids reading back from the MQTT broker.
 *       "Last write wins" is sufficient for this MVP phase.
 */

// ---------------------------------------------------------------------------
// Device State Types
// ---------------------------------------------------------------------------

export interface HueState {
  /** Raw hex color string e.g. "#FFFFFF" */
  color: string;
  /** Brightness 0-100 */
  brightness: number;
  /** Whether the light is on */
  on: boolean;
}

export interface NestState {
  /** Target temperature in Celsius */
  target_temp_c: number;
  /** Thermostat mode */
  mode: "HEAT" | "COOL" | "AUTO" | "OFF";
}

export interface DeviceState {
  /** Room identifier — static in MVP, dynamic per guestPda in production */
  roomId: string;
  hue: HueState;
  nest: NestState;
  /** ISO-8601 timestamp of the last update */
  lastUpdatedAt: string;
  /** guestPda that triggered the last state change */
  lastGuestPda: string | null;
}

// ---------------------------------------------------------------------------
// Internal State Mirror
// ---------------------------------------------------------------------------

/**
 * In-memory device state snapshot.
 * Initialised with sensible hotel defaults so the API returns something
 * meaningful even before the first MQTT publish cycle completes.
 */
let deviceState: DeviceState = {
  roomId: "room101",
  hue: { color: "#FFFFFF", brightness: 80, on: true },
  nest: { target_temp_c: 22, mode: "AUTO" },
  lastUpdatedAt: new Date().toISOString(),
  lastGuestPda: null,
};

/**
 * Returns a deep-copy snapshot of the current device state.
 * Callers receive an immutable view — mutations do not affect the store.
 */
export function getDeviceState(): DeviceState {
  return JSON.parse(JSON.stringify(deviceState));
}

/**
 * Merges a partial update into the device state mirror.
 * Called by the listener after a successful MQTT publish.
 */
export function updateDeviceState(patch: {
  guestPda: string;
  lighting?: string;
  brightness?: number;
  temp?: number;
}): void {
  const { guestPda, lighting, brightness, temp } = patch;

  // Map semantic lighting mode → Hue color temp
  const COLOR_MAP: Record<string, string> = {
    warm: "#FFB347",
    cold: "#99CCFF",
    ambient: "#FFFFFF",
  };

  if (lighting && lighting in COLOR_MAP) {
    deviceState.hue.color = COLOR_MAP[lighting];
  }
  if (typeof brightness === "number") {
    deviceState.hue.brightness = Math.min(100, Math.max(0, brightness));
  }
  if (typeof temp === "number") {
    deviceState.nest.target_temp_c = temp;
    // Simple heuristic: if temperature goes up = HEAT, down = COOL
    deviceState.nest.mode = temp >= deviceState.nest.target_temp_c ? "HEAT" : "COOL";
  }

  deviceState.lastGuestPda = guestPda;
  deviceState.lastUpdatedAt = new Date().toISOString();

  logger.info(
    { roomId: deviceState.roomId, patch, snapshot: deviceState },
    "device_state_updated"
  );
}

// ---------------------------------------------------------------------------
// MQTT Client
// ---------------------------------------------------------------------------

const MQTT_BROKER_URL =
  process.env.MQTT_BROKER_URL || process.env.MQTT_BROKER || "mqtt://test.mosquitto.org";

let client: mqtt.MqttClient | null = null;

try {
  client = mqtt.connect(MQTT_BROKER_URL);
  client.on("connect", () => {
    logger.info({ broker: MQTT_BROKER_URL }, "mqtt_mock_bridge_connected");
  });
  client.on("error", (err) => {
    logger.warn({ err: err.message }, "mqtt_mock_bridge_error");
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: message }, "mqtt_mock_bridge_init_failed");
}

// ---------------------------------------------------------------------------
// Public Publish Helper (Legacy-compatible)
// ---------------------------------------------------------------------------

/**
 * Publishes Philips Hue + Google Nest MQTT packets for a given guest.
 * Also syncs the in-memory device state mirror immediately so the API
 * can reflect the change without waiting for a broker echo.
 *
 * @param guestPubkey - The guest PDA (used for logging and state attribution)
 * @param preferences - Partial room preferences to apply
 */
export function adjustRoomEnvironment(
  guestPubkey: string,
  preferences: {
    light_color?: string;
    brightness?: number;
    temp?: number;
    lighting?: string;
  }
): void {
  const roomId = deviceState.roomId;

  // 1. Philips Hue — Lighting control
  const hueTopic = `orin/hotel/${roomId}/hue/set`;
  const huePayload = JSON.stringify({
    state: "ON",
    color: preferences.light_color ?? COLOR_MAP[preferences.lighting ?? ""] ?? "#FFFFFF",
    brightness: preferences.brightness ?? deviceState.hue.brightness,
  });

  if (client?.connected) {
    client.publish(hueTopic, huePayload, (err) => {
      if (err) logger.error({ err: err.message, topic: hueTopic }, "mqtt_hue_publish_error");
      else logger.info({ topic: hueTopic, payload: huePayload }, "mqtt_hue_publish_success");
    });
  } else {
    logger.warn({ topic: hueTopic, payload: huePayload }, "mqtt_hue_broker_offline_skip");
  }

  // 2. Google Nest — Climate control
  const nestTopic = `orin/hotel/${roomId}/nest/set`;
  const nestPayload = JSON.stringify({
    target_temperature_c: preferences.temp ?? deviceState.nest.target_temp_c,
    mode: "COOL",
  });

  if (client?.connected) {
    client.publish(nestTopic, nestPayload, (err) => {
      if (err) logger.error({ err: err.message, topic: nestTopic }, "mqtt_nest_publish_error");
      else logger.info({ topic: nestTopic, payload: nestPayload }, "mqtt_nest_publish_success");
    });
  } else {
    logger.warn({ topic: nestTopic, payload: nestPayload }, "mqtt_nest_broker_offline_skip");
  }

  // 3. Sync in-memory mirror immediately
  updateDeviceState({
    guestPda: guestPubkey,
    lighting: preferences.lighting,
    brightness: preferences.brightness,
    temp: preferences.temp,
  });
}

// Private helper used by adjustRoomEnvironment
const COLOR_MAP: Record<string, string> = {
  warm: "#FFB347",
  cold: "#99CCFF",
  ambient: "#FFFFFF",
};

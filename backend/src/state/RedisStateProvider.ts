import Redis from "ioredis";
import { getEnv } from "../config/env";
import { IStateProvider, PendingCommand, RoomDeviceState, UserPreferences, ValidatedState } from "./IStateProvider";
import { syncGuestPreferencesToFirestore } from "./FirestoreService";

/**
 * Redis-backed state provider
 * -------------------------------------------------------------
 * Stores:
 * - last processed hashes (dedup/replay guard)
 * - staged commands from API
 * - validated state snapshots for short-term auditability
 * - per-device user preferences
 */

const env = getEnv();

export class RedisStateProvider implements IStateProvider {
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(env.REDIS_URL, { lazyConnect: false });
  }

  async getLastProcessedHash(guestPda: string): Promise<string | null> {
    return this.redis.get(`orin:last_hash:${guestPda}`);
  }

  async setLastProcessedHash(guestPda: string, hashHex: string): Promise<void> {
    await this.redis.set(`orin:last_hash:${guestPda}`, hashHex);
  }

  async setPendingCommand(command: PendingCommand): Promise<void> {
    // 1 hour TTL prevents stale pending commands from accumulating.
    await this.redis.set(
      `orin:pending:${command.guestPda}`,
      JSON.stringify(command),
      "EX",
      3600
    );
  }

  async getPendingCommand(guestPda: string): Promise<PendingCommand | null> {
    const raw = await this.redis.get(`orin:pending:${guestPda}`);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as PendingCommand;
  }

  async clearPendingCommand(guestPda: string): Promise<void> {
    await this.redis.del(`orin:pending:${guestPda}`);
  }

  async setValidatedState(state: ValidatedState): Promise<void> {
    // 24 hour TTL keeps recent audit records while controlling memory growth.
    await this.redis.set(`orin:validated:${state.guestPda}`, JSON.stringify(state), "EX", 86400);
  }

  async getUserPreferences(deviceId: string): Promise<UserPreferences | null> {
    const raw = await this.redis.get(`orin:user_prefs:${deviceId}`);
    return raw ? (JSON.parse(raw) as UserPreferences) : null;
  }

  async setUserPreferences(deviceId: string, prefs: UserPreferences): Promise<void> {
    // 30-day TTL for device-specific personalization.
    await this.redis.set(`orin:user_prefs:${deviceId}`, JSON.stringify(prefs), "EX", 30 * 24 * 3600);
  }

  async setDirectPayload(hashHex: string, payload: any): Promise<void> {
    // 10-minute TTL to store direct payloads awaiting confirmation signs.
    await this.redis.set(`orin:payload:${hashHex}`, JSON.stringify(payload), "EX", 600);
  }

  async getDirectPayload(hashHex: string): Promise<any | null> {
    const raw = await this.redis.get(`orin:payload:${hashHex}`);
    return raw ? JSON.parse(raw) : null;
  }

  async setDeviceState(roomId: string, state: RoomDeviceState): Promise<void> {
    // 24-hour TTL: persists across restarts, auto-expires stale rooms.
    await this.redis.set(`orin:device_state:${roomId}`, JSON.stringify(state), "EX", 86400);

    // Fire-and-forget: sync to Firestore for long-term guest preference history.
    // Uses lastGuestPda as the Firestore document owner. Non-blocking — failures
    // are logged internally and never propagate to the caller.
    if (state.lastGuestPda) {
      syncGuestPreferencesToFirestore(state.lastGuestPda, state).catch(() => {/* handled inside */});
    }
  }

  async getDeviceState(roomId: string): Promise<RoomDeviceState | null> {
    const raw = await this.redis.get(`orin:device_state:${roomId}`);
    return raw ? (JSON.parse(raw) as RoomDeviceState) : null;
  }
}

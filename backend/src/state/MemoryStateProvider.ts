import { IStateProvider, OrinAgentOutput, PendingCommand, RoomDeviceState, UserPreferences, ValidatedState } from "./IStateProvider";

/**
 * In-memory state provider
 * -------------------------------------------------------------
 * Useful for local smoke tests when Redis is unavailable.
 * Data is ephemeral and lost on process restart.
 */
export class MemoryStateProvider implements IStateProvider {
  private readonly lastHash = new Map<string, string>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly validated = new Map<string, ValidatedState>();
  private readonly prefs = new Map<string, UserPreferences>();
  private readonly directPayloads = new Map<string, any>();
  private readonly deviceStates = new Map<string, RoomDeviceState>();

  async getLastProcessedHash(guestPda: string): Promise<string | null> {
    return this.lastHash.get(guestPda) ?? null;
  }

  async setLastProcessedHash(guestPda: string, hashHex: string): Promise<void> {
    this.lastHash.set(guestPda, hashHex);
  }

  async setPendingCommand(command: PendingCommand): Promise<void> {
    this.pending.set(command.guestPda, command);
  }

  async getPendingCommand(guestPda: string): Promise<PendingCommand | null> {
    return this.pending.get(guestPda) ?? null;
  }

  async clearPendingCommand(guestPda: string): Promise<void> {
    this.pending.delete(guestPda);
  }

  async setValidatedState(state: ValidatedState): Promise<void> {
    this.validated.set(state.guestPda, state);
  }

  async getUserPreferences(deviceId: string): Promise<UserPreferences | null> {
    return this.prefs.get(deviceId) ?? null;
  }

  async setUserPreferences(deviceId: string, prefs: UserPreferences): Promise<void> {
    this.prefs.set(deviceId, prefs);
  }

  async setDirectPayload(hashHex: string, payload: any): Promise<void> {
    this.directPayloads.set(hashHex, payload);
  }

  async getDirectPayload(hashHex: string): Promise<any | null> {
    return this.directPayloads.get(hashHex) ?? null;
  }

  async setDeviceState(roomId: string, state: RoomDeviceState): Promise<void> {
    this.deviceStates.set(roomId, state);
  }

  async getDeviceState(roomId: string): Promise<RoomDeviceState | null> {
    return this.deviceStates.get(roomId) ?? null;
  }
}

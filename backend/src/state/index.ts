import { getEnv } from "../config/env";
import { IStateProvider } from "./IStateProvider";
import { MemoryStateProvider } from "./MemoryStateProvider";
import { RedisStateProvider } from "./RedisStateProvider";

/**
 * Default runtime state provider.
 * Swap here if migrating storage backend.
 */
const env = getEnv();

export const stateProvider: IStateProvider =
  env.STATE_PROVIDER === "memory" ? new MemoryStateProvider() : new RedisStateProvider();

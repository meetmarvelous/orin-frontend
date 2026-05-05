import { getEnv } from "./env";

/**
 * Strict environment validation gate.
 * -------------------------------------------------------------
 * This module is intended to be called before any server bootstrap.
 * On failure it prints a descriptive error and terminates process
 * with exit code 1 to avoid partially initialized runtime states.
 */
export function validateEnvOrExit(): void {
  try {
    getEnv();
    console.log("Environment validation passed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Environment validation failed.");
    console.error(message);
    process.exit(1);
  }
}

if (require.main === module) {
  validateEnvOrExit();
}

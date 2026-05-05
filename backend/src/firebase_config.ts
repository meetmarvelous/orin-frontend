import * as admin from "firebase-admin";
import * as fs from "fs";
import { logger } from "./shared/logger";

/**
 * Firebase Admin SDK Initialization
 * -------------------------------------------------------------
 * Initialization priority:
 *  1. FIREBASE_KEY env var → points to a service account JSON file (local dev & CI)
 *  2. Application Default Credentials → works on Google Cloud / Railway automatically
 *
 * Project: base-4c202
 * Firestore: used for persistent guest profile & preference history.
 */

if (admin.apps.length === 0) {
  try {
    const keyPath = process.env.FIREBASE_KEY;
    let credential: admin.credential.Credential;

    if (keyPath) {
      if (keyPath.trim().startsWith("{")) {
        // Option 1: FIREBASE_KEY is a raw JSON string (ideal for Railway/Docker env vars)
        const serviceAccount = JSON.parse(keyPath);
        credential = admin.credential.cert(serviceAccount);
        logger.info({ projectId: "base-4c202" }, "firebase_admin_init_json_string");
      } else if (fs.existsSync(keyPath)) {
        // Option 2: FIREBASE_KEY is a local file path (ideal for local dev)
        const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
        credential = admin.credential.cert(serviceAccount);
        logger.info({ keyPath, projectId: "base-4c202" }, "firebase_admin_init_file_path");
      } else {
        // Fallback to default if path not found
        credential = admin.credential.applicationDefault();
        logger.info({ projectId: "base-4c202" }, "firebase_admin_init_fallback_adc");
      }
    } else {
      // Option 3: Use Application Default Credentials (GCP / Railway with Workload Identity)
      credential = admin.credential.applicationDefault();
      logger.info({ projectId: "base-4c202" }, "firebase_admin_init_adc");
    }

    admin.initializeApp({
      credential,
      projectId: "base-4c202",
      databaseURL: "https://mock-orin-default-rtdb.firebaseio.com",
    });

    // Silently ignore undefined fields — safety net for payloads where
    // optional fields may not be populated (e.g. direct frontend preferences).
    admin.firestore().settings({ ignoreUndefinedProperties: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "firebase_admin_init_failed_non_blocking");
  }
}

/**
 * Returns the Firestore instance.
 * Callers should handle errors gracefully — Firebase is a non-critical dependency.
 */
export function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

export { admin };

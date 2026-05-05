import { getFirestore } from "../firebase_config";
import { RoomDeviceState } from "./IStateProvider";
import { logger } from "../shared/logger";

/**
 * Firestore Guest Profile & Preference Persistence Service
 * -------------------------------------------------------------
 * Provides long-term, queryable storage for guest preferences and session history.
 * This layer is intentionally decoupled from Redis — Redis is the hot cache for
 * real-time device state, Firestore is the durable record for analytics and CRM.
 *
 * Firestore data model:
 *
 *   guests/{guestPda}                          ← Guest profile document
 *     ├─ guestPda: string
 *     ├─ createdAt: Timestamp
 *     └─ lastSeenAt: Timestamp
 *
 *   guests/{guestPda}/preferences/{sessionId}  ← Timestamped preference snapshot
 *     ├─ roomId: string
 *     ├─ lighting: "warm" | "cold" | "ambient"
 *     ├─ hue: { color, brightness, on }
 *     ├─ nest: { target_temp_c, mode }
 *     ├─ music: string
 *     ├─ lastUpdatedAt: string (ISO-8601)
 *     └─ recordedAt: Timestamp
 */

/**
 * Persists a guest's device state snapshot to Firestore.
 * - Creates or updates the top-level guest profile (upsert).
 * - Appends a new timestamped session entry under preferences subcollection.
 *
 * This is called fire-and-forget from setDeviceState — failures are logged
 * but never propagate to the caller to keep the Redis write path unblocked.
 *
 * @param guestPda   - The guest's Solana public key (used as the document ID)
 * @param state      - The full room device state snapshot to persist
 */
export async function syncGuestPreferencesToFirestore(
  guestPda: string,
  state: RoomDeviceState
): Promise<void> {
  try {
    const db = getFirestore();
    const now = new Date();

    // Generate a deterministic avatar URL from the wallet address.
    // DiceBear identicon is unique per PDA — no user upload or Storage bucket needed.
    // Swap the style slug (identicon / bottts / pixel-art) to match your UI design.
    const avatarUrl = `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(guestPda)}`;

    // 1. Upsert top-level guest profile
    const guestRef = db.collection("guests").doc(guestPda);
    await guestRef.set(
      {
        guestPda,
        avatarUrl,       // deterministic — safe to overwrite every time
        lastSeenAt: now,
        createdAt: now,  // merge: true ensures this is only set on first write
      },
      { merge: true }
    );

    // 2. Append preference snapshot to subcollection
    // Using a timestamp-based auto-ID ensures an ordered, append-only history.
    const sessionId = now.toISOString().replace(/[:.]/g, "-");
    await guestRef.collection("preferences").doc(sessionId).set({
      roomId: state.roomId,
      lighting: state.lighting,
      hue: {
        color: state.hue.color,
        brightness: state.hue.brightness,
        on: state.hue.on,
      },
      nest: {
        temp: state.nest.temp,
        mode: state.nest.mode,
      },
      music: state.music,
      music_url: state.music_url ?? null,
      lastUpdatedAt: state.lastUpdatedAt,
      recordedAt: now,
    });

    logger.info(
      { guestPda, sessionId, lighting: state.lighting, music: state.music, music_url: state.music_url },
      "firestore_guest_preferences_synced"
    );
  } catch (err) {
    // Non-fatal: Firestore unavailability must never block the IoT pipeline.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ guestPda, err: message }, "firestore_sync_failed_non_blocking");
  }
}

/**
 * Fetches a guest's Firestore profile and their N most recent preference sessions.
 *
 * @param guestPda  - The guest's Solana public key
 * @param limit     - Max number of preference sessions to return (default: 10)
 * @returns         - Profile + ordered session history, or null if guest not found
 */
export async function getGuestProfile(
  guestPda: string,
  limit = 10
): Promise<{
  profile: Record<string, any>;
  preferences: Record<string, any>[];
} | null> {
  const db = getFirestore();

  const guestRef = db.collection("guests").doc(guestPda);
  const profileSnap = await guestRef.get();

  if (!profileSnap.exists) {
    return null;
  }

  // Fetch N most recent sessions, ordered by recordedAt descending
  const prefSnaps = await guestRef
    .collection("preferences")
    .orderBy("recordedAt", "desc")
    .limit(limit)
    .get();

  const preferences = prefSnaps.docs.map((doc) => ({
    sessionId: doc.id,
    ...doc.data(),
    // Convert Firestore Timestamps to ISO strings for JSON serialization
    recordedAt: doc.data().recordedAt?.toDate?.()?.toISOString() ?? doc.data().recordedAt,
  }));

  return {
    profile: {
      ...profileSnap.data(),
      // Convert Timestamps to ISO strings
      createdAt: profileSnap.data()?.createdAt?.toDate?.()?.toISOString() ?? profileSnap.data()?.createdAt,
      lastSeenAt: profileSnap.data()?.lastSeenAt?.toDate?.()?.toISOString() ?? profileSnap.data()?.lastSeenAt,
    },
    preferences,
  };
}

/**
 * Updates a guest's profile with a new avatar URL.
 *
 * @param guestPda   - The guest's Solana public key
 * @param avatarUrl  - The new avatar URL to store
 */
export async function updateGuestAvatar(guestPda: string, avatarUrl: string): Promise<void> {
  const db = getFirestore();
  const guestRef = db.collection("guests").doc(guestPda);

  // We use merge: true to ensure we create the document if it doesn't exist,
  // or just update the avatarUrl and lastSeenAt if it does.
  await guestRef.set(
    {
      guestPda,
      avatarUrl,
      lastSeenAt: new Date(),
    },
    { merge: true }
  );

  logger.info({ guestPda, avatarUrl }, "guest_avatar_updated");
}

/**
 * Updates a guest's profile with a summarized persona generated by AI.
 *
 * @param guestPda - The guest's Solana public key
 * @param persona  - The AI-generated persona summary
 */
export async function updateGuestPersona(guestPda: string, persona: string): Promise<void> {
  const db = getFirestore();
  const guestRef = db.collection("guests").doc(guestPda);

  await guestRef.set(
    {
      guestPda,
      persona,
      lastSeenAt: new Date(),
    },
    { merge: true }
  );

  logger.info({ guestPda, personaLength: persona.length }, "guest_persona_updated");
}

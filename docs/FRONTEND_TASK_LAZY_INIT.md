# 🚀 Frontend Task: Implement Lazy Initialization & Sync Hash Logic

## 🎯 Background & Problem Statement
During recent tests with a new user (`kyle@getorin.xyz`), the Solana transaction via the Gas Relayer failed with the following error:
`AnchorError caused by account: guest_profile. Error Code: AccountNotInitialized.`

This occurs because the frontend is sending an `updatePreferences` instruction to the blockchain for a `guest_profile` PDA that hasn’t been allocated yet. Since the transaction bypasses the initial `initializeGuest` instruction for new users, the validator rejects the transaction. 

Additionally, the backend recently underwent a structural refactor to properly decouple `preferences` from the metadata (`guestPda`, `guestContext`). The frontend needs a minor update to ensure its local hashing aligns synchronously with the new backend validation.

## ✅ Acceptance Criteria

### 1. Implement Lazy Initialization (Atomic Transaction)
**File**: `frontend/src/lib/solana.ts` -> `updatePreferencesOnChain`
- Before creating the `updatePreferences` transaction, verify if the `guestPda` exists on-chain using `connection.getAccountInfo(guestPda)`.
- If the account returns `null` (not initialized), seamlessly string together an `initializeGuest` instruction **inside the exact same transaction array** prior to `updatePreferences`. 
- Since we use the Gas Relayer, both the Initialization Rent and Update gas will be correctly covered by the server fee-payer in a single atomic transaction.

**Pseudo-logic Guidance**:
```typescript
const accountInfo = await connection.getAccountInfo(guestPda);

const tx = new Transaction({ recentBlockhash: blockhash, feePayer: opts!.feePayerPubkey });

// Lazy Init
if (!accountInfo) {
  // CRITICAL: PDA Seed now MUST include ownerPubkey to prevent squatting attacks
  // const [guestPda] = PublicKey.findProgramAddressSync([Buffer.from("guest"), identifierHash, ownerPubkey.toBuffer()], programId);
  const initIx = await program.methods
    .initializeGuest(Array.from(identifierHash), guestName)
    .accounts({
      guestProfile: guestPda,
      user: ownerPubkey,
      feePayer: opts!.feePayerPubkey,   // Server covers rent
      systemProgram: SystemProgram.programId,
    }).instruction();
  tx.add(initIx);
}

// Proceed with update
const updateIx = await program.methods
  .updatePreferences(Array.from(preferencesHash))
  .accounts({ guestProfile: guestPda, owner: ownerPubkey })
  .instruction();

tx.add(updateIx);
// ... proceed to sign and relay ...
```
*(Note: You will need to physically pass `identifierHash` and `guestName` from the UI layer into `updatePreferencesOnChain` to support the creation flow.)*

---

### 2. Update Direct Bypass Hash Logic
**File**: `frontend/src/lib/savePreferences.ts` -> `saveManualPreferences`
- The backend's `/api/v1/preferences` now only hashes the inner `preferences` object instead of the whole wrapper body to stay strictly aligned with the AI output structure.
- **Action**: Stop generating the hash locally on the entire `canonicalBody`. Instead, rely purely on the deterministic hash returned by the backend (which matches what the AI pipeline does).

**Code Change Example**:
```typescript
const apiResponse = await stageManualPreferences(canonicalBody);

// ❌ REMOVE this outdated logic:
// const hashBytes = await generateSha256Hash(canonicalBody);
// const hashHex = Array.from(hashBytes).map(...).join("");

// ✅ ADD the backend's source of truth:
const hashHex = apiResponse.hash;
if (!hashHex) throw new Error("Backend did not return a canonical Hash.");
const hashBytes = new Uint8Array(hashHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
```

## 🔗 Technical Context
- **Relayer**: `POST /api/v1/relay`
- **Severity**: High (Blocks new user onboarding / causes gas relay failures for new PDAs)

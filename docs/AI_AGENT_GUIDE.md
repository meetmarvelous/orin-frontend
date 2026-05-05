# ORIN AI Agent Guide (Groq + Deepgram)

This document explains the backend AI agent implementation at:

- `backend/src/ai_agent.ts`

It is designed for ORIN's Web2.5 Hybrid Privacy model:

`Voice Command -> AI JSON -> SHA-256 Hash -> On-chain Hash Lock`

## 1. Purpose

The AI agent transforms natural-language guest requests into a strict JSON payload that can be:

1. Used as off-chain private data.
2. Hashed with SHA-256.
3. Verified against Solana `preferences_hash: [u8; 32]`.

## 2. Main Class

`OrinAgent` handles:

- LLM inference with Groq
- Strict JSON parsing
- Runtime schema validation
- Deterministic SHA-256 generation for hash-lock
- Voice synthesis output via Deepgram

## 3. Input/Output Contract

### Input (`processCommand`)

```ts
processCommand(userInput: string, guestContext: GuestContext)
```

`GuestContext`:

```ts
{
  name: string;
  loyaltyPoints: number;
  history: string[];
}
```

### Output (strict JSON payload)

```json
{
  "temp": 22.5,
  "lighting": "warm",
  "services": ["tea", "late_checkout"],
  "raw_response": "Señor/a, ya ajusté su habitación y coordiné sus servicios."
}
```

Allowed `lighting` values:

- `warm`
- `cold`
- `ambient`

No extra keys are allowed.

## 4. Hash-Lock Logic

The function:

- `generateHash(data: object): Buffer`

creates a 32-byte SHA-256 hash from a canonicalized JSON string.

Canonicalization guarantees stable hashes for the same semantic payload.

## 5. Deepgram Voice Integration

Method:

- `speak(text: string): Promise<Buffer>`

Behavior:

- Sends `raw_response` text to Deepgram API.
- Returns audio as `Buffer` (MPEG bytes).
- Throws detailed errors on non-200 responses.

## 6. Environment Variables

Required:

- `GROQ_API_KEY`
- `DEEPGRAM_API_KEY`

Optional:

- `GROQ_MODEL` (default: `llama-3.1-8b-instant`)
- `DEEPGRAM_TTS_MODEL` (default: `aura-2-orion-en`)


## 7. Dependencies

Installed in `backend/package.json`:

- `@langchain/core`

## 8. Minimal Usage Example

```ts
import { OrinAgent } from "./ai_agent";

const agent = new OrinAgent();

const { payload, hash } = await agent.processCommand(
  "Tengo frío, bajá las luces y pedime un té.",
  {
    name: "Federico",
    loyaltyPoints: 1240,
    history: ["prefiere luz cálida", "solicita té por la noche"]
  }
);

// Store payload off-chain; send hash on-chain.
console.log(payload, hash.toString("hex"));

const audio = await agent.speak(payload.raw_response);
```

## 9. Error Handling Notes

- Missing API keys throw explicit errors.
- Invalid or malformed JSON output from model is rejected.
- Any schema drift (extra/missing keys, invalid types) throws.
- Deepgram HTTP failures are surfaced with status + body.




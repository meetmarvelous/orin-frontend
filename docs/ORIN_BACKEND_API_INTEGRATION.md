# ORIN Backend API Integration Guide

> ⚠️ **IMPORTANT UPDATE (2026-04):** We have made structural changes to API schemas to correctly support Hash-Lock caching. If your frontend transactions are failing with `AccountNotInitialized`, please read the critical fix required in your Solana relay logic here: [Frontend Lazy Init Task](./FRONTEND_TASK_LAZY_INIT.md)

This document outlines the frontend integration with the ORIN production backend. The backend acts as the AI Gateway, orchestrating voice processing, LLM inference, caching, direct bypass mechanisms, and Solana transaction relayer.

## Global Requirements

- **CORS Requirements**: The backend has credentialed CORS setup (`credentials: true`).
- **Authentication**: **Every** endpoint requires an `X-API-KEY` header matching the backend's configured key.
- **Content-Type**: Requests should use `Content-Type: application/json` unless otherwise specified (like file uploads).

---

## 1. Core Flows

### 1.1 Voice Command Workflow (AI Intent Resolution)
Used when a user speaks a command. The backend uses the AI agent to parse the intent, caches the result in Redis, and returns a SHA-256 hash. The frontend uses this hash to mint the Solana transaction.

- **Endpoint**: `POST /api/v1/voice-command`
- **Request Body**:
```json
{
  "guestPda": "EP1c... (Base58 Pubkey string)",
  "userInput": "Turn down the temperature to 68 degrees",
  "guestContext": {
    "name": "John Doe",
    "loyaltyPoints": 1200,
    "history": ["prefers cold rooms", "ordered wine earlier"]
  }
}
```
- **Response** `(200 OK)`:
```json
{
  "status": "accepted",
  "guestPda": "EP1c... (same as input)",
  "hash": "a1b2c3d4e5f6... (hex-encoded SHA-256 string)",
  "aiResult": {
    "temp": 68,
    "lighting": "ambient",
    "services": [],
    "raw_response": "Temperature reduced to 68 degrees."
  },
  "message": "Command parsed by AI. Awaiting on-chain hash-lock validation."
}
```
> **Frontend Action**: Take the returned `hash`, build a Solana transaction to update the Guest account, and ask the wallet to sign it.

### 1.2 Direct Bypass Workflow (Manual UI Interaction)
Used when a user manually interacts with the UI (e.g., using a slider to change the temperature). It bypasses the AI inference, calculates the deterministic hash, stages it in Redis, and returns the hash for transaction signing.

- **Endpoint**: `POST /api/v1/preferences`
- **Request Body**:
```json
{
  "guestPda": "EP1c... (Base58 Pubkey string)",
  "brightness": 80, 
  "preferences": {
    "temp": 68,
    "lighting": "ambient",
    "services": []
  },
  "guestContext": {
    "name": "John Doe",
    "history": []
  }
}
```
- **Response** `(200 OK)`:
```json
{
  "status": "success",
  "info": "Payload staged in Redis cache bypassing AI. Awaiting Solana Hash Verification signal.",
  "hash": "b2c3d4e5f6a7... (hex-encoded SHA-256 string)"
}
```

---

## 2. Voice & Speech Endpoints

### 2.1 Audio Transcription (Speech-to-Text)
Transcribes user audio using Deepgram's Prerecorded API (Zero Disk I/O).
[listener] {"level":30,"time":"2026-03-30T11:45:39.329Z","request_id":"6ed3d57c-b6c0-40c3-9a1d-ba036e5a4db1","path":"/home/meng/ORIN/orin-core/backend/response.mp3","msg":"voice_feedback_written"}
- **Endpoint**: `POST /api/v1/transcribe`
- **Headers**: 
  - `Content-Type: multipart/form-data`
  - `X-API-KEY: <your-api-key>`
- **Request Body**: A `.file()` FormData object containing the raw audio buffer (max 10MB).
- **Response** `(200 OK)`:
```json
{
  "status": "success",
  "text": "Turn down the temperature to 68 degrees"
}
```

### 2.2 Fast Voice Feedback (Low-Latency TTS)
An additive endpoint used to fetch highly-optimized TTS audio (sub-second latency). It uses cached intents, Quick Replies, and ACKs so the AI can physically respond "Dame un segundo" while the heavy on-chain transaction processes in the background.

- **Endpoint**: `POST /api/v1/voice-fast`
- **Request Body**:
```json
{
  "userInput": "Turn down the temp",
  "guestContext": { ... }, // Optional
  "deviceId": "device-uuid-123" // Optional (Maintains local history cache)
}
```
- **Response** `(200 OK)`:
```json
{
  "status": "ok",
  "mimeType": "audio/mpeg",
  "audioBase64": "SUQzBAAAAAAAI1RTU0Uy... (Base64 MP3 Audio)",
  "text": "Dame un segundo y lo resuelvo.",
  "latencyMs": {
    "llm": 120,
    "tts": 230,
    "total": 350
  },
  "cached": false,
  "fastIntent": false,
  "ack": true
}
```
> **Frontend Action**: Decode the `audioBase64` payload into a Blob and play it directly via the HTML5 `<audio>` API.

### 2.3 Streaming Speech-to-Text (WebSocket)
Streams microphone audio directly to the backend for real-time transcription and instant AI feedback.

- **URL**: `ws://<backend-url>/api/v1/stt-stream`
- **Headers**: `X-API-KEY: <your-api-key>` *(Note: If using native browser WebSockets that don't allow custom headers, you may need a client-side workaround or protocol update).*
- **Send**:
  - `Binary Data`: Send audio chunks as they are captured.
  - `JSON String`: `{"type": "stop"}` (Triggers the final transcription sequence).
- **Receive (Events)**:
  - `{"type": "ready"}`: Connection established.
  - `{"type": "transcript", "text": "Turn down...", "final": false}`: Partial/Interim transcript.
  - `{"type": "reply", "text": "Sure.", "mimeType": "audio/mpeg", "audioBase64": "..."}`: The LLM TTS reply fired.
  - `{"type": "done", "text": "Turn down the temp."}`: Stream closed.
  - `{"type": "error", "error": "..."}`: Error handler.

---

## 3. Solana Account Abstraction

### 3.1 Transaction Relayer
Enables zero-gas interactions for the guest. The frontend partially signs the transaction (authorizing the instruction) and sends the serialized transaction to this endpoint. The backend server acts as the fee payer, adding its co-signature and broadcasting to the blockchain.

- **Endpoint**: `POST /api/v1/relay`
- **Request Body**:
```json
{
  "transaction": "AQAAAAAAAAAAAAAAAAAAAA... (Base64 Encoded Serialized Transaction)"
}
```
- **Response** `(200 OK)`:
```json
{
  "status": "success",
  "signature": "5k1x... (Solana Transaction ID)",
  "feePayerPubkey": "FPya... (Server's Pubkey)"
}
```
> **Security Note**: Ensure a recent blockhash is attached to the transaction before serialization to prevent relay replay attacks. The Anchor backend ensures `owner` signature constraints.
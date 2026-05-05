# ORIN Frontend

> The ambient intelligence interface for ORIN - every space knows your song.

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Language:** TypeScript
- **Styling:** Vanilla CSS (Cormorant Garamond + DM Mono)
- **Blockchain:** Solana Devnet via `@coral-xyz/anchor` + `@solana/web3.js`
- **Wallet:** `@solana/wallet-adapter-react`

## Getting Started

```bash
cd frontend
npm install
npm run dev
```

## Project Structure

```
src/
|-- app/
|   |-- layout.tsx          # Root layout (fonts, wallet provider)
|   |-- page.tsx            # Main page (nav, room control, footer)
|   `-- globals.css         # ORIN design system
|-- components/
|   `-- RoomControl.tsx     # Room control UI (modes, sliders, save)
|-- providers/
|   `-- SolanaWalletProvider.tsx
`-- lib/
    |-- hash.ts             # Canonical stableStringify + SHA-256
    |-- pda.ts              # Guest PDA derivation from email
    |-- api.ts              # Backend API client (POST /api/v1/voice-command)
    |-- solana.ts           # Anchor program interactions
    `-- savePreferences.ts  # Steps A -> B -> C orchestrator
```

## Hash-Lock Workflow

The frontend implements a privacy-first 3-step flow:

1. **Step A** - Send raw command to backend API (staged in Redis)
2. **Step B** - Compute SHA-256 hash locally using canonical JSON serialization
3. **Step C** - Write only the 32-byte hash to Solana (`updatePreferences`)

The backend listener verifies on-chain hash against AI-generated payload hash before triggering IoT devices.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL | `` |
| `NEXT_PUBLIC_RPC_ENDPOINT` | Solana RPC endpoint | Devnet |

## IDL Setup

Copy the Anchor IDL to the public folder for runtime loading:

```bash
cp ../target/idl/orin_identity.json public/orin_identity.json
```

## Build

```bash
npm run build
```

## Deployment

Compatible with Vercel, Netlify, or any Node.js hosting. Set the root directory to `frontend/` in your deployment config.

## .env.local.example
# 1. Point to the Solana node on your local machine where the protocol was just successfully implemented (if left blank, the frontend will connect to Devnet by default).
# NEXT_PUBLIC_RPC_ENDPOINT=http://127.0.0.1:8899

# 2. Point to the main API gateway (port 3001) that you just started running on your local machine.
NEXT_PUBLIC_API_URL=http://127.0.0.1:3001
NEXT_PUBLIC_API_KEY=orin_secret_key_2026_dev

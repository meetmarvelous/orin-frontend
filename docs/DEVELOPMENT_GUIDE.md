# ORIN Core Development Guide

Welcome to the ORIN Core architecture. This guide is the "Developer Bible" for navigating our local environment, running our Solana/Anchor test suite, and triggering our full-stack IoT/Firebase simulators.

We built this stack to decouple Smart Contracts from Frontend Development. You do not need a completed UI to test the ambient device sync layer, nor do you need real IoT hardware to see the data flow.

---

## 1. Local Network Initialization (Solana Localnet)

To prevent cluttering Devnet during heavy testing and logic iterations, rely firmly on the local test validator.

**Spin up the local blockchain:**
1. Open a new, dedicated terminal window.
2. Run the validator:
   ```bash
   solana-test-validator
   ```
3. Keep this terminal running in the background. It will simulate a 400ms block-time environment on `http://127.0.0.1:8899`.

---

## 2. Smart Contract Testing (`anchor test`)

The Anchor tests (`tests/orin_identity.ts`) are our source of truth for the decentralized logic.

**Run the suite:**
```bash
anchor test --skip-local-validator
```
*(Note: Use `--skip-local-validator` if you already have `solana-test-validator` running).*

### The 3 Critical Test Cases Explained:

1. **"Initializes a new Guest Identity!"**
   - **Business Logic**: Proves that an off-chain identity (an Email) can be successfully hashed and converted into a permanent, deterministic Program Derived Address (PDA) on Solana. It validates that initial variables (like defaults and `stayCount: 0`) are correctly allocated in blockspace.

2. **"Updates the Guest's Ambient Preferences!"**
   - **Business Logic**: Simulates the core IoT trigger mechanism. The user pushes a new environment JSON payload (e.g., Temperature, Lighting). This test asserts that the space mutation saves accurately and increments the interaction counters (`stayCount: 1`), proving the chain can act as a reliable source of truth for physical changes.

3. **"Fails when an unauthorized user tries to update preferences"**
   - **Business Logic**: Our ironclad Access Control defense. This confirms the Anchor macro `has_one = owner` executes perfectly. Any external wallet or attacker attempting to call `update_preferences` on an identity they do not own will encounter an explicit `UnauthorizedAccess` rejection.

---

## 3. The Full-Stack Simulator (Frontend -> Backend Bridge)

We designed a mechanism to test the *entire* event-driven architecture without a frontend.

**Step 1: Start the Node.js Listener**
Open a new terminal, navigate to the backend, and start the sync daemon.
```bash
cd backend
yarn start
```
*This listener opens a WebSocket connection to the Solana validator, waiting for account mutations.*

**Step 2: Fire the Simulator**
Open *another* terminal, navigate to the backend, and run:
```bash
yarn simulate
```
This is our **Developer Trick**. It bypasses the need for a UI by instantly compiling and firing actual raw Transactions to your local validator. 

**What happens?**
1. The simulator signs and commits the transactions to `solana-test-validator`.
2. The `yarn start` listener catches the RPC event in milliseconds.
3. You will immediately see the Backend terminal parse the data, dispatch fake IoT (MQTT) calls to Philips Hue/Nest topics, and attempt to sync to Firebase.

---

## 4. Firebase Graceful Degradation (Mocking)

Our architecture requires Firebase to provide real-time, low-latency state updates (so the Frontend doesn't have to poll the Solana RPC). 

To prevent developers from encountering `Google OAuth2 / invalid-credential` terminal crashes when first cloning the repo, the system implements a **Graceful Mocking Fallback**.

**How it works:**
Inside `backend/src/listener.ts`, the script checks for `process.env.GOOGLE_APPLICATION_CREDENTIALS`.
- **If missing**: It simply bypasses the actual network request and simulates a success log (`[Firebase Sync Mock] WARNING: Bypassing real Firebase hit`).
- **If present**: It securely authenticates and pushes updates to the live RTDB.

**When you are ready to use real Firebase:**
1. Generate a Service Account JSON from your Firebase/GCP Console.
2. Store it securely (e.g., `~/.config/orin-service-account.json`).
3. Inject the credential path before starting the listener:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/orin-service-account.json"
   yarn start
   ```

---

*"Code is law, but execution is reality"*  
**Built with passion by the ORIN Core Team for the Solana Network State Spring 2026**

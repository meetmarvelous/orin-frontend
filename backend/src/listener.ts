import { BorshCoder, Idl } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import mqtt from "mqtt";
import { OrinAgent } from "./ai_agent";
import { validateEnvOrExit } from "./config/validate_env";
import { ANCHOR_ACCOUNTS, IO_TOPICS, PATHS, PROGRAM_ID, RPC_ENDPOINT } from "./shared/constants";
import { createRequestLogger, logger } from "./shared/logger";
import { stateProvider } from "./state";
import { GuestContext } from "./ai_agent";
import { getEnv } from "./config/env";
import { RoomDeviceState } from "./state/IStateProvider";

validateEnvOrExit();

const env = getEnv();
const connection = new Connection(RPC_ENDPOINT, "confirmed");
const agent = new OrinAgent();

const idlPath = path.resolve(__dirname, PATHS.IDL_PATH);
const audioPath = path.resolve(__dirname, PATHS.AUDIO_OUTPUT);
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
const coder = new BorshCoder(idl);

const mqttClient = mqtt.connect(env.MQTT_BROKER_URL);
mqttClient.on("connect", () => logger.info("mqtt_connected"));
mqttClient.on("error", (err) => logger.error({ err: err.message }, "mqtt_error"));

function isAllZeroHash(hash: Buffer): boolean {
  return hash.every((b) => b === 0);
}

function readPreferencesHash(decodedAccount: any): Buffer {
  const rawHash = decodedAccount?.preferencesHash ?? decodedAccount?.preferences_hash;
  if (!rawHash) {
    throw new Error("preferences_hash field not found in decoded GuestIdentity account.");
  }
  return Buffer.from(rawHash);
}

function buildGuestContext(decodedAccount: any): GuestContext {
  return {
    name: decodedAccount?.name ?? "Guest",
    loyaltyPoints: Number(decodedAccount?.loyaltyPoints ?? decodedAccount?.loyalty_points ?? 0),
    history: ["prefers comfort at night", "expects fast response"],
  };
}

export function startSecureGatewayListener(): number {
  logger.info(
    { rpc_endpoint: RPC_ENDPOINT, program_id: PROGRAM_ID.toBase58() },
    "secure_gateway_listener_start"
  );

  return connection.onProgramAccountChange(
    PROGRAM_ID,
    async (updated, context) => {
      const requestLog = createRequestLogger();
      const guestPda = updated.accountId.toBase58();

      requestLog.info({ guest_pda: guestPda, slot: context.slot }, "account_mutation_detected");

      try {
        const decodedAccount = coder.accounts.decode(
          ANCHOR_ACCOUNTS.GUEST_IDENTITY,
          updated.accountInfo.data
        ) as any;

        const onChainHash = readPreferencesHash(decodedAccount);
        const onChainHashHex = onChainHash.toString("hex");

        if (isAllZeroHash(onChainHash)) {
          requestLog.info("zero_hash_initialization_event_skip");
          return;
        }

        const lastHash = await stateProvider.getLastProcessedHash(guestPda);
        if (lastHash === onChainHashHex) {
          requestLog.info({ hash: onChainHashHex }, "duplicate_hash_skip");
          return;
        }
        await stateProvider.setLastProcessedHash(guestPda, onChainHashHex);

        let payload: any;
        let aiHash: Buffer;

        // Bypassing AI for direct manual payload from /api/preferences
        const directPayload = await stateProvider.getDirectPayload(onChainHashHex);

        if (directPayload) {
          requestLog.info({ hash: onChainHashHex }, "direct_payload_cache_hit_bypassing_ai");
          payload = directPayload;
          aiHash = onChainHash; // Forced match since we queried Redis directly by the valid Hash
        } else {
          // Standard AI processing flow
          const pending = await stateProvider.getPendingCommand(guestPda);
          if (!pending) {
            requestLog.warn("no_pending_command_for_guest_skip");
            return;
          }

          const guestContext = buildGuestContext(decodedAccount);
          const aiResult = await agent.processCommand(
            pending.userInput,
            pending.guestContext ?? guestContext
          );
          payload = aiResult.payload;
          aiHash = aiResult.hash;
        }

        if (!aiHash.equals(onChainHash)) {
          requestLog.error(
            {
              on_chain_hash: onChainHashHex,
              ai_hash: aiHash.toString("hex"),
            },
            "Posible ataque de Man-in-the-Middle o desincronía de estado"
          );
          return;
        }

        const mqttPayload = JSON.stringify({
          lighting: payload.lighting,
          temp: payload.temp,
          services: payload.services,
        });

        mqttClient.publish(IO_TOPICS.ROOM_CONTROL, mqttPayload, async (err?: Error) => {
          if (err) {
            requestLog.error({ err: err.message }, "mqtt_publish_error");
            return;
          }

          requestLog.info(
            { topic: IO_TOPICS.ROOM_CONTROL, payload: mqttPayload },
            "mqtt_publish_success"
          );

          // Build and persist full room device snapshot to Redis.
          // Both the api and listener processes share this state via stateProvider.
          const COLOR_MAP: Record<string, string> = {
            warm: "#FFB347",
            cold: "#99CCFF",
            ambient: "#FFFFFF",
          };
          // Resolve temperature: AI output uses `temp`, frontend direct payload uses `target_temp_c`
          const resolvedTemp: number = payload.temp ?? (payload as any).target_temp_c ?? 22;

          const deviceSnapshot: RoomDeviceState = {
            roomId: "Room_"+guestPda.slice(0,4),
            hue: {
              color: COLOR_MAP[payload.lighting] ?? "#FFFFFF",
              brightness: typeof payload.brightness === "number" ? payload.brightness : 80,
              on: true,
            },
            lighting: payload.lighting,
            nest: {
              temp: resolvedTemp,
              mode: resolvedTemp >= 24 ? "COOL" : "HEAT",
            },
            music: payload.music ?? "",
            music_url: payload.music_url,
            lastUpdatedAt: new Date().toISOString(),
            lastGuestPda: guestPda,
          };
          await stateProvider.setDeviceState(deviceSnapshot.roomId, deviceSnapshot);

          await stateProvider.setValidatedState({
            guestPda,
            hashHex: onChainHashHex,
            payload,
            validatedAt: Date.now(),
          });
          await stateProvider.clearPendingCommand(guestPda);
        });

        if (payload.raw_response) {
          const audioBuffer = await agent.speak(payload.raw_response);
          await fs.promises.writeFile(audioPath, audioBuffer);
          requestLog.info({ path: audioPath }, "voice_feedback_written");
        } else {
          requestLog.info("no_raw_response_skip_voice");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        requestLog.error({ err: message }, "secure_gateway_processing_error");
      }
    },
    "confirmed"
  );
}

if (require.main === module) {
  startSecureGatewayListener();
}


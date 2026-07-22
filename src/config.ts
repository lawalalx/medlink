import "dotenv/config";
import path from "node:path";

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: numEnv(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  urls: {
    remoteUrl: process.env.REMOTE_URL || "",
  },

  meta: {
    apiVersion: process.env.WHATSAPP_API_VERSION || "v22.0",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID || "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    callbackUrl: process.env.WHATSAPP_CALLBACK_URL || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || "",
    validateSignature: boolEnv(process.env.WHATSAPP_VALIDATE_SIGNATURE, false),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  },

  backend: {
    baseUrl: (process.env.BACKEND_BASE_URL || "http://localhost:3000").replace(/\/$/, ""),
    intakePath: process.env.BACKEND_INTAKE_PATH || "/api/cases/intake",
    simulatePath: process.env.BACKEND_SIMULATE_PATH || "/api/meta/simulate-patient",
    replyPathTemplate: process.env.BACKEND_REPLY_PATH_TEMPLATE || "/api/cases/:id/reply",
    apiToken: process.env.BACKEND_API_TOKEN || "",
    timeoutMs: numEnv(process.env.BACKEND_TIMEOUT_MS, 15000),
  },

  hmo: {
    timeoutMs: numEnv(process.env.HMO_VERIFY_TIMEOUT_MS, 8000),
    connectors: {
      reliance: {
        url: process.env.RELIANCE_HMO_VERIFY_URL || "",
        apiKey: process.env.RELIANCE_HMO_API_KEY || "",
      },
      hygeia: {
        url: process.env.HYGEIA_HMO_VERIFY_URL || "",
        apiKey: process.env.HYGEIA_HMO_API_KEY || "",
      },
      avon: {
        url: process.env.AVON_HMO_VERIFY_URL || "",
        apiKey: process.env.AVON_HMO_API_KEY || "",
      },
      axa: {
        url: process.env.AXA_HMO_VERIFY_URL || "",
        apiKey: process.env.AXA_HMO_API_KEY || "",
      },
    },
  },

  stateFilePath: path.resolve(process.cwd(), process.env.STATE_FILE_PATH || "./data/state.json"),
};

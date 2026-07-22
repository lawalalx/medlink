import "dotenv/config";
import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { metaWebhookHandler, verifyMetaWebhook } from "./routes/webhook.js";
import { processInbound } from "./services/flow-engine.js";
import { sendConsentPrompt, sendText } from "./services/meta-client.js";
import { normalizeWhatsAppPhone } from "./utils/phone.js";
import { proxyDoctorReply } from "./services/backend-client.js";
import { stateStore } from "./store/state-store.js";

const app = express();

const serverUrl =
  config.urls.remoteUrl.replace(/\/$/, "")

const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "MedLink WhatsApp Agent API",
    version: "1.0.0",
    description:
      "API docs for MedLink WhatsApp webhook intake, simulation, and doctor reply proxy endpoints.",
  },
  servers: [
    {
      url: serverUrl,
      description: "Resolved public/base URL for this deployment",
    },
  ],
  tags: [
    { name: "Health", description: "Service liveness endpoints" },
    { name: "Webhook", description: "Meta WhatsApp webhook verification and inbound events" },
    { name: "Agent", description: "Triage simulation and patient state inspection" },
    { name: "Doctor", description: "Doctor response relay/proxy endpoints" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Service health check",
        responses: {
          "200": {
            description: "Service is healthy",
          },
        },
      },
    },
    "/webhook/whatsapp": {
      get: {
        tags: ["Webhook"],
        summary: "Meta webhook verification",
        parameters: [
          {
            name: "hub.mode",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["subscribe"] },
          },
          {
            name: "hub.verify_token",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "hub.challenge",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Verification successful" },
          "403": { description: "Forbidden" },
        },
      },
      post: {
        tags: ["Webhook"],
        summary: "Receive Meta WhatsApp events",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
        responses: {
          "200": { description: "Event received" },
        },
      },
    },
    "/webhook": {
      get: {
        tags: ["Webhook"],
        summary: "Legacy webhook verification alias",
        deprecated: true,
        responses: {
          "200": { description: "Verification successful" },
          "403": { description: "Forbidden" },
        },
      },
      post: {
        tags: ["Webhook"],
        summary: "Legacy inbound webhook alias",
        deprecated: true,
        responses: {
          "200": { description: "Event received" },
        },
      },
    },
    "/api/meta/simulate-patient": {
      post: {
        tags: ["Agent"],
        summary: "Simulate patient message",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  patientPhone: { type: "string" },
                  message: { type: "string" },
                },
                required: ["patientPhone"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Simulation response" },
          "400": { description: "Invalid payload" },
        },
      },
    },
    "/api/cases/{id}/reply": {
      post: {
        tags: ["Doctor"],
        summary: "Proxy doctor reply to backend",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  responseMessage: { type: "string" },
                  outcome: { type: "string", enum: ["resolved", "needs_visit", "pending_followup"] },
                },
                required: ["responseMessage", "outcome"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Reply forwarded" },
          "500": { description: "Proxy failure" },
        },
      },
    },
    "/api/patients": {
      get: {
        tags: ["Agent"],
        summary: "List in-memory patient states",
        responses: {
          "200": { description: "Current patients in state store" },
        },
      },
    },
  },
};

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "medlink-whatsapp-agent",
    time: new Date().toISOString(),
  });
});

app.get("/webhook/whatsapp", verifyMetaWebhook);
app.post("/webhook/whatsapp", metaWebhookHandler);

// Backward-compatible aliases
app.get("/webhook", verifyMetaWebhook);
app.post("/webhook", metaWebhookHandler);

const simulateSchema = z.object({
  patientPhone: z.string().min(8),
  message: z.string().default(""),
});

app.post("/api/meta/simulate-patient", async (req, res) => {
  try {
    const parsed = simulateSchema.parse(req.body);
    const patientPhone = normalizeWhatsAppPhone(parsed.patientPhone);

    const result = await processInbound({
      patientPhone,
      text: parsed.message,
      source: "simulate",
    });

    if (result.sendConsentTemplate) {
      await sendConsentPrompt(patientPhone);
    } else {
      await sendText(patientPhone, result.reply);
    }

    const state = stateStore.getPatient(patientPhone);

    res.json({
      patientPhone,
      userMessage: parsed.message,
      aiReply: result.reply,
      case: {
        id: state.lastCaseId || null,
        patientPhone,
        urgencyBand: state.lastUrgencyBand || "routine",
        status: state.triageStage === "done" ? "submitted" : "draft",
      },
      state,
    });
  } catch (error) {
    logger.error("simulate-patient failed", error);
    res.status(400).json({ error: "Invalid payload" });
  }
});

const doctorReplySchema = z.object({
  responseMessage: z.string().min(1),
  outcome: z.enum(["resolved", "needs_visit", "pending_followup"]),
});

app.post("/api/cases/:id/reply", async (req, res) => {
  try {
    const payload = doctorReplySchema.parse(req.body);
    const caseId = req.params.id;

    const response = await proxyDoctorReply(caseId, payload, req.headers.authorization);
    res.json(response);
  } catch (error: any) {
    logger.error("Doctor reply proxy failed", error);
    res.status(500).json({ error: error?.message || "proxy failed" });
  }
});

app.get("/api/patients", (_req, res) => {
  res.json({ patients: stateStore.listPatients() });
});

app.listen(config.port, () => {
  logger.info(`MedLink WhatsApp agent listening on port ${config.port}`);
  logger.info(`Swagger docs available at ${serverUrl}/docs`);

  const expectedWebhookUrl = `http://localhost:${config.port}/webhook/whatsapp`;
  if (!config.meta.callbackUrl) {
    logger.warn(
      `WHATSAPP_CALLBACK_URL is not set. Configure Meta webhook callback to your public /webhook/whatsapp URL (local expected path: ${expectedWebhookUrl}).`,
    );
  } else {
    logger.info(`Configured WHATSAPP_CALLBACK_URL: ${config.meta.callbackUrl}`);
    if (!/\/webhook(?:\/whatsapp)?\/?$/.test(config.meta.callbackUrl)) {
      logger.warn("WHATSAPP_CALLBACK_URL should typically end with /webhook/whatsapp for this service.");
    }
  }
});

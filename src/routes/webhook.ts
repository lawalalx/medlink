import type { Request, Response } from "express";
import { processInbound } from "../services/flow-engine.js";
import {
  sendConsentPrompt,
  sendText,
  fetchMediaUrl,
  sendTypingIndicator,
  sendInteractiveButtons,
  sendInteractiveList,
  sendPendingConsentButtonsForStatus,
} from "../services/meta-client.js";
import { normalizeWhatsAppPhone } from "../utils/phone.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

const processedInboundMessageIds = new Map<string, number>();
const INBOUND_DEDUPE_TTL_MS = 5 * 60 * 1000;

function cleanupProcessedIds(nowMs: number): void {
  for (const [messageId, ts] of processedInboundMessageIds.entries()) {
    if (nowMs - ts > INBOUND_DEDUPE_TTL_MS) {
      processedInboundMessageIds.delete(messageId);
    }
  }
}

export function verifyMetaWebhook(req: Request, res: Response): void {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");

  if (mode === "subscribe" && token === config.meta.verifyToken && challenge) {
    res.status(200).send(challenge);
    return;
  }

  res.status(403).send("Forbidden");
}

function pickInboundText(message: any): string {
  const text = typeof message?.text?.body === "string" ? message.text.body : "";
  const interactiveTitle =
    (typeof message?.interactive?.button_reply?.title === "string" && message.interactive.button_reply.title) ||
    (typeof message?.interactive?.list_reply?.title === "string" && message.interactive.list_reply.title) ||
    "";
  const interactiveId =
    (typeof message?.interactive?.button_reply?.id === "string" && message.interactive.button_reply.id) ||
    (typeof message?.interactive?.list_reply?.id === "string" && message.interactive.list_reply.id) ||
    "";

  return String(text || interactiveTitle || interactiveId || "").trim();
}

function pickContactProfileName(value: any, from: string): string {
  const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
  const fallbackContact = contacts[0];
  const matchedContact = contacts.find((contact: any) => {
    const waId = normalizeWhatsAppPhone(String(contact?.wa_id || ""));
    return !!waId && waId === from;
  });

  const profileName =
    String(matchedContact?.profile?.name || "") ||
    String(fallbackContact?.profile?.name || "");

  return profileName.trim();
}

export async function metaWebhookHandler(req: Request, res: Response): Promise<void> {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value || {};
        const statuses = Array.isArray(value?.statuses) ? value.statuses : [];

        for (const statusEvent of statuses) {
          const outboundMessageId = String(statusEvent?.id || "");
          const deliveryStatus = String(statusEvent?.status || "");
          if (!outboundMessageId) continue;

          try {
            await sendPendingConsentButtonsForStatus(outboundMessageId, deliveryStatus);
          } catch (error) {
            logger.warn("Failed to send pending consent buttons after status callback", {
              outboundMessageId,
              deliveryStatus,
              error,
            });
          }
        }

        const messages = Array.isArray(value?.messages) ? value.messages : [];
        const phoneNumberId = String(value?.metadata?.phone_number_id || "");

        for (const message of messages) {
          const from = normalizeWhatsAppPhone(String(message?.from || ""));
          if (!from) continue;

          const contactName = pickContactProfileName(value, from);

          const body = pickInboundText(message);
          const messageId = String(message?.id || "");
          if (messageId) {
            const nowMs = Date.now();
            cleanupProcessedIds(nowMs);
            if (processedInboundMessageIds.has(messageId)) {
              logger.info("Skipping duplicate inbound WhatsApp message", { messageId, from });
              continue;
            }
            processedInboundMessageIds.set(messageId, nowMs);
          }

          const mediaUrls: string[] = [];
          const mediaTypes: string[] = [];

          if (message?.type === "audio" && message?.audio?.id) {
            const audioUrl = await fetchMediaUrl(String(message.audio.id)).catch(() => null);
            if (audioUrl) mediaUrls.push(audioUrl);
            mediaTypes.push("audio");
          }

          if (message?.type === "image" && message?.image?.id) {
            const imageUrl = await fetchMediaUrl(String(message.image.id)).catch(() => null);
            if (imageUrl) mediaUrls.push(imageUrl);
            mediaTypes.push("image");
          }

          if (message?.type === "document" && message?.document?.id) {
            const docUrl = await fetchMediaUrl(String(message.document.id)).catch(() => null);
            if (docUrl) mediaUrls.push(docUrl);
            mediaTypes.push("document");
          }

          let intervalId: ReturnType<typeof setInterval> | undefined;
          try {
            // Initial typing ping + keep-alive while triage processing runs.
            if (messageId) {
              await sendTypingIndicator({
                to: from,
                messageId,
                phoneNumberId: phoneNumberId || undefined,
              }).catch(() => false);

              intervalId = setInterval(() => {
                void sendTypingIndicator({
                  to: from,
                  messageId,
                  phoneNumberId: phoneNumberId || undefined,
                }).catch(() => false);
              }, 8000);
            }

            const result = await processInbound({
              patientPhone: from,
              text: body,
              messageSid: messageId,
              mediaUrls,
              mediaContentTypes: mediaTypes,
              source: "meta_webhook",
            });

            if (result.sendConsentTemplate) {
              await sendConsentPrompt(from, contactName || undefined);
            } else if (result.buttonOptions?.length) {
              await sendInteractiveButtons({
                to: from,
                body: result.reply,
                buttons: result.buttonOptions,
              });
            } else if (result.choiceOptions?.length) {
              if (result.choiceOptions.length <= 3) {
                await sendInteractiveButtons({
                  to: from,
                  body: result.reply,
                  buttons: result.choiceOptions.map((option) => ({
                    id: option.id,
                    title: option.title,
                  })),
                });
              } else {
                await sendInteractiveList({
                  to: from,
                  body: result.reply,
                  options: result.choiceOptions,
                  buttonText: "Select",
                  sectionTitle: "Available options",
                });
              }
            } else {
              await sendText(from, result.reply);
            }
          } finally {
            if (intervalId) {
              clearInterval(intervalId);
            }
          }
        }
      }
    }

    res.status(200).json({ status: "received" });
  } catch (error) {
    logger.error("Meta webhook failure", error);
    res.status(200).json({ status: "received" });
  }
}

import type { Request, Response } from "express";
import { processInbound } from "../services/flow-engine.js";
import { sendConsentPrompt, sendText, fetchMediaUrl } from "../services/meta-client.js";
import { normalizeWhatsAppPhone } from "../utils/phone.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

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

  return String(text || interactiveId || interactiveTitle || "").trim();
}

export async function metaWebhookHandler(req: Request, res: Response): Promise<void> {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value || {};
        const messages = Array.isArray(value?.messages) ? value.messages : [];

        for (const message of messages) {
          const from = normalizeWhatsAppPhone(String(message?.from || ""));
          if (!from) continue;

          const body = pickInboundText(message);
          const messageId = String(message?.id || "");
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

          const result = await processInbound({
            patientPhone: from,
            text: body,
            messageSid: messageId,
            mediaUrls,
            mediaContentTypes: mediaTypes,
            source: "meta_webhook",
          });

          if (result.sendConsentTemplate) {
            await sendConsentPrompt(from);
          } else {
            await sendText(from, result.reply);
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

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { normalizeWhatsAppPhone } from "../utils/phone.js";

function graphBaseUrl(): string {
  return `https://graph.facebook.com/${config.meta.apiVersion}`;
}

function clampText(text: string, maxLen: number): string {
  return String(text || "").slice(0, maxLen);
}

function authHeaders(contentType = true): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.meta.accessToken}`,
  };

  if (contentType) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

async function postMessages(payload: Record<string, unknown>): Promise<any> {
  const url = `${graphBaseUrl()}/${config.meta.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Meta messages API failed with ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export async function sendText(to: string, body: string): Promise<void> {
  const normalizedTo = normalizeWhatsAppPhone(to).replace(/^\+/, "");
  await postMessages({
    messaging_product: "whatsapp",
    to: normalizedTo,
    type: "text",
    text: {
      preview_url: false,
      body,
    },
  });
}

export async function sendConsentPrompt(to: string): Promise<void> {
  const normalizedTo = normalizeWhatsAppPhone(to).replace(/^\+/, "");
  const consentBody =
    "Before we continue, please consent to NDPA-compliant processing of your health information for triage and doctor review.";
  const consentFooter = "No diagnosis. A licensed doctor will review your case.";

  try {
    await postMessages({
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          // WhatsApp interactive body max length is 1024 characters.
          text: clampText(consentBody, 1024),
        },
        footer: {
          // WhatsApp interactive footer max length is 60 characters.
          text: clampText(consentFooter, 60),
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "consent_accept",
                title: "Accept",
              },
            },
            {
              type: "reply",
              reply: {
                id: "consent_reject",
                title: "Reject",
              },
            },
          ],
        },
      },
    });
  } catch (error) {
    logger.warn("Interactive consent prompt failed, falling back to text", error);
    await sendText(
      normalizedTo,
      "Before we continue, please provide consent for NDPA-compliant triage processing. Reply YES to accept or NO to decline."
    );
  }
}

export async function fetchMediaUrl(mediaId: string): Promise<string | null> {
  const url = `${graphBaseUrl()}/${mediaId}`;
  const res = await fetch(url, {
    method: "GET",
    headers: authHeaders(false),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    logger.warn("Meta media lookup failed", { mediaId, status: res.status, data });
    return null;
  }

  const mediaUrl = typeof data.url === "string" ? data.url : "";
  return mediaUrl || null;
}

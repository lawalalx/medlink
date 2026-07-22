import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { normalizeWhatsAppPhone } from "../utils/phone.js";

function graphBaseUrl(): string {
  return `https://graph.facebook.com/${config.meta.apiVersion}`;
}

function clampText(text: string, maxLen: number): string {
  return String(text || "").slice(0, maxLen);
}

function isWhatsAppMessageId(messageId: string | undefined): boolean {
  return typeof messageId === "string" && messageId.startsWith("wamid.");
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

export async function sendInteractiveButtons(params: {
  to: string;
  body: string;
  buttons: Array<{ id: string; title: string }>;
  footer?: string;
}): Promise<void> {
  const normalizedTo = normalizeWhatsAppPhone(params.to).replace(/^\+/, "");
  const safeButtons = params.buttons.slice(0, 3).map((button) => ({
    type: "reply",
    reply: {
      id: String(button.id || "").slice(0, 256),
      title: String(button.title || "").slice(0, 20),
    },
  }));

  await postMessages({
    messaging_product: "whatsapp",
    to: normalizedTo,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: clampText(params.body, 1024),
      },
      ...(params.footer
        ? {
            footer: {
              text: clampText(params.footer, 60),
            },
          }
        : {}),
      action: {
        buttons: safeButtons,
      },
    },
  });
}

export async function sendInteractiveList(params: {
  to: string;
  body: string;
  buttonText?: string;
  sectionTitle?: string;
  options: Array<{ id: string; title: string; description?: string }>;
  footer?: string;
}): Promise<void> {
  const normalizedTo = normalizeWhatsAppPhone(params.to).replace(/^\+/, "");
  const rows = params.options.slice(0, 10).map((option, index) => ({
    id: String(option.id || `opt_${index + 1}`).slice(0, 200),
    title: clampText(String(option.title || ""), 24),
    ...(option.description
      ? {
          description: clampText(String(option.description), 72),
        }
      : {}),
  }));

  await postMessages({
    messaging_product: "whatsapp",
    to: normalizedTo,
    type: "interactive",
    interactive: {
      type: "list",
      body: {
        text: clampText(params.body, 1024),
      },
      ...(params.footer
        ? {
            footer: {
              text: clampText(params.footer, 60),
            },
          }
        : {}),
      action: {
        button: clampText(params.buttonText || "Choose option", 20),
        sections: [
          {
            title: clampText(params.sectionTitle || "Options", 24),
            rows,
          },
        ],
      },
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

export async function sendTypingIndicator(params: {
  to: string;
  messageId: string;
  phoneNumberId?: string;
}): Promise<boolean> {
  try {
    const { to, messageId, phoneNumberId } = params;
    if (!isWhatsAppMessageId(messageId)) {
      logger.warn("Skipping typing indicator for non-WhatsApp message id", { messageId });
      return false;
    }

    const resolvedPhoneNumberId = phoneNumberId || config.meta.phoneNumberId;
    if (!resolvedPhoneNumberId) {
      logger.warn("Cannot send typing indicator: missing phone number id");
      return false;
    }

    const url = `${graphBaseUrl()}/${resolvedPhoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    });

    if (res.ok) {
      logger.info(`Typing indicator sent to ${to}`);
      return true;
    }

    const data = await res.json().catch(() => ({}));
    logger.warn("Typing indicator failed", { status: res.status, data });
    return false;
  } catch (error) {
    logger.warn("Typing indicator crashed", error);
    return false;
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

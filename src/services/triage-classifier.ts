import type { UrgencyBand } from "../types.js";

const URGENT_HINTS = /(high fever|persistent vomiting|severe pain|blood in stool|dehydration|worsening quickly)/i;
const NON_URGENT_HINTS = /(mild|slight|minor|just asking|enquiry|question)/i;
const PRESCRIPTION_HINTS = /(prescription|refill|drug|medicine)/i;

export function inferUrgencyFromText(text: string): UrgencyBand {
  if (URGENT_HINTS.test(text)) return "urgent";
  if (NON_URGENT_HINTS.test(text)) return "non_urgent";
  return "routine";
}

export function classifyConversationIntent(text: string): "emergency" | "health_enquiry" | "prescription_request" | "administrative" {
  const value = String(text || "");
  if (/(emergency|cannot breathe|chest pain|bleeding)/i.test(value)) return "emergency";
  if (PRESCRIPTION_HINTS.test(value)) return "prescription_request";
  if (/(hmo|plan|hospital card|coverage|enrolment)/i.test(value)) return "administrative";
  return "health_enquiry";
}

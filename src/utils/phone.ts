export function normalizeWhatsAppPhone(rawPhone: string): string {
  const trimmed = String(rawPhone || "").trim();
  if (!trimmed) return "";

  const withoutPrefix = trimmed.replace(/^whatsapp:/i, "");
  const digits = withoutPrefix.replace(/\D/g, "");
  if (!digits) return "";

  return `+${digits}`;
}

export function stripWhatsAppPrefix(phone: string): string {
  return String(phone || "").replace(/^whatsapp:/i, "");
}

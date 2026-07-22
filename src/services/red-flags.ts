const RED_FLAG_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /chest pain.*sweat|sweat.*chest pain/i, reason: "Possible cardiac emergency (chest pain with sweating)." },
  { pattern: /difficulty breathing|shortness of breath|cannot breathe/i, reason: "Breathing distress red flag." },
  { pattern: /heavy bleeding|bleeding heavily|severe bleeding/i, reason: "Heavy bleeding red flag." },
  { pattern: /convulsion|seizure|fits/i, reason: "Convulsion/seizure red flag." },
  { pattern: /newborn.*fever|baby.*fever/i, reason: "Newborn/infant fever red flag." },
  { pattern: /fainting|unconscious|passed out/i, reason: "Altered consciousness red flag." },
  { pattern: /stroke|one side weak|slurred speech/i, reason: "Possible stroke red flag." },
  { pattern: /suicid|self harm|kill myself/i, reason: "Mental health crisis red flag." },
];

export function detectRedFlag(text: string): string | null {
  const input = String(text || "").trim();
  if (!input) return null;

  for (const item of RED_FLAG_PATTERNS) {
    if (item.pattern.test(input)) {
      return item.reason;
    }
  }

  return null;
}

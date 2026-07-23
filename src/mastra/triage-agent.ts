import { mastra } from "./index.js";
import { logger } from "../utils/logger.js";

export type AgentTriageOutput = {
  status: "continue" | "complete";
  nextMessage: string;
  patientSummary: string;
  suggestedUrgencyBand: "emergency" | "urgent" | "routine" | "non_urgent";
};

const VALID_STATUS = new Set(["continue", "complete"]);
const VALID_URGENCY = new Set(["emergency", "urgent", "routine", "non_urgent"]);

function cleanToolArtifacts(text: string): string {
  return String(text || "")
    .replace(/<\/function>/gi, " ")
    .replace(/function\s*=\s*[a-z0-9_-]+\s*>\s*\{[\s\S]*?\}<\/function>/gi, " ")
    .replace(/\{\s*"status"\s*:\s*"(?:continue|complete)"[\s\S]*?\}/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonObjects(text: string): string[] {
  const input = String(text || "");
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return results;
}

function safeParse(text: string): AgentTriageOutput | null {
  const normalizeCandidate = (candidate: string): AgentTriageOutput | null => {
    try {
      const parsed = JSON.parse(candidate) as Partial<AgentTriageOutput>;
      if (!parsed?.status || !VALID_STATUS.has(parsed.status)) return null;

      const nextMessage = cleanToolArtifacts(String(parsed.nextMessage || ""));
      if (!nextMessage) return null;

      const urgencyRaw = String(parsed.suggestedUrgencyBand || "");
      const suggestedUrgencyBand = VALID_URGENCY.has(urgencyRaw) ? urgencyRaw : "routine";

      return {
        status: parsed.status,
        nextMessage,
        patientSummary: String(parsed.patientSummary || ""),
        suggestedUrgencyBand: suggestedUrgencyBand as AgentTriageOutput["suggestedUrgencyBand"],
      };
    } catch {
      return null;
    }
  };

  const normalizeParsed = (candidate: string): AgentTriageOutput | null => {
    const parsed = normalizeCandidate(candidate);
    if (!parsed) return null;
    return {
      status: parsed.status,
      nextMessage: parsed.nextMessage,
      patientSummary: String(parsed.patientSummary || ""),
      suggestedUrgencyBand: parsed.suggestedUrgencyBand,
    };
  };

  const direct = normalizeParsed(text);
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const fromFence = normalizeParsed(fenced[1].trim());
    if (fromFence) return fromFence;
  }

  const objectMatches = extractJsonObjects(text);
  for (let i = objectMatches.length - 1; i >= 0; i -= 1) {
    const fromObject = normalizeParsed(objectMatches[i].trim());
    if (fromObject) return fromObject;
  }

  return null;
}

export async function runTriageAgent(
  history: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  threadId: string,
): Promise<AgentTriageOutput> {
  const agent = mastra.getAgentById("medlink-triage-agent");
  const response = await agent.generate(history as any, {
    memory: {
      thread: `thread_${threadId}`,
      resource: threadId,
    },
  });
  const rawText = response?.text?.trim() || "";

  const parsed = safeParse(rawText);
  if (parsed) return parsed;

  if (rawText) {
    const cleaned = cleanToolArtifacts(rawText);
    logger.warn("Triage agent returned non-JSON output; using raw text fallback", {
      threadId,
      preview: rawText.slice(0, 300),
    });

    return {
      status: "continue",
      nextMessage: cleaned || "Thank you. Could you tell me when this started and how severe it feels now?",
      patientSummary: "",
      suggestedUrgencyBand: "routine",
    };
  }

  return {
    status: "continue",
    nextMessage: "Thank you. Could you tell me when this started and how severe it feels now?",
    patientSummary: "",
    suggestedUrgencyBand: "routine",
  };
}

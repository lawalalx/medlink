import { mastra } from "./index.js";
import { logger } from "../utils/logger.js";

export type AgentTriageOutput = {
  status: "continue" | "complete";
  nextMessage: string;
  patientSummary: string;
  suggestedUrgencyBand: "emergency" | "urgent" | "routine" | "non_urgent";
};

function safeParse(text: string): AgentTriageOutput | null {
  const normalizeCandidate = (candidate: string): AgentTriageOutput | null => {
    try {
      const parsed = JSON.parse(candidate) as AgentTriageOutput;
      if (!parsed?.status || !parsed?.nextMessage) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const direct = normalizeCandidate(text);
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const fromFence = normalizeCandidate(fenced[1].trim());
    if (fromFence) return fromFence;
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    const fromObject = normalizeCandidate(objectMatch[0].trim());
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
    logger.warn("Triage agent returned non-JSON output; using raw text fallback", {
      threadId,
      preview: rawText.slice(0, 300),
    });

    return {
      status: "continue",
      nextMessage: rawText,
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

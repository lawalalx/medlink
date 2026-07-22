import { mastra } from "./index.js";

export type AgentTriageOutput = {
  status: "continue" | "complete";
  nextMessage: string;
  patientSummary: string;
  suggestedUrgencyBand: "emergency" | "urgent" | "routine" | "non_urgent";
};

function safeParse(text: string): AgentTriageOutput | null {
  try {
    const parsed = JSON.parse(text) as AgentTriageOutput;
    if (!parsed?.status || !parsed?.nextMessage) return null;
    return parsed;
  } catch {
    return null;
  }
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

  return {
    status: "continue",
    nextMessage: "Thank you. Could you tell me when this started and how severe it feels now?",
    patientSummary: "",
    suggestedUrgencyBand: "routine",
  };
}

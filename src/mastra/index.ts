import { Mastra } from "@mastra/core/mastra";
import { triageAgent } from "./agents/triage-agent.js";

export const mastra = new Mastra({
  agents: {
    medlinkTriageAgent: triageAgent,
  },
});

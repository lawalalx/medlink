import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { inferUrgencyFromText } from "../../services/triage-classifier.js";

export const classifyUrgencyTool = createTool({
  id: "classify-urgency",
  description: "Classifies symptom text into emergency, urgent, routine, or non_urgent urgency bands.",
  inputSchema: z.object({
    symptomText: z.string().min(1),
  }),
  outputSchema: z.object({
    urgencyBand: z.enum(["emergency", "urgent", "routine", "non_urgent"]),
  }),
  execute: async ({ symptomText }) => {
    return {
      urgencyBand: inferUrgencyFromText(symptomText),
    };
  },
});

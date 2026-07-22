process.env.OPENAI_API_KEY = "";
const { runTriageAgent } = await import("../src/mastra/triage-agent.ts");
const result = await runTriageAgent([
  { role: "system", content: "You are running payment-blind clinical intake." },
  { role: "user", content: "I have fever and headache since yesterday." }
], "groq-proof-thread");
console.log("RESULT_STATUS:", result.status);
console.log("RESULT_BAND:", result.suggestedUrgencyBand);
console.log("RESULT_MSG:", result.nextMessage?.slice(0, 120));

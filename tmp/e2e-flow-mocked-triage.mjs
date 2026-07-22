process.env.BACKEND_BASE_URL = "http://mock-backend.local";
process.env.BACKEND_INTAKE_PATH = "/api/cases/intake";
process.env.BACKEND_SIMULATE_PATH = "/api/meta/simulate-patient";

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://mock-backend.local")) {
    return new Response(
      JSON.stringify({ case: { id: "CASE-E2E-002" }, ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return realFetch(url, init);
};

const triage = await import("../src/mastra/triage-agent.ts");
const fakeTriage = async (_history, _threadId) => ({
  status: "complete",
  nextMessage: "Thanks.",
  patientSummary: "Headache and fever since yesterday, moderate severity, weakness, no chest pain.",
  suggestedUrgencyBand: "routine",
});
triage.runTriageAgent = fakeTriage;

const { processInbound } = await import("../src/services/flow-engine.ts");
const { stateStore } = await import("../src/store/state-store.ts");

const phone = "+2348099992222";
const turns = [
  "hello",
  "yes",
  "self",
  "none",
  "34",
  "female",
  "I have had headache and fever since yesterday",
  "yes"
];

for (const text of turns) {
  const out = await processInbound({ patientPhone: phone, text, source: "simulate" });
  const st = stateStore.getPatient(phone);
  console.log("\nUSER:", text);
  console.log("AGENT:", out.reply);
  console.log("STAGE:", st.triageStage, "| TURNS:", st.triageTurns, "| LAST_CASE:", st.lastCaseId || "-");
}

const finalState = stateStore.getPatient(phone);
console.log("\nFINAL_STATE_MOCKED_TRIAGE:");
console.log(JSON.stringify({
  triageStage: finalState.triageStage,
  lastCaseId: finalState.lastCaseId,
  lastUrgencyBand: finalState.lastUrgencyBand,
  consentStatus: finalState.consentStatus,
  coverageType: finalState.coverageType,
  subjectAgeYears: finalState.subjectAgeYears,
  subjectSex: finalState.subjectSex,
}, null, 2));

const emergencyPhone = "+2348099993333";
const emergency = await processInbound({
  patientPhone: emergencyPhone,
  text: "My father has chest pain and heavy sweating and cannot breathe",
  source: "simulate",
});
const emergencyState = stateStore.getPatient(emergencyPhone);
console.log("\nRED_FLAG_CASE:");
console.log("AGENT:", emergency.reply);
console.log(JSON.stringify({
  triageStage: emergencyState.triageStage,
  lastCaseId: emergencyState.lastCaseId,
  lastUrgencyBand: emergencyState.lastUrgencyBand,
}, null, 2));

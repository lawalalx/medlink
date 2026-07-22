process.env.BACKEND_BASE_URL = "http://mock-backend.local";
process.env.BACKEND_INTAKE_PATH = "/api/cases/intake";
process.env.BACKEND_SIMULATE_PATH = "/api/meta/simulate-patient";

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://mock-backend.local")) {
    return new Response(
      JSON.stringify({ case: { id: "CASE-E2E-001" }, ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return realFetch(url, init);
};

const { processInbound } = await import("../src/services/flow-engine.ts");
const { stateStore } = await import("../src/store/state-store.ts");

const phone = "+2348099991111";
const turns = [
  "hello",
  "yes",
  "self",
  "none",
  "34",
  "female",
  "I have had headache and fever since yesterday",
  "It is moderate and I also feel weak",
  "no",
  "Headache and fever started yesterday with weakness and no chest pain.",
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
console.log("\nFINAL_STATE:");
console.log(JSON.stringify({
  triageStage: finalState.triageStage,
  beneficiaryMode: finalState.beneficiaryMode,
  coverageType: finalState.coverageType,
  subjectAgeYears: finalState.subjectAgeYears,
  subjectSex: finalState.subjectSex,
  lastCaseId: finalState.lastCaseId,
  lastUrgencyBand: finalState.lastUrgencyBand,
  consentStatus: finalState.consentStatus
}, null, 2));

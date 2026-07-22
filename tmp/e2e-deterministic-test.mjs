process.env.BACKEND_BASE_URL = "http://mock-backend.local";
process.env.BACKEND_INTAKE_PATH = "/api/cases/intake";
process.env.BACKEND_SIMULATE_PATH = "/api/meta/simulate-patient";

const realFetch = globalThis.fetch.bind(globalThis);
let caseCounter = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://mock-backend.local")) {
    caseCounter += 1;
    return new Response(
      JSON.stringify({ case: { id: `CASE-E2E-${String(caseCounter).padStart(3, "0")}` }, ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return realFetch(url, init);
};

const { processInbound } = await import("../src/services/flow-engine.ts");
const { stateStore } = await import("../src/store/state-store.ts");

async function turn(phone, text) {
  const out = await processInbound({ patientPhone: phone, text, source: "simulate" });
  const st = stateStore.getPatient(phone);
  console.log(`USER(${phone}):`, text);
  console.log("AGENT:", out.reply);
  console.log("STATE:", JSON.stringify({ stage: st.triageStage, turns: st.triageTurns, caseId: st.lastCaseId || null, coverageType: st.coverageType || null, beneficiaryMode: st.beneficiaryMode, subjectAgeYears: st.subjectAgeYears || null, subjectSex: st.subjectSex }, null, 0));
  console.log("---");
}

console.log("\\nSCENARIO A: Pre-triage normal flow (ANOTHER + HMO)");
const phoneA = "+2348100001001";
await turn(phoneA, "hello");
await turn(phoneA, "yes");
await turn(phoneA, "another");
await turn(phoneA, "+2348011112222");
await turn(phoneA, "REL-000123");
await turn(phoneA, "12");
await turn(phoneA, "male");

console.log("\\nSCENARIO B: Summary confirm -> completed submission");
const phoneB = "+2348100001002";
stateStore.updatePatient(phoneB, (s) => ({
  ...s,
  consentStatus: "accepted",
  beneficiaryMode: "self",
  coverageType: "none",
  subjectAgeYears: 28,
  subjectSex: "female",
  triageStage: "summary_confirm",
  lastUrgencyBand: "urgent",
  triageSummaryDraft: "Fever and persistent vomiting since morning.",
}));
await turn(phoneB, "yes");

console.log("\\nSCENARIO C: Deterministic red-flag escalation");
const phoneC = "+2348100001003";
await turn(phoneC, "My mother has chest pain with sweating and cannot breathe");

console.log("\\nRESULT SNAPSHOT");
for (const phone of [phoneA, phoneB, phoneC]) {
  const st = stateStore.getPatient(phone);
  console.log(phone, JSON.stringify({ stage: st.triageStage, caseId: st.lastCaseId || null, urgency: st.lastUrgencyBand || null }, null, 0));
}

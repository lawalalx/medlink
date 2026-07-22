process.env.BACKEND_BASE_URL = "http://mock-backend.local";
process.env.BACKEND_INTAKE_PATH = "/api/cases/intake";
process.env.BACKEND_SIMULATE_PATH = "/api/meta/simulate-patient";

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://mock-backend.local")) {
    return new Response(
      JSON.stringify({ case: { id: "CASE-LIVE-GROQ-001" }, ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return realFetch(url, init);
};

const { processInbound } = await import("../src/services/flow-engine.ts");
const { stateStore } = await import("../src/store/state-store.ts");

const phone = "+2348110009001";
const turns = [
  "hello",
  "yes",
  "self",
  "none",
  "29",
  "female",
  "I have had fever and headache since yesterday",
];

for (const text of turns) {
  const out = await processInbound({ patientPhone: phone, text, source: "simulate" });
  const st = stateStore.getPatient(phone);
  console.log("USER:", text);
  console.log("AGENT:", out.reply);
  console.log("STAGE:", st.triageStage, "| TURNS:", st.triageTurns, "| LAST_CASE:", st.lastCaseId || "-");
  console.log("---");
}

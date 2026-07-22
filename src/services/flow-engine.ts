import { detectRedFlag } from "./red-flags.js";
import { verifyHmoNumber } from "./hmo-verify.js";
import { pushIntake } from "./backend-client.js";
import { runTriageAgent } from "../mastra/triage-agent.js";
import { stateStore } from "../store/state-store.js";
import type { InboundMessage, IntakePayload, PatientState, TriageStage, UrgencyBand } from "../types.js";
import { inferUrgencyFromText, classifyConversationIntent } from "./triage-classifier.js";

const YES_SET = new Set(["yes", "y", "accept", "agree", "i consent", "ok", "okay", "consent_accept", "accept consent"]);
const NO_SET = new Set(["no", "n", "reject", "decline", "consent_reject", "reject consent"]);
const SELF_SET = new Set(["self", "me", "myself", "1"]);
const ANOTHER_SET = new Set(["another", "someone else", "child", "my child", "adult", "2", "3"]);
const MALE_SET = new Set(["male", "m", "man", "boy"]);
const FEMALE_SET = new Set(["female", "f", "woman", "girl"]);
const NONE_SET = new Set(["none", "no", "nil", "na"]);

function clean(text: string): string {
  return String(text || "").trim();
}

function toLower(text: string): string {
  return clean(text).toLowerCase();
}

function isPhoneLike(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function parseAgeYears(text: string): number | null {
  const value = clean(text);
  if (!value) return null;
  const direct = Number(value);
  if (Number.isFinite(direct) && direct >= 0 && direct <= 120) return Math.floor(direct);

  const digits = value.match(/\d{1,3}/)?.[0];
  if (!digits) return null;
  const age = Number(digits);
  if (!Number.isFinite(age) || age < 0 || age > 120) return null;
  return Math.floor(age);
}

function coverageCaseLabel(state: PatientState): "case_1_hmo" | "case_2_hospital_card" | "case_3_uninsured" {
  if (state.coverageType === "hmo") return "case_1_hmo";
  if (state.coverageType === "hospital_card") return "case_2_hospital_card";
  return "case_3_uninsured";
}

function buildSummaryText(summary: string): string {
  const value = clean(summary);
  if (!value) {
    return "Thanks. I have captured your symptoms and key details for doctor review.";
  }

  return `Here is a summary of what I captured:\n${value}\n\nReply YES to confirm this summary, or NO to correct it.`;
}

function buildClinicalHistory(state: PatientState): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const nonClinicalPatterns = [
    /consent/i,
    /hmo|hospital card|coverage|verified/i,
    /reply self|reply another|who is this report for/i,
    /phone number/i,
    /age in years/i,
    /sex of the patient/i,
  ];

  const filtered = state.history.filter((turn) => {
    const text = String(turn.text || "");
    return !nonClinicalPatterns.some((pattern) => pattern.test(text));
  });

  return [
    {
      role: "system",
      content:
        "You are running payment-blind clinical intake. Use only symptom and history content. Ask exactly one follow-up question at a time and never diagnose.",
    },
    ...filtered.map((turn) => ({
      role: turn.role === "patient" ? ("user" as const) : ("assistant" as const),
      content: turn.text,
    })),
  ];
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildIntakePayload(
  state: PatientState,
  latestPatientMessage: string,
  urgencyBand: UrgencyBand,
  triageStatus: "draft" | "escalated" | "completed",
  redFlagReason?: string,
  mediaUrls?: string[]
): IntakePayload {
  return {
    patientPhone: state.phone,
    beneficiaryMode: state.beneficiaryMode,
    beneficiaryPhone: state.beneficiaryPhone,
    subjectAgeYears: state.subjectAgeYears,
    subjectSex: state.subjectSex,
    coverageType: state.coverageType,
    consentStatus: state.consentStatus,
    consentUpdatedAt: state.consentUpdatedAt,
    hmoNumber: state.hmoNumber,
    hospitalCardNumber: state.hospitalCardNumber,
    hmoProvider: state.hmoProvider,
    hmoVerification: state.hmoVerification,
    urgencyBand,
    triageStatus,
    redFlagReason,
    latestPatientMessage,
    chatHistory: state.history,
    mediaUrls,
    metadata: {
      intent: classifyConversationIntent(latestPatientMessage),
      coverageCase: coverageCaseLabel(state),
      triageSummaryDraft: state.triageSummaryDraft,
    },
  };
}

function nextStageAfterCoverage(state: PatientState): TriageStage {
  if (state.beneficiaryMode === "another" && !state.beneficiaryPhone) return "beneficiary_phone";
  if (state.beneficiaryMode === "another" && state.beneficiaryPhone) return "subject_age";
  if (state.beneficiaryMode === "self") return "subject_age";
  return "beneficiary_mode";
}

export async function processInbound(message: InboundMessage): Promise<{ reply: string; sendConsentTemplate?: boolean }> {
  const normalizedText = clean(message.text);

  stateStore.appendTurn(message.patientPhone, {
    role: "patient",
    text: normalizedText || "[media message]",
    timestamp: nowIso(),
    mediaUrls: message.mediaUrls,
    messageType: message.mediaUrls?.length ? "media" : "text",
  });

  let state = stateStore.getPatient(message.patientPhone);

  if (message.mediaUrls?.length) {
    const hasAudio = (message.mediaContentTypes || []).some((t) => /^audio\//i.test(t));
    if (hasAudio) {
      const payload = buildIntakePayload(state, normalizedText || "Voice note received", "routine", "draft", undefined, message.mediaUrls);
      const backendRes = await pushIntake(payload);
      state = stateStore.updatePatient(message.patientPhone, (s) => ({ ...s, lastCaseId: backendRes.caseId || s.lastCaseId }));
      const reply = "Voice note received. Thank you. A doctor will review your audio and chat details shortly. Please also share any key symptom details in text if possible.";
      stateStore.appendTurn(message.patientPhone, { role: "agent", text: reply, timestamp: nowIso() });
      return { reply };
    }
  }

  const redFlag = detectRedFlag(normalizedText);
  if (redFlag) {
    const payload = buildIntakePayload(state, normalizedText, "emergency", "escalated", redFlag, message.mediaUrls);
    const backendRes = await pushIntake(payload);

    state = stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      lastCaseId: backendRes.caseId || s.lastCaseId,
      lastUrgencyBand: "emergency",
      triageStage: "done",
    }));

    const emergencyReply = "This may be an emergency. Please go to the nearest emergency facility immediately or call local emergency services now. A doctor has been alerted.";
    stateStore.appendTurn(message.patientPhone, { role: "agent", text: emergencyReply, timestamp: nowIso() });
    return { reply: emergencyReply };
  }

  if (state.consentStatus !== "accepted") {
    const l = toLower(normalizedText);

    if (NO_SET.has(l)) {
      state = stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        consentStatus: "rejected",
        consentUpdatedAt: nowIso(),
        triageStage: "consent",
      }));
      const declineReply = "Understood. We cannot continue medical triage without consent. If you change your mind, reply YES anytime.";
      stateStore.appendTurn(message.patientPhone, { role: "agent", text: declineReply, timestamp: nowIso() });
      return { reply: declineReply };
    }

    if (YES_SET.has(l)) {
      state = stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        consentStatus: "accepted",
        consentUpdatedAt: nowIso(),
        triageStage: "beneficiary_mode",
      }));
      const acceptReply = "Thank you for consenting. Who is this report for? Reply SELF if for you, or ANOTHER if for someone else.";
      stateStore.appendTurn(message.patientPhone, { role: "agent", text: acceptReply, timestamp: nowIso() });
      return { reply: acceptReply };
    }

    return {
      reply: "Before we continue, please provide consent for triage data processing. Reply YES to accept or NO to decline.",
      sendConsentTemplate: true,
    };
  }

  state = stateStore.updatePatient(message.patientPhone, (s) => {
    const shouldAutoAdvanceCoverageStage =
      (s.triageStage === "coverage" || s.triageStage === "beneficiary_mode" || s.triageStage === "beneficiary_phone") &&
      (s.hmoNumber || s.hospitalCardNumber || s.coverageType === "none") &&
      s.beneficiaryMode !== "unknown";

    if (shouldAutoAdvanceCoverageStage) {
      return { ...s, triageStage: nextStageAfterCoverage(s) };
    }

    return s;
  });

  if (state.beneficiaryMode === "unknown" || state.triageStage === "beneficiary_mode") {
    const l = toLower(normalizedText);
    if (SELF_SET.has(l)) {
      stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        beneficiaryMode: "self",
        triageStage: "coverage",
      }));
      return { reply: "Understood. Please share your HMO number or hospital card number. If you have neither, reply NONE." };
    }

    if (ANOTHER_SET.has(l)) {
      stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        beneficiaryMode: "another",
        triageStage: "beneficiary_phone",
      }));
      return { reply: "Please share the phone number of the patient you are reporting for." };
    }

    return { reply: "Who is this report for? Reply SELF if it is for you, or ANOTHER if it is for someone else." };
  }

  if (state.triageStage === "beneficiary_phone" && state.beneficiaryMode === "another") {
    if (!isPhoneLike(normalizedText)) {
      return { reply: "Please provide a valid patient phone number (10-15 digits with country code)." };
    }

    stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      beneficiaryPhone: normalizedText,
      triageStage: "coverage",
    }));
    return { reply: "Thank you. Please share the patient's HMO number or hospital card number. If unavailable, reply NONE." };
  }

  if (!(state.hmoNumber || state.hospitalCardNumber || state.coverageType === "none") && state.triageStage === "coverage") {
    const value = clean(normalizedText);
    if (!value) {
      return { reply: "Please share an HMO number or hospital card number, or reply NONE." };
    }

    if (NONE_SET.has(toLower(value))) {
      state = stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        coverageType: "none",
        hmoNumber: undefined,
        hmoProvider: undefined,
        hospitalCardNumber: undefined,
        triageStage: nextStageAfterCoverage(s),
      }));
      return { reply: "Thank you. What is the patient's age in years?" };
    }

    const isHospitalCard = /^card[:\s-]/i.test(value) || /^hc[:\s-]/i.test(value);
    if (isHospitalCard) {
      const cardNumber = value.replace(/^card[:\s-]*/i, "").replace(/^hc[:\s-]*/i, "").trim();
      stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        coverageType: "hospital_card",
        hospitalCardNumber: cardNumber || value,
        hmoNumber: undefined,
        hmoProvider: "hospital_card",
        hmoVerification: undefined,
        triageStage: nextStageAfterCoverage(s),
      }));
      return { reply: "Hospital card captured. What is the patient's age in years?" };
    }

    const verify = await verifyHmoNumber(value);
    state = stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      coverageType: "hmo",
      hmoNumber: value,
      hospitalCardNumber: undefined,
      hmoProvider: verify.provider,
      hmoVerification: verify,
      triageStage: nextStageAfterCoverage(s),
    }));

    if (verify.status === "verified") {
      const hmoName = verify.provider && verify.provider !== "unknown" ? verify.provider.toUpperCase() : "your HMO";
      return { reply: `HMO details received and verified with ${hmoName}. What is the patient's age in years?` };
    }

    return { reply: "HMO details received. We could not auto-verify right now and will continue with manual verification. What is the patient's age in years?" };
  }

  if (state.triageStage === "subject_age") {
    const age = parseAgeYears(normalizedText);
    if (age == null) {
      return { reply: "Please provide the patient's age in years, for example 2 or 45." };
    }

    stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      subjectAgeYears: age,
      triageStage: "subject_sex",
    }));
    return { reply: "Thank you. What is the patient's sex? Reply MALE or FEMALE." };
  }

  if (state.triageStage === "subject_sex") {
    const l = toLower(normalizedText);
    if (!MALE_SET.has(l) && !FEMALE_SET.has(l)) {
      return { reply: "Please reply MALE or FEMALE so we can apply the right triage checks." };
    }

    stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      subjectSex: MALE_SET.has(l) ? "male" : "female",
      triageStage: "triage",
      triageTurns: 0,
      triageSummaryDraft: undefined,
      summaryCorrectionCount: 0,
    }));

    return { reply: "Thank you. Please describe the main symptoms and when they started." };
  }

  if (state.triageStage === "summary_confirm") {
    const l = toLower(normalizedText);
    if (YES_SET.has(l)) {
      const urgency = state.lastUrgencyBand || "routine";
      const payload = buildIntakePayload(state, normalizedText, urgency, "completed", undefined, message.mediaUrls);
      const backendRes = await pushIntake(payload);

      stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        triageStage: "done",
        lastCaseId: backendRes.caseId || s.lastCaseId,
        lastUrgencyBand: urgency,
      }));

      const confirmedReply = "Thank you. Your report has been sent to a doctor. You will receive the doctor's response in this WhatsApp chat.";
      stateStore.appendTurn(message.patientPhone, { role: "agent", text: confirmedReply, timestamp: nowIso() });
      return { reply: confirmedReply };
    }

    if (NO_SET.has(l)) {
      stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        triageStage: "triage",
        summaryCorrectionCount: (s.summaryCorrectionCount || 0) + 1,
      }));
      return { reply: "Thanks for correcting that. Please share what should be changed in the summary." };
    }

    return { reply: "Please reply YES to confirm your summary, or NO if you want to correct it." };
  }

  const activeState = stateStore.updatePatient(message.patientPhone, (s) => ({
    ...s,
    triageStage: "triage",
    triageTurns: s.triageTurns + 1,
  }));

  const chatForAgent = buildClinicalHistory(activeState);

  const aiResult = await runTriageAgent(chatForAgent, message.patientPhone);

  if (aiResult.status === "complete" || activeState.triageTurns >= 6) {
    const urgency = aiResult.suggestedUrgencyBand || inferUrgencyFromText(normalizedText);
    stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      triageStage: "summary_confirm",
      triageSummaryDraft: clean(aiResult.patientSummary),
      lastUrgencyBand: urgency,
    }));

    const completeReply = buildSummaryText(aiResult.patientSummary);
    stateStore.appendTurn(message.patientPhone, { role: "agent", text: completeReply, timestamp: nowIso() });
    return { reply: completeReply };
  }

  const followUp = aiResult.nextMessage || "Thank you. Could you tell me more about the symptom severity and when it started?";
  stateStore.appendTurn(message.patientPhone, { role: "agent", text: followUp, timestamp: nowIso() });
  return { reply: followUp };
}

import { detectRedFlag } from "./red-flags.js";
import { verifyHmoNumber } from "./hmo-verify.js";
import { pushIntake } from "./backend-client.js";
import { runTriageAgent } from "../mastra/triage-agent.js";
import { stateStore } from "../store/state-store.js";
import type { InboundMessage, IntakePayload, PatientState, TriageStage, UrgencyBand } from "../types.js";
import { inferUrgencyFromText, classifyConversationIntent } from "./triage-classifier.js";
import { logger } from "../utils/logger.js";

type ProcessInboundResult = {
  reply: string;
  sendConsentTemplate?: boolean;
  buttonOptions?: Array<{ id: string; title: string }>;
  choiceOptions?: Array<{ id: string; title: string; description?: string }>;
};

const YES_SET = new Set(["yes", "y", "accept", "agree", "i consent", "ok", "okay", "consent_accept", "accept consent"]);
const NO_SET = new Set(["no", "n", "reject", "decline", "consent_reject", "reject consent"]);
const SELF_SET = new Set(["self", "me", "myself", "1", "beneficiary_self"]);
const ANOTHER_SET = new Set(["another", "someone else", "child", "my child", "adult", "2", "3", "beneficiary_another"]);
const MALE_SET = new Set(["male", "m", "man", "boy", "sex_male"]);
const FEMALE_SET = new Set(["female", "f", "woman", "girl", "sex_female"]);
const NONE_SET = new Set(["none", "no", "nil", "na"]);
const GREETING_SET = new Set(["hello", "hi", "hey", "good morning", "good afternoon", "good evening"]);

function clean(text: string): string {
  return String(text || "").trim();
}

function toLower(text: string): string {
  return clean(text).toLowerCase();
}

function canonicalChoiceToken(text: string): string {
  const value = toLower(text);
  if (value === "beneficiary_self") return "self";
  if (value === "beneficiary_another") return "another";
  if (value === "sex_male") return "male";
  if (value === "sex_female") return "female";
  return value;
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
    return "Here is a summary of what I captured:\n- Your symptom details from this chat\n\nReply YES to confirm this summary, or NO to correct it.";
  }

  return `Here is a summary of what I captured:\n${value}\n\nReply YES to confirm this summary, or NO to correct it.`;
}

function parseAiOptionsTag(text: string): {
  reply: string;
  options?: Array<{ id: string; title: string; description?: string }>;
} {
  const raw = String(text || "");
  const match = raw.match(/<options>\s*([\s\S]*?)\s*<\/options>/i);
  if (!match) return { reply: clean(raw) };

  const withoutTag = clean(raw.replace(match[0], " "));
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return { reply: withoutTag || clean(raw) };

    const options = parsed
      .map((item: any, index: number) => {
        const title = clean(String(item?.title || ""));
        if (!title) return null;

        const idCandidate = clean(String(item?.id || ""));
        const id = idCandidate || `opt_${index + 1}`;
        const description = clean(String(item?.description || ""));

        return {
          id,
          title,
          ...(description ? { description } : {}),
        };
      })
      .filter(Boolean) as Array<{ id: string; title: string; description?: string }>;

    if (!options.length) return { reply: withoutTag || clean(raw) };
    return {
      reply: withoutTag || "Please select one option below.",
      options,
    };
  } catch {
    return { reply: withoutTag || clean(raw) };
  }
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
    {
      role: "system",
      content: `Known patient demographics: age=${typeof state.subjectAgeYears === "number" ? state.subjectAgeYears : "unknown"}, sex=${state.subjectSex || "unknown"}. If age or sex is unknown, collect only the missing item(s) first, then continue symptom intake.`,
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
  if (state.beneficiaryMode === "another" && state.beneficiaryPhone) return "triage";
  if (state.beneficiaryMode === "self") return "triage";
  return "beneficiary_mode";
}

function firstComplaintPrompt(state: PatientState): string {
  if (state.beneficiaryMode === "another") {
    return "Thanks. Please describe the patient's main complaint and when it started.";
  }
  return "Thanks. Please describe your main complaint and when it started.";
}

async function startAiTriageQuestion(state: PatientState, threadId: string): Promise<ProcessInboundResult> {
  const seededState = stateStore.updatePatient(state.phone, (s) => ({
    ...s,
    triageStage: "triage",
  }));

  const aiResult = await runTriageAgent(buildClinicalHistory(seededState), threadId).catch(() => null);
  const rawReply = aiResult?.nextMessage || "Thank you. Please describe the main symptoms and when they started.";
  const parsed = parseAiOptionsTag(rawReply);
  return {
    reply: parsed.reply,
    ...(parsed.options?.length ? { choiceOptions: parsed.options } : {}),
  };
}

export async function processInbound(message: InboundMessage): Promise<ProcessInboundResult> {
  const normalizedText = clean(message.text);
  const allowSimulateFallback = message.source !== "simulate";

  stateStore.appendTurn(message.patientPhone, {
    role: "patient",
    text: normalizedText || "[media message]",
    timestamp: nowIso(),
    mediaUrls: message.mediaUrls,
    messageType: message.mediaUrls?.length ? "media" : "text",
  });

  let state = stateStore.getPatient(message.patientPhone);

  const lowerText = canonicalChoiceToken(normalizedText);

  // Recover from stale sessions: greeting should not trap users in old age/sex stages.
  if (GREETING_SET.has(lowerText) && state.consentStatus === "accepted") {
    state = stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      consentStatus: "unknown",
      consentUpdatedAt: undefined,
      beneficiaryMode: "unknown",
      beneficiaryPhone: undefined,
      coverageType: "unknown",
      hmoNumber: undefined,
      hospitalCardNumber: undefined,
      hmoProvider: undefined,
      hmoVerification: undefined,
      subjectAgeYears: undefined,
      subjectSex: "unknown",
      triageStage: "consent",
      triageTurns: 0,
      triageSummaryDraft: undefined,
      summaryCorrectionCount: 0,
    }));

    const reply = "Welcome back. Before we continue, please provide consent for triage data processing. Reply YES to accept or NO to decline.";
    stateStore.appendTurn(message.patientPhone, { role: "agent", text: reply, timestamp: nowIso() });
    return {
      reply,
      sendConsentTemplate: true,
    };
  }

  if (message.mediaUrls?.length) {
    const hasAudio = (message.mediaContentTypes || []).some((t) => /^audio\//i.test(t));
    if (hasAudio) {
      const payload = buildIntakePayload(state, normalizedText || "Voice note received", "routine", "draft", undefined, message.mediaUrls);
      try {
        const backendRes = await pushIntake(payload, { allowSimulateFallback });
        state = stateStore.updatePatient(message.patientPhone, (s) => ({ ...s, lastCaseId: backendRes.caseId || s.lastCaseId }));
      } catch (error) {
        logger.error("Failed to submit audio intake", error);
      }
      const reply = "Voice note received. Thank you. A doctor will review your audio and chat details shortly. Please also share any key symptom details in text if possible.";
      stateStore.appendTurn(message.patientPhone, { role: "agent", text: reply, timestamp: nowIso() });
      return { reply };
    }
  }

  const redFlag = detectRedFlag(normalizedText);
  if (redFlag) {
    const payload = buildIntakePayload(state, normalizedText, "emergency", "escalated", redFlag, message.mediaUrls);
    let backendRes: { caseId?: string; raw: any } | null = null;
    try {
      backendRes = await pushIntake(payload, { allowSimulateFallback });
    } catch (error) {
      logger.error("Failed to submit emergency intake", error);
    }

    state = stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      lastCaseId: backendRes?.caseId || s.lastCaseId,
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
      return {
        reply: acceptReply,
        buttonOptions: [
          { id: "beneficiary_self", title: "SELF" },
          { id: "beneficiary_another", title: "ANOTHER" },
        ],
      };
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
    const l = lowerText;
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

    return {
      reply: "Who is this report for? Reply SELF if it is for you, or ANOTHER if it is for someone else.",
      buttonOptions: [
        { id: "beneficiary_self", title: "SELF" },
        { id: "beneficiary_another", title: "ANOTHER" },
      ],
    };
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
      const reply = firstComplaintPrompt(state);
      stateStore.appendTurn(message.patientPhone, { role: "agent", text: reply, timestamp: nowIso() });
      return { reply };
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
      const refreshed = stateStore.getPatient(message.patientPhone);
      const reply = firstComplaintPrompt(refreshed);
      stateStore.appendTurn(message.patientPhone, { role: "agent", text: reply, timestamp: nowIso() });
      return { reply };
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
      const refreshed = stateStore.getPatient(message.patientPhone);
      const reply = `HMO details received and verified with ${hmoName}. ${firstComplaintPrompt(refreshed)}`;
      stateStore.appendTurn(message.patientPhone, { role: "agent", text: reply, timestamp: nowIso() });
      return { reply };
    }

    const refreshed = stateStore.getPatient(message.patientPhone);
    const reply = `HMO details received. We could not auto-verify right now and will continue with manual verification. ${firstComplaintPrompt(refreshed)}`;
    stateStore.appendTurn(message.patientPhone, { role: "agent", text: reply, timestamp: nowIso() });
    return { reply };
  }

  if (state.triageStage === "subject_age") {
    const age = parseAgeYears(normalizedText);
    if (age == null) {
      return { reply: "Please provide the patient's age in years, for example 2 or 45." };
    }

    state = stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      subjectAgeYears: age,
      triageStage: "triage",
      triageTurns: 0,
      triageSummaryDraft: undefined,
      summaryCorrectionCount: 0,
    }));
    const aiKickoff = await startAiTriageQuestion(state, message.patientPhone);
    stateStore.appendTurn(message.patientPhone, { role: "agent", text: aiKickoff.reply, timestamp: nowIso() });
    return aiKickoff;
  }

  if (state.triageStage === "subject_sex") {
    const l = lowerText;
    if (!MALE_SET.has(l) && !FEMALE_SET.has(l)) {
      return {
        reply: "Please reply MALE or FEMALE so we can apply the right triage checks.",
        buttonOptions: [
          { id: "sex_male", title: "MALE" },
          { id: "sex_female", title: "FEMALE" },
        ],
      };
    }

    state = stateStore.updatePatient(message.patientPhone, (s) => ({
      ...s,
      subjectSex: MALE_SET.has(l) ? "male" : "female",
      triageStage: "triage",
      triageTurns: 0,
      triageSummaryDraft: undefined,
      summaryCorrectionCount: 0,
    }));

    const aiKickoff = await startAiTriageQuestion(state, message.patientPhone);
    stateStore.appendTurn(message.patientPhone, { role: "agent", text: aiKickoff.reply, timestamp: nowIso() });
    return aiKickoff;
  }

  if (state.triageStage === "summary_confirm") {
    const l = lowerText;
    if (YES_SET.has(l)) {
      const urgency = state.lastUrgencyBand || "routine";
      const payload = buildIntakePayload(state, normalizedText, urgency, "completed", undefined, message.mediaUrls);
      let backendRes: { caseId?: string; raw: any } | null = null;
      try {
        backendRes = await pushIntake(payload, { allowSimulateFallback });
      } catch (error) {
        logger.error("Failed to submit completed intake", error);
      }

      stateStore.updatePatient(message.patientPhone, (s) => ({
        ...s,
        triageStage: "done",
        lastCaseId: backendRes?.caseId || s.lastCaseId,
        lastUrgencyBand: urgency,
      }));

      const confirmedReply = backendRes
        ? "Thank you. Your report has been sent to a doctor. You will receive the doctor's response in this WhatsApp chat."
        : "Thank you. I captured your report, but we could not submit it to the doctor system right now. Please try again shortly.";
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

  const followUpRaw = aiResult.nextMessage || "Thank you. Could you tell me more about the symptom severity and when it started?";
  const followUp = parseAiOptionsTag(followUpRaw);
  stateStore.appendTurn(message.patientPhone, { role: "agent", text: followUp.reply, timestamp: nowIso() });
  return {
    reply: followUp.reply,
    ...(followUp.options?.length ? { choiceOptions: followUp.options } : {}),
  };
}

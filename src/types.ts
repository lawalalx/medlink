export type ConsentStatus = "unknown" | "accepted" | "rejected";

export type BeneficiaryMode = "self" | "another" | "unknown";

export type SubjectSex = "male" | "female" | "unknown";

export type CoverageType = "hmo" | "hospital_card" | "none" | "unknown";

export type TriageStage =
  | "consent"
  | "beneficiary_mode"
  | "beneficiary_phone"
  | "subject_age"
  | "subject_sex"
  | "coverage"
  | "summary_confirm"
  | "triage"
  | "done";

export type UrgencyBand = "emergency" | "urgent" | "routine" | "non_urgent";

export type CaseOutcome = "resolved" | "needs_visit" | "pending_followup";

export type ChatRole = "patient" | "agent" | "system";

export interface ChatTurn {
  role: ChatRole;
  text: string;
  timestamp: string;
  mediaUrls?: string[];
  messageType?: string;
}

export interface HmoVerificationResult {
  provider: string;
  hmoNumber: string;
  verified: boolean;
  verificationMode: "api" | "manual";
  status: "verified" | "not_found" | "manual_verification_required" | "api_error";
  customerDetails?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface PatientState {
  phone: string;
  consentStatus: ConsentStatus;
  consentUpdatedAt?: string;
  coverageType?: CoverageType;
  hmoNumber?: string;
  hospitalCardNumber?: string;
  hmoProvider?: string;
  hmoVerification?: HmoVerificationResult;
  beneficiaryMode: BeneficiaryMode;
  beneficiaryPhone?: string;
  subjectAgeYears?: number;
  subjectSex: SubjectSex;
  triageStage: TriageStage;
  triageTurns: number;
  triageSummaryDraft?: string;
  summaryCorrectionCount?: number;
  lastCaseId?: string;
  lastUrgencyBand?: UrgencyBand;
  history: ChatTurn[];
  createdAt: string;
  updatedAt: string;
}

export interface InboundMessage {
  patientPhone: string;
  text: string;
  messageSid?: string;
  mediaUrls?: string[];
  mediaContentTypes?: string[];
  source: "meta_webhook" | "simulate";
}

export interface IntakePayload {
  patientPhone: string;
  beneficiaryMode: BeneficiaryMode;
  beneficiaryPhone?: string;
  subjectAgeYears?: number;
  subjectSex?: SubjectSex;
  coverageType?: CoverageType;
  consentStatus: ConsentStatus;
  consentUpdatedAt?: string;
  hmoNumber?: string;
  hospitalCardNumber?: string;
  hmoProvider?: string;
  hmoVerification?: HmoVerificationResult;
  urgencyBand: UrgencyBand;
  triageStatus: "draft" | "escalated" | "completed";
  redFlagReason?: string;
  latestPatientMessage: string;
  chatHistory: ChatTurn[];
  mediaUrls?: string[];
  metadata?: Record<string, unknown>;
}

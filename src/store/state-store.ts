import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ChatTurn, PatientState } from "../types.js";

interface PersistedState {
  patients: Record<string, PatientState>;
}

const defaultState: PersistedState = { patients: {} };

function nowIso(): string {
  return new Date().toISOString();
}

class StateStore {
  private data: PersistedState = defaultState;

  constructor() {
    this.load();
  }

  private ensureDir() {
    const dir = path.dirname(config.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private load() {
    this.ensureDir();
    if (!fs.existsSync(config.stateFilePath)) {
      this.data = { patients: {} };
      this.save();
      return;
    }

    const raw = fs.readFileSync(config.stateFilePath, "utf-8");
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      this.data = parsed?.patients ? parsed : { patients: {} };
    } catch {
      this.data = { patients: {} };
      this.save();
    }
  }

  private save() {
    this.ensureDir();
    fs.writeFileSync(config.stateFilePath, JSON.stringify(this.data, null, 2));
  }

  getPatient(phone: string): PatientState {
    const existing = this.data.patients[phone];
    if (existing) return existing;

    const fresh: PatientState = {
      phone,
      consentStatus: "unknown",
      coverageType: "unknown",
      beneficiaryMode: "unknown",
      subjectSex: "unknown",
      triageStage: "consent",
      triageTurns: 0,
      history: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.data.patients[phone] = fresh;
    this.save();
    return fresh;
  }

  updatePatient(phone: string, updater: (state: PatientState) => PatientState): PatientState {
    const current = this.getPatient(phone);
    const next = updater({ ...current });
    next.updatedAt = nowIso();
    this.data.patients[phone] = next;
    this.save();
    return next;
  }

  appendTurn(phone: string, turn: ChatTurn): PatientState {
    return this.updatePatient(phone, (state) => {
      const nextHistory = [...state.history, turn].slice(-100);
      return { ...state, history: nextHistory };
    });
  }

  listPatients(): PatientState[] {
    return Object.values(this.data.patients);
  }
}

export const stateStore = new StateStore();

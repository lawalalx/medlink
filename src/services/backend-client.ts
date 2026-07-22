import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { IntakePayload } from "../types.js";

function fallbackWouldReenterThisService(): boolean {
  const base = config.backend.baseUrl.toLowerCase();
  const isLocal = /localhost|127\.0\.0\.1/.test(base);
  const isSimulateRoute = config.backend.simulatePath === "/api/meta/simulate-patient";
  return isLocal && isSimulateRoute;
}

function buildHeaders(contentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = "application/json";
  if (config.backend.apiToken) {
    headers.Authorization = `Bearer ${config.backend.apiToken}`;
  }
  return headers;
}

async function postJson(path: string, payload: unknown): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.backend.timeoutMs);

  try {
    const url = `${config.backend.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Backend ${path} failed with ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function pushIntake(
  payload: IntakePayload,
  options?: { allowSimulateFallback?: boolean },
): Promise<{ caseId?: string; raw: any }> {
  const allowSimulateFallback = options?.allowSimulateFallback ?? true;

  try {
    const data = await postJson(config.backend.intakePath, payload);
    return { caseId: data?.case?.id || data?.id, raw: data };
  } catch (error) {
    if (!allowSimulateFallback) {
      throw error;
    }

    if (fallbackWouldReenterThisService()) {
      logger.error(
        "Simulate fallback blocked to prevent recursion. Configure BACKEND_BASE_URL to upstream backend or override BACKEND_SIMULATE_PATH.",
        {
          baseUrl: config.backend.baseUrl,
          simulatePath: config.backend.simulatePath,
        },
      );
      throw error;
    }

    logger.warn("Primary intake path failed, trying simulate path fallback", error);
    const fallbackPayload = {
      patientPhone: payload.patientPhone,
      message: payload.latestPatientMessage,
    };
    const data = await postJson(config.backend.simulatePath, fallbackPayload);
    return { caseId: data?.case?.id || data?.id, raw: data };
  }
}

export async function proxyDoctorReply(caseId: string, payload: { responseMessage: string; outcome: string }, authHeader?: string): Promise<any> {
  const path = config.backend.replyPathTemplate.replace(":id", caseId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.backend.timeoutMs);

  try {
    const headers = buildHeaders(true);
    if (authHeader) {
      headers.Authorization = authHeader;
    }

    const res = await fetch(`${config.backend.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Reply proxy failed with ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

import { config } from "../config.js";
import type { HmoVerificationResult } from "../types.js";

type ProviderKey = "reliance" | "hygeia" | "avon" | "axa" | "unknown";

function inferProvider(hmoNumber: string): ProviderKey {
  const value = hmoNumber.toLowerCase();
  if (value.startsWith("rel") || value.includes("reliance")) return "reliance";
  if (value.startsWith("hyg") || value.includes("hygeia")) return "hygeia";
  if (value.startsWith("avn") || value.includes("avon")) return "avon";
  if (value.startsWith("axa") || value.includes("mansard")) return "axa";
  return "unknown";
}

async function callProviderApi(provider: Exclude<ProviderKey, "unknown">, hmoNumber: string): Promise<HmoVerificationResult> {
  const connector = config.hmo.connectors[provider];
  if (!connector.url || !connector.apiKey) {
    return {
      provider,
      hmoNumber,
      verified: false,
      verificationMode: "manual",
      status: "manual_verification_required",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.hmo.timeoutMs);

  try {
    const response = await fetch(connector.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connector.apiKey}`,
      },
      body: JSON.stringify({ hmoNumber }),
      signal: controller.signal,
    });

    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const verified = Boolean(raw.verified || raw.valid || raw.status === "active");

    return {
      provider,
      hmoNumber,
      verified,
      verificationMode: "api",
      status: verified ? "verified" : "not_found",
      customerDetails: (raw.customer as Record<string, unknown>) || raw,
      raw,
    };
  } catch {
    return {
      provider,
      hmoNumber,
      verified: false,
      verificationMode: "api",
      status: "api_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyHmoNumber(hmoNumber: string): Promise<HmoVerificationResult> {
  const normalized = String(hmoNumber || "").trim();
  const provider = inferProvider(normalized);

  if (provider === "unknown") {
    return {
      provider: "unknown",
      hmoNumber: normalized,
      verified: false,
      verificationMode: "manual",
      status: "manual_verification_required",
    };
  }

  return callProviderApi(provider, normalized);
}

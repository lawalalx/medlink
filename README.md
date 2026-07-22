# MedLink WhatsApp AI Agent (Mastra + Meta WhatsApp Cloud API)

This service handles patient WhatsApp messages over Meta webhooks, runs a payment-blind triage interview with Mastra AI, flags red-flag emergencies deterministically, and forwards structured case payloads to your backend APIs.

## What is included

- Meta webhook verification endpoint (`hub.challenge` flow)
- Meta inbound webhook processing (`entry -> changes -> value.messages`)
- Consent-first flow with interactive Accept/Reject buttons
- Coverage/HMO capture and verification hook architecture
- Beneficiary identity flow (self or another person)
- Voice note passthrough (no transcription, media URLs forwarded as-is)
- Deterministic emergency red-flag guardrail before AI triage
- Mastra triage agent for one-question-at-a-time interview
- Backend case push integration (full payload)
- Proxy for doctor reply endpoint `/api/cases/:id/reply`
- Simulation endpoint for testing without live Meta webhook

## Important clinical rule

The AI does not diagnose. It gathers structured intake data and proposes urgency for doctor review.

## Endpoints

- `GET /health`
- `GET /webhook` (Meta verify token)
- `POST /webhook` (Meta inbound events)
- `POST /api/meta/simulate-patient`
- `POST /api/cases/:id/reply` (proxy to your backend)

## Quick start

1. Copy `.env.example` to `.env` and fill values.
2. Install dependencies:

```bash
pnpm install
```

3. Run dev server:

```bash
pnpm dev
```

4. Expose localhost with ngrok/cloudflared and set Meta webhook callback URL to:

`https://<public-url>/webhook`

## HMO API reality check (Nigeria)

There are no clearly documented public member-verification APIs from major Nigerian HMOs for anonymous third-party use. In practice, verification access is usually private partner API access after commercial onboarding.

This project therefore includes:

- Provider adapter interface
- Config-driven private endpoint connectors
- Deterministic fallback to `manual_verification_required` when no provider connector is configured

## Data sent to backend intake

The payload includes:

- patient phone and beneficiary info
- consent details
- HMO details and verification output
- full chat history
- latest user message
- urgency band and red-flag reason (if any)
- voice/media metadata

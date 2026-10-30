# Decision Record: Hosted vs Self-Hosted Deployment

**Status:** Accepted\
**Date:** 2026-10-30\
**Scope:** Deployment modes of the product and which LLM providers are
available in each

---

## 1. Decision

The product ships in **two deployment modes**, selected by the
`DEPLOYMENT_MODE` environment variable (`self-hosted` is the default):

1. **Self-hosted / local** — one instance per owner, running on the
   developer's or user's own Windows PC. Its LLM work may run through
   **CLI-backed providers**: the local OpenCode server
   (`opencode serve` + SDK) and the Codex CLI (`codex exec`).
2. **Hosted** — a server deployment serving multiple users. Here,
   **CLI providers are unavailable** and generation runs only through
   providers backed by **the user's own API keys** ("bring your own
   key", BYOK) — e.g. direct OpenAI, Anthropic, or Google API calls
   behind the same `LlmProvider` interface.

| Capability        | Self-hosted        | Hosted                       |
| ----------------- | ------------------ | ---------------------------- |
| OpenCode server   | Allowed            | **Never**                    |
| Codex CLI         | Allowed            | **Never**                    |
| Hosted-API BYOK   | Allowed (optional) | The only path                |
| FakeLlmProvider   | Development only   | Development only (never ships to users) |
| User API keys placed in storage | Optional | Required per user, encrypted under `MASTER_KEY` |

## 2. Why CLI providers are strictly local-only

- Account identity: OpenCode signs in with a single user account
  (ChatGPT/OpenAI login per machine), as does Codex. A hosted server
  cannot multiplex many users over one account, and doing so would
  effectively resell third-party access.
- Contract: the OpenCode free tier applies per account and is for
  internal use (see the terms appendix in `docs/decision.md`).
  Exposing it to external users needs OpenCode Go or paid direct-API
  access, and even then through the BYOK/hosted path — not through the
  free tier.
- Process model: CLI providers execute on the machine that owns the
  account credentials. A hosted server has no correct, sanctioned way
  to sandbox someone else's CLI session.
- Security: CLI providers inherit local tools/MCP configuration and
  password stores. Multi-tenant serving through a user-agnostic CLI
  would leak request-time secrets across tenants.

## 3. Enforceability

- `DEPLOYMENT_MODE` is validated by `apps/api/src/config/env.ts`
  (`self-hosted` | `hosted`). Provider selection code must filter its
  available `LlmProvider`s on this value before the first real endpoint
  wires a provider in.
- In `hosted` mode the build must not even reference OpenCode/Codex
  credential paths; the CLI provider modules stay self-hosted-only.
- User API keys stored for use in hosted mode are encrypted
  (AES) under `MASTER_KEY` before persistence and are decrypted only
  in memory per request. Nothing in the response envelope or logs ever
  includes a key or its plaintext (the logger redacts `authorization`,
  `apiKey`, and `x-api-key`).

## 4. Consequences

- The same `LlmProvider` interface serves both modes; pivoting one code
  path between deployment styles never forks the generation pipeline.
- Costs: hosted usage is paid by each user's own keys, so the operator
  carries no inference bill and no resale-licensing risk.
- Limitations: hosted users cannot use free CLI-tier models; their
  quality ceiling is whatever their own API accounts offer. Self-hosted
  users get the free OpenCode models locally with all the availability
  caveats (rate limits, rotating free models) already documented.
- Migration/ops: rotating `MASTER_KEY` invalidates every stored user
  key; a rotation plan (re-encrypt challenge or per-record enveloped
  keys) is required before hosted mode launches.

## 5. Related work not yet built

- The BYOK key store (encrypt/decrypt under `MASTER_KEY`) and its
  per-user tables.
- Direct hosted-API `LlmProvider` implementations and their model
  fallback chains.
- The `DEPLOYMENT_MODE`-aware provider registry wiring everything above
  into a `/generate` endpoint.

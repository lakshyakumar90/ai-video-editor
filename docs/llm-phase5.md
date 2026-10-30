# Phase 5: LLM hub

**Status:** In progress  
**Progress:** 11/18

This checklist tracks the implementation contract requested for Phase 5.
An item is checked only after its implementation and relevant verification are
in the repository. Provider API calls use request-scoped credentials; provider
instances and secrets must not be shared across users.

- [x] Define `ProviderCapabilities` (`structuredOutput`, `toolCalling`,
      `vision`, `streaming`, `maxContext`) and expose it on every adapter.
- [x] Extend `LlmProvider` with `generateJson`, `generateWithTools`, `stream`,
      `describeImage`, and `capabilities`.
- [x] Add validated JSON-in-text tool fallback for providers without native
      tools; return operation lists.
- [x] Build a generic OpenAI-compatible adapter and OpenRouter preset.
- [x] Add Groq, Together, DeepSeek, Ollama, LM Studio, and vLLM presets using
      the compatible adapter.
- [x] Add an Anthropic SDK adapter with messages, tools, and image input.
- [x] Add a Google GenAI SDK adapter with JSON schema, function calling, image,
      and video input.
- [x] Add an OpenAI SDK adapter with JSON schema and tool calls.
- [x] Add a Codex CLI adapter using `codex exec` in an empty temporary
      directory, default read-only sandbox, and saved login or `CODEX_API_KEY`.
- [x] Mark Codex and OpenCode as local CLI providers; reject them in hosted
      mode.
- [ ] Expand the registry with provider id, kind, capabilities, default model,
      and health probe.
- [ ] Route script planning, edit-agent, vision, and translation by task.
- [ ] Add per-task fallback for rate limits, quota errors, and timeouts; never
      switch from a user key to a platform key without explicit consent.
- [x] Add an AES-256-GCM key vault with one encrypted record per user/provider
      and last-four-character display metadata.
- [ ] Resolve credentials per request (user key first, eligible platform key
      only with consent); do not keep credentials in global state.
- [ ] Add `POST /api/providers/test` with a one-token call, capability report,
      and readable failure.
- [ ] Record tokens and estimated cost per call, tagged with provider, model,
      and whose key paid.
- [ ] Add a provider contract suite for JSON output, tools, error mapping, and
      timeouts; use fakes and optional live smoke tests.

## Identity dependency

The selected identity integration is Better Auth. BYOK key storage and
per-user credential resolution will use the verified Better Auth session user
id. Never trust a client-supplied `userId` header or body field for key
ownership. Configure `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and the existing
32-byte hex `MASTER_KEY` before starting the API.

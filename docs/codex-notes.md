# Infra Check: Codex CLI (checked 2026-10-30)

Result of installing, signing into, and exercising the **OpenAI Codex
CLI** on the development machine, as a second CLI-side LLM provider
alongside the local OpenCode server. Codex is used the same way: the
API backend shells out to (or otherwise drives) the locally installed
CLI; the user's own ChatGPT/OpenAI account provides model access.

## Install

- Already installed and on PATH: `codex-cli 0.163.0`
  (`codex --version`).

## Sign-in

- `codex login status` → **"Logged in using ChatGPT"**
- Credentials live in the user profile at
  `%USERPROFILE%\.codex\auth.json` (present) and are managed by the CLI;
  the repo never stores or reads ChatGPT tokens.

## `codex exec` smoke test

``` powershell
codex exec -s read-only --skip-git-repo-check 'Reply with exactly one JSON object and nothing else: {"status":"ok","tool":"codex"}'
```

Executed in `tmp/`, ran non-interactively with:

- model `gpt-6.1-sol`, approval `never`, sandbox `read-only`
- the model returned exactly the requested bare JSON object
- session id recorded in CLI output (one-shot session, per-invocation)

Observed noise, not a failure: configured remote MCP servers in the
user's Codex environment (Sanity, InstaCloud) emit auth-required
transport errors because they are not signed in inside this context.
They do not block `codex exec`; keep prompts to plain session replies.
The repo's own MCP config must stay local-only for the same reason
CLI providers are local-only (docs/decision-deployment.md).

## Usage notes for the API backend

- Non-interactive one-shot generation: `codex exec` with an explicit
  sandbox (`-s read-only` or `-s workspace-write` only when file access
  is needed) and `approval: never`.
- Force JSON the same way as the OpenCode provider: system-style
  instructions embedded in the prompt, exact-schema restatement, and
  fence-stripping on the reply (see `parseJsonReply`).
- Respect a timeout (`AbortSignal.timeout`) and treat non-zero exit
  codes as provider failures, so the same model-fallback/error classes
  apply.
- Never send user secrets in prompts (see the OpenCode free-tier note
  in docs/decision.md — byon-key prompts to hosted models share the
  caution about PII).

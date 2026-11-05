# Codex Adapter Validation (Phase 2)

Question: **can Codex be executed through the same experiment path?**
Answer: **yes, mechanically** — the opt-in real-agent path is provider-neutral
by construction, and a user-supplied callback module is the designed extension
point. One caveat dominates: live runs require auth that this environment
does not have (see `environment.md`); the wiring itself was validated by an
auth-blocked attempt whose raw record is in `results/`.

## Path reviewed

- `evaluation/harness.ts` — `compareEvaluationWorkload(workload, config, execute,
  order)`: mode-neutral; builds baseline prompt (ungoverned serialization of
  task + ALL context items) via the adapter, runs governed through the
  governance pipeline, measures both, validates outcome reports
  (`InvalidEvaluationOutcomeError`), saves comparisons
  (`saveEvaluationComparison`, never overwrites). Execution callback is an
  opaque `(prompt, mode, workloadId) => EvaluationTaskOutcome`.
- `evaluation/real-agent.ts` — `createRealAgentExecute`: per mode creates a
  fresh `os.tmpdir()` workspace holding ONLY `setup` files, awaits the user
  callback, scores with `scoreWorkspace` (shared objective checks — the agent's
  own words never decide outcomes), tears the workspace down, forwards
  optional `{retries, errors}`.
- `evaluation/runner-real.mjs` — refuses to run without `--agent <path>`;
  imports no model/runtime; documents the trust boundary.
- `evaluation/fair-runner.mjs` — repeated comparisons with alternating order
  (rep0 baseline-first, rep1 governed-first), fresh workspaces, raw per-rep
  saves, reproducibility manifest (agent module + `AGENT_SETTINGS`, dataset
  sha-256 per workload JSON, Node version, timestamp).
- `evaluation/agent-claude-cli.mjs` — the prior agent's callback: prompt via
  argv, cwd = workspace, `acceptEdits`, timeout kill → `{retries: 0, errors: 1}`,
  `AGENT_SETTINGS` recorded in the manifest.

The contract `RealAgentCallback = (request: {workloadId, mode, prompt,
workspaceDirectory}) => void | {retries, errors}` is vendor-agnostic: nothing
in `harness.ts`, `real-agent.ts`, or the runners names Claude, imports a
runtime, or assumes a model. Swapping the callback for a Codex launcher IS the
path. No harness, governance, scoring, or runner change is required (and none
was made — constraint respected).

## New module (the designed extension point)

`evaluation/agents/codex/agent-codex-cli.mjs` — mirrors
`agent-claude-cli.mjs` one-for-one. It exports `runAgent` +
`AGENT_SETTINGS`; it launches `codex.exe` (absolute vendored path from
`codex doctor`, overridable via `CODEX_EXE` for reproducibility).

## Agent-specific assumptions (differences from the Claude adapter)

| concern | Claude adapter | Codex adapter | basis |
| --- | --- | --- | --- |
| launch shape | `claude -p <prompt>` (argv) | `codex exec <prompt>` (argv) or stdin `-` | `exec --help` |
| cwd | process cwd = workspace | `-C <workspace>` (cwd also set) | `exec --help` |
| auto-edit permission | `--permission-mode acceptEdits` | `-s workspace-write` + `-c 'approval_policy="never"'` (never prompt in non-interactive exec; `--approve-for-me` is the documented alternative) | `exec --help` |
| non-git workspace | tolerated | `--skip-git-repo-check` required — harness workspaces under `os.tmpdir()` are not git repos (flag documented for "running outside a Git repository"; ordering of git-check vs auth-check unverified because auth fails first) | `exec --help` |
| prompt channel | argv, few KB fine | STDIN `-` positional — **measured**: argv prompt + inherited open stdin hangs codex `exec` (`Reading additional input from stdin...`, SIGKILL at the 240 s timeout, attempt1 raw); write+close stdin EOF launches cleanly (attempt2 raw). The OS-limit argument (~32k UTF-16) is moot — argv was empirically unsafe regardless of size | `results/raw` launch records |
| session state | none per run | Codex persists sessions under `CODEX_HOME`; adapter uses `--ephemeral` + `--ignore-user-config` to keep runs state-free; raw JSONL kept instead | `exec --help` |
| instrumentation | uninstrumented (returns nothing) | `--json` JSONL events + `-o` last-message file → saved as raw evidence per run (token usage if available; `errors`/`retries` mapped to `RealAgentReport` only from explicit launch failures) | `exec --help` |
| auth inheritance | account auth in env | Codex credential state (`~/.codex`/env) — ABSENT here | `codex doctor` |

## Reusable components (all unchanged)

- `dataset.ts` (validation, `toEvaluationWorkload`, `toIntegrationConfig`,
  `scoreWorkspace`), `real-agent.ts`, `harness.ts`, `runner-real.mjs`,
  `fair-runner.mjs` — the whole measurement machinery is shared with the
  Claude round; cross-agent comparability comes from identical dataset state
  (sha-256 in manifests), identical config (`contextWindowTokens = 32_768`),
  and alternating-order policy.
- `agent-claude-cli.mjs` serves as the structural template only.

## Risks (measured or flagged, not suppressed)

1. **Auth blocker (measured at the wire level)** — `doctor`: no credentials;
   no local server. attempt2 raw shows the full pre-model flow: `thread.started`
   → `turn.started` → Responses-WS 401 (`Missing bearer or basic
   authentication`) → documented HTTPS fallback 401 → exitCode 1 (~15 s per
   run). Outcomes remain unmeasurable until the user supplies auth; raw
   records in `results/` + `results/raw/` prove the wiring, not the
   hypothesis.
2. **Windows sandboxing under Defender** — `doctor` warns Codex helpers
   (`codex-windows-sandbox-setup.exe`, `codex-command-runner.exe`,
   `codex-code-mode-host.exe`) may be blocked; a blocked sandbox would surface
   as exec errors, not silent success (checks score the filesystem, so any
   mis-attribution cannot fake a pass).
3. **Default-model drift** — with login, the account default model can change
   across releases; `-m` must pin it and `AGENT_SETTINGS` must record it
   (adapter supports `CODEX_MODEL` override).
4. **Websocket warning** — `doctor` reports Responses-WS failed with HTTPS
   fallback; latency measurements must be read with that caveat.
5. **Approval semantics — flag acceptance measured, live behaviour still
   unverified** — attempt2 raw proves codex PARSES and ACCEPTS
   `-s workspace-write` + `-c 'approval_policy="never"'` (launch proceeds
   past argument validation to the auth step; `turn.started` is emitted
   before the 401). Auto-applying edits mid-session on a REAL model turn
   remains unconfirmable until credentials exist.
6. **Session pollution avoided by `--ephemeral`** — chosen so runs don't
   inherit Codex session history; the raw JSONL is the record instead.

## Verdict

Codex CAN execute through the same experiment path: same runners, same
workspaces, same objective checks, same governed/ungoverned prompt
construction. The gap is credential state, not integration. The honest
limitation (unchanged from `docs/BENCHMARK_DATASETS.md`) still applies:
outcomes from real runs are comparable only at N ≥ 5 alternating reps with
settings recorded — and see `benchmark-review.md` for whether this workload
trio can carry outcome evidence at all.

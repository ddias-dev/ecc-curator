# Codex Baseline vs Governed — Comparison (Phase 6)

Configuration (identical for every row; recorded in
`evaluation/agents/codex/results/fair-manifest.json`): Codex CLI `codex exec`
0.166.0 vendored win32 binary, model = account/config default (UNDETERMINED —
no credentials), sandbox `workspace-write`, `approval_policy=never`, prompt via
stdin, `--ephemeral --ignore-user-config --skip-git-repo-check`, Node
harness v24.22.1, `contextWindowTokens=32_768`, dataset `benchmarks/coding`
(sha-256 state in manifest), order baseline→governed (rep r0), N=1 (below the
plan minimum N≥5 — recorded).

**Outcome status for all rows: BLOCKED-PRE-MODEL.** Every run reached the
network layer and was rejected at auth (`401 Unauthorized` raw in
`results/raw/*-launch-error.log`); no model turn ever executed. The harness
still scored the untouched workspace with the objective checks, and recorded
the governance-pipeline metrics (those are harness-side and deterministic —
they do not depend on the agent, and that independence is itself a finding,
see below).

## feature-work-greeting (`results/feature-work-greeting-attempt2-r0.json`)

| metric | baseline | governed |
| --- | --- | --- |
| outcome | NOT completed — errors 1, `errorStage: agent`, tests 0/1 (spec import of missing `shout` fails on untouched workspace) | NOT completed — errors 1, `errorStage: agent`, tests 0/1 |
| prompt size (est. harness tokens) | 368 | 613 (LARGER; +245 framing) |
| context (est. tokens / items) | 139 / 5 kept, 0 dropped | 110 / 4 kept, 1 dropped (`log-1` terminal noise DROPped by rule) |
| runtime | 15.18 s (launch → exitCode 1, `killed=false`) | 14.64 s |
| retries / errors reported by adapter | 0 / 1 (401 auth) | 0 / 1 (401 auth) |

Observed behavioural differences: **none on the agent side** — both modes died
at the auth boundary before any model turn; the workspace stayed at setup state
in both. Governance itself acted (1 item dropped, package reframed) but there
was no agent consequence to compare.

## issue-fix-boundary (`results/issue-fix-boundary-attempt2-r0.json`)

| metric | baseline | governed |
| --- | --- | --- |
| outcome | NOT completed — errors 1, tests 0/1 | NOT completed — errors 1, tests 0/1 |
| prompt size | 514 | 899 (+385) |
| context | 262 / 7 kept, 0 dropped | 209 / 6 kept, 1 dropped (`log-1`) |
| runtime | 15.57 s | 15.78 s |

Behavioural differences: same as above — governance acted, agent blocked;
neither mode ever attempted the fix.

## refactor-rename-helper (`results/refactor-rename-helper-attempt2-r0.json`)

| metric | baseline | governed |
| --- | --- | --- |
| outcome | NOT completed — errors 1, tests 0/1 | NOT completed — errors 1, tests 0/1 |
| prompt size | 535 | 858 (+323) |
| context | 263 / 8 kept, 0 dropped | 180 / 6 kept, 2 dropped (`log-1`, `log-2` noise) |
| runtime | 14.70 s | 15.54 s |

## Cross-run raw-evidence chronology (what this round establishes)

| tag (in `results/`) | adapter channel / state | measured raw signature |
| --- | --- | --- |
| `auth-attempt` | argv prompt + raw-evidence logging bug (ISO colons in filename on Windows → callback threw) | comparison runs record `testsTotal 0` (scoreWorkspace skipped via harness catch); durations ~15 ms |
| `attempt1` | argv prompt, logging fixed | Codex `exec` prints stderr `Reading additional input from stdin...` and HANGS on the open stdin pipe; killed by adapter at 240 s (`signal=SIGKILL`) |
| `attempt2` | stdin `-` channel (write+close=EOF) | Codex launches: `thread.started`, `turn.started`, WS 401 (`Missing bearer or basic authentication`, url `wss://api.openai.com/v1/responses`), documented fallback to HTTPS, exitCode 1 at ~15 s |

## Interpretation (raw-evidence bounded, no speculation)

- **Outcome-vs-outcome comparison: EMPTY** — neither mode executed a model
  turn. The task-level comparison this document exists to produce cannot be
  filled for Codex under the current credential state.
- **Governance-pipeline comparison: filled and byte-identical to the Claude
  round** (trial3 / N=5 reference): same 368→613, 514→899, 535→858 prompt
  tokens; same kept/dropped. These metrics depend on the harness and the
  datasets, not the agent — reproducing them through a different agent
  confirms their harness-side (deterministic-estimator) provenance. The
  governed-larger-than-baseline finding is therefore agent-agnostic
  *mechanism behaviour*, exactly as `evaluation/hypothesis-report.md` Q2
  described, and equally NOT evidence about task outcomes.
- **Integration mechanics: confirmed end-to-end** — the Codex callback
  launches, the harness scores real objective checks (0/1 on untouched
  workspaces), the manifest records settings, and raw per-mode evidence
  persists. The blocker is credential state, not wiring.

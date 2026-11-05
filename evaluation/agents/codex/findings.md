# Findings — Codex round (Phase 7)

Question under test (the task's): *does ECC Curator's context-governance
approach produce measurable effects independent of the coding agent?* Both
hypotheses (governance helps / Codex differs) treated as unproven.

## 1 Per-workload classification

| workload | classification | why |
| --- | --- | --- |
| feature-work-greeting | **inconclusive — measurement blocked** | neither mode executed a model turn |
| issue-fix-boundary | **inconclusive — measurement blocked** | same |
| refactor-rename-helper | **inconclusive — measurement blocked** | same |

Deliberately NOT "no measurable difference": that label requires two
completed runs whose outcomes match. Here the comparison never became
observable — raw evidence: `results/<workload>-attempt2-r0.json` records both
modes with `errors: 1`, `errorStage: agent`, tests 0/1 on an untouched
workspace; `results/raw/*-launch-error.log` carries the wire-level
`401 Unauthorized` (WS → HTTPS fallback, exitCode 1) for all six runs.

## 2 Round verdict on the task's question

**Not answerable in this environment, and unanswerable on this benchmark
trio even with credentials.** Two independent blockers compose:

1. **Environment (this round):** no Codex credentials (`doctor ✗ auth`;
   `~/.codex/auth.json` absent; no key env var; local `--oss` server probes
   all failed). Every run died at the auth boundary.
2. **Benchmarks (structural, agent-agnostic):** `benchmark-review.md` classifies
   all three workloads `C` — baseline prompt carries the full spec/solution,
   governance can only drop noise items. Under the plan's selection rule the
   trio yields zero evidence-bearing workloads for ANY agent. If Codex runs
   ever complete, the only outcome this trio can produce is the task's
   Outcome E (*current benchmarks cannot detect a difference*) — corroborated
   for Claude by `evaluation/results-trial3/` (both modes pass all three).

## 3 What this round DOES establish (each row cites raw evidence)

| claim | status | raw evidence |
| --- | --- | --- |
| Governance decisions (kept/dropped items, prompt shapes 368→613 / 514→899 / 535→858 est. tokens) are harness-side, deterministic, and reproduce byte-identically through a different agent — they are **agent-agnostic mechanism behaviour**, not outcome evidence | established | `results/*-attempt2-r0.json` vs `../results-trial3/` (Claude) — identical numbers |
| Governed prompts are LARGER than baseline at fixture scale (the "+framing" finding) | established, mechanism only | both comparison files |
| Codex CAN be wired through the real-agent path unchanged (callback, workspaces, objective checks, manifest) | established | attempt2 runs scored 0/1 against real checks; `results/fair-manifest.json` |
| argv prompt is NOT safe for codex `exec` under this harness (hangs on inherited open stdin) — stdin `-` channel is | established, agent-specific | attempt1 raw: `Reading additional input from stdin...` + SIGKILL at 240 s |
| Codex pre-model auth failure is loud and structured (exit 1, WS 401 → HTTPS) — cannot fake a pass | established | attempt2 raw launch logs |
| Any governance effect on task outcomes | **NOT established either way** | (no model turn occurred) |

## 4 To make the test answerable (measurement prerequisites, not guesses)

1. **Credentials**: user decision — `codex login`, `codex login --with-api-key`
   (stdin), or a local ollama/LM Studio for `--oss`. Pin the model (`-m` /
   `CODEX_MODEL`) and run N ≥ 5 alternating reps per the fairness plan.
2. **An evidence-bearing workload family**: per `evaluation/workload-selection.md`
   the hypothesis-bearing family is W1 (long-session replay with
   re-acquisition pressure, built from `datasets/real-sessions/` captures).
   It is not built for Claude either, so it constrains BOTH agents equally —
   itself an agent-agnostic prerequisite.

## 5 Mapping onto the task's acceptable outcomes

- With current credentials state: **inconclusive / blocked** — the honest label for
  this round; no outcome-class letter is claimable.
- Ceiling once credentials exist, on the current trio: **Outcome E** — the
  benchmarks cannot detect a difference; that is what an outcome-E reading on
  Codex would confirm (the structural limitation is agent-agnostic), NOT
  test, the hypothesis.
- The hypothesis itself (*governance improves outcomes under context pressure*)
  remains **untested for every agent** — no evidence for or against exists
  yet in this repo; both Claude and Codex rounds measure plumbing and
  mechanism, per `evaluation/hypothesis-report.md` and this round.

## Evidence index (this round)

- `results/fair-manifest.json` — settings, dataset sha-256, node version, N=1 (below plan)
- `results/*-attempt2-r0.json` — per-workload baseline/governed metrics
- `results/raw/attempt2-*` — six 401 launch records (WS→HTTPS fallback, exit 1)
- `results/raw/attempt1-*` — the argv-channel hang (agent-specific integration finding)
- prior agent reference: `evaluation/results-trial3/` (Claude, completed runs, all pass/pass)

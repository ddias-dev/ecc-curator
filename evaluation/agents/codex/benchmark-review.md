# Benchmark Review for Codex (Phase 3)

Scale: `A` evidence-bearing · `B` potentially useful · `C` plumbing-only ·
`D` invalid benchmark. For each workload the two required answers are about
Codex specifically: *realistic opportunity to fail?* and *governance
opportunity to help?*

## Method note

The trio is agent-agnostic in construction (same workspaces, same prompt
projection), so the structural failure questions below hold for ANY agent —
Claude or Codex. What differs per agent is only whether runs can execute at
all (auth), not whether the workload could discriminate.

## `feature-work-greeting` — **C (plumbing-only)**

- Baseline prompt = task + EVERY context item (`toEvaluationWorkload`,
  commit `da6b19f` policy). The task string is
  "Add shout(message) ... returns the message uppercased with a trailing
  exclamation mark" — the spec verbatim; `tool-1` restates it; the test
  asserting the answer is present in the workspace itself.
- **Would Codex have a realistic opportunity to fail?** No. The prompt
  contains the complete spec; a competent agent following its prompt writes
  `shout()`. A failing outcome would be an agent defect (refusal, tool
  failure), not context pressure — that class of failure is invisible to
  governance here.
- **Would governance have a realistic opportunity to help?** No. Governed
  mode drops only `log-1` (terminal noise) and re-frames kept items; the
  retained package still carries goal/task/file/tool items — the same spec.
  A Claude real run (trial3) passed both modes 1/1; raw token record shows
  the governed prompt LARGER (613 vs 368 est. tokens), so even the
  context-size lever is absent at this scale.

## `issue-fix-boundary` — **C (plumbing-only)**

- Strongest counter-evidence in the dataset itself: the task string states
  the fix ("returns count + 1 for positive counts"), and context item
  `diff-1` contains the literal solution line
  `+  return count <= 0 ? 0 : count + 1;`. This is what
  `evaluation/workload-selection.md` calls out (baseline agent reading its
  prompt cannot fail).
- **Codex fail opportunity?** No — the answer is IN the prompt twice (task
  text + diff item). Governance cannot improve a task whose solution is
  already fully visible; both modes carry `diff-1` (only `terminal_output`
  is rule-DROPped).
- **Governance help opportunity?** No. Same structural reason. (Completion
  check needle `count + 1` is in the prompt too.)

## `refactor-rename-helper` — **C (plumbing-only)**

- Task string states the rename ("Rename normalize() to tidyText() ... then
  make tests pass"); `task-1` and `plan-1` repeat it; `diff-1` shows the
  exact edit. Two terminal noise items (`log-1`, `log-2`) exist — DROPping
  them is real governance ACTION, but the kept package still contains the
  full instruction.
- **Codex fail opportunity?** No — instruction is verbatim in the prompt.
- **Governance help opportunity?** No — drops target only noise items; no
  decision here can change a pass into a fail or vice versa for an agent
  that reads its prompt.

## Why none is `D`

The trio is not invalid plumbing: it loads, validates, materializes fresh
workspaces, and scores objective checks (raw proof: `evaluation/results/*-ref-r0..r4`
and `results-trial3/` completed real runs). It measures plumbing, not
behaviour — that is `C` in this scale.

## Consequence for the Codex round

Under the plan's selection rule (reject workloads where baseline-pass AND
governed-pass — they prove nothing; keep only workloads where baseline
degrades BEFORE governance), this trio yields **zero evidence-bearing
workloads for any agent**. If Codex runs (auth permitting) complete on this
trio and both modes pass, the correct reading is the plan's **Outcome E**:
*current benchmarks cannot detect a difference*. That outcome, reached on
Codex, would CONFIRM the agent-agnostic structural limitation rather than
test the hypothesis.

The hypothesis-bearing workload family remains **W1** (long-session replay
with re-acquisition, `evaluation/workload-selection.md`) — NOT BUILT for
Claude, and therefore also unavailable for Codex. Building it is a
measurement prerequisite for BOTH agents; nothing about Codex makes it
easier or harder to construct — context items and checks derive from the
Claude session captures (`datasets/real-sessions/`), which any agent can
replay.

## Per-classification table

| workload | class | fail opportunity | governance opportunity | evidence |
| --- | --- | --- | --- | --- |
| feature-work-greeting | C | none (spec in prompt) | none (only noise droppable) | dataset contextItems; trial3 613 vs 368 |
| issue-fix-boundary | C | none (solution in task + `diff-1`) | none (`diff-1` kept in both modes) | dataset `diff-1`; workload-selection.md |
| refactor-rename-helper | C | none (instruction in task) | none (noise-only drops) | dataset items; trial3 858 vs 535 |

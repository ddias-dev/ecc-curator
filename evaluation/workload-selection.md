# Workload Selection (Priority 4)

Selection rule (plan): reject workloads where baseline passes AND governed passes —
they prove nothing. Keep only workloads where baseline FAILS or DEGRADES before
governance is introduced. Required per kept workload: why selected, observed
failure mode, expected governance benefit.

## Current benchmark set: `benchmarks/coding/` (3 fixtures)

Raw evidence: `evaluation/results/*-ref-r0..r4.json` (N=5 alternating repetitions
via `evaluation/fair-runner.mjs`, deterministic reference agent) and the older
`evaluation/*-paired.json` scripted runs.

| workload | baseline | governed | verdict |
| --- | --- | --- | --- |
| feature-work-greeting | completed, 1/1 | completed, 1/1 | **REJECTED** (both pass) |
| issue-fix-boundary | completed, 1/1 | completed, 1/1 | **REJECTED** (both pass) |
| refactor-rename-helper | completed, 1/1 | completed, 1/1 | **REJECTED** (both pass) |

All three fixtures fail the selection rule for the SAME structural reason, visible
in the dataset itself: the fixture `contextItems` include `diff-1` whose content is
LITERALLY the solution (e.g. issue-fix-boundary's diff contains `count + 1`), and
the baseline prompt now serializes task + all ungoverned context (commit `da6b19f`).
A baseline agent that reads its prompt cannot fail these tasks. These fixtures
measure plumbing, not the hypothesis — exactly what
docs/BENCHMARK_DATASETS.md ("Fixture realism: current fixtures are synthetic and
small") warns.

Incidental but real observation from the N=5 raw data (all reps identical because
the reference agent is deterministic): the governed prompt is LARGER than the
baseline prompt at fixture scale (e.g. issue-fix-boundary 899 vs 514 prompt
tokens). The governed package adds per-item framing the ungoverned serialization
does not. At these tiny scales governance does not reduce prompt size; any
prompt-size claim must be tested where ungoverned context is large — see the
real-session data (below) and the hypothesis report.

## Real-agent note

The real-agent path (`evaluation/fair-runner.mjs --agent evaluation/agent-claude-cli.mjs`,
Claude CLI, `claude-haiku-5-5`, `--permission-mode acceptEdits`, full env inheritance)
executed the CLI for each fixture: all baseline and governed runs recorded
`errors: 1, errorStage: "agent"` with the CLI's own stderr showing the prompt
channel was not delivered (launch/mechanics failure, NOT task failure). Real-agent
outcomes on these fixtures are therefore currently UNMEASURED, and since the
fixtures are rejected by the rule above, this set cannot test the hypothesis either
way. A working real-agent run requires fixing the callback channel and the user
explicitly authorizing agent runs (opt-in guard).

UPDATE after `evaluation/results-trial3/` (N=1, tag trial3, prompt delivered via
argv): the real-agent channel now WORKS — real Claude CLI runs completed on all
three fixtures, baseline and governed BOTH pass 1/1 checks (raw in
`evaluation/results-trial3/`). This closes the mechanics question but not the
hypothesis one: with both modes passing, the trio stays REJECTED under the
selection rule, and N=1 is below the plan minimum. The decisive run remains
W1 (below) at N≥5.

## Candidate workloads — grounded in the real-session dataset

The only context-pressure evidence we have is `datasets/real-sessions/` (15 real
Claude Code sessions). Observed baseline degradation there, before governance:

| signal | observed value | evidence source |
| --- | --- | --- |
| prompt-side growth | 26K -> 53K tokens within a single session, and 1.24M total positive prompt-side additions across 15 sessions | manifest `usagePerTurn` (`scoring-calibration-stats.json` estimatorRows) |
| context compaction (harness rewriting the prompt) | 61 compaction events total; up to 25 in one session | estimatorRows `compactionEvents` |
| re-acquisition after loss | same file path opened repeatedly: per-session `topFileRefs` (e.g. multiple paths with 10+ Read/Glob/Grep invocations) | capture manifest `topFileRefs` |
| false-drop proxy | `ambiguity-report.json`: dropped items whose pathRef is opened again at a LATER turn (rate in report: see `false_drop_proxy_rate`) | ambiguity instrument |

These signals justify exactly one workload family, derived (not fabricated) from
real transcripts:

**W1 — long-session replay with re-acquisition.**
- Why selected: baseline (context accumulation) demonstrably degrades: sessions
  hit 25+ compactions and the agent re-opens the same files 10+ times — re-acquisition
  is the observed failure mode of ungoverned context.
- Observed failure mode: after compaction, needed file context was gone, and the
  session paid a fresh Read of the same file (cost grows with every re-open).
- Expected governance benefit: governance that KEEPS those file/diff items keeps
  them through compaction, so the baseline's re-read count — and prompt growth —
  should not be needed. Measurable on replay: retained-item token cost vs
  re-acquisition token cost.
- Derivation (honest): take a captured session (e.g. `0619e768` or
  `85b1dd6a` — the highest compaction counts), use its real task/goal items and
  real items set as the workload's contextItems, and define checks from markers
  the session actually produced (completion = the observed final file state;
  degradation metric = re-open count from `fileRefs`, not a fabricated test).
- Status: NOT BUILT YET. Building it requires the replay harness decision to be
  made against real transcripts rather than checkable tmp-fixture workspaces;
  it is the next measurement step, not an abstraction to design now.

No other workload family is justified: the plan's rule forbids inventing harder
synthetic fixtures "to make governance win", and none of the three existing
fixtures survives selection.

## Selection decision

- KEPT (real-agent comparison): none — the trio is rejected (trial3: real-agent
  runs completed, both modes pass), and W1 is not yet implemented.
- RUN AND COMMITTED (evidence, honestly labelled reference-plumbing): N=5
  alternating repetitions of the trio, raw results in `evaluation/results/`.

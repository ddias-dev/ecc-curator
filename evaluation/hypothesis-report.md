# Hypothesis Report — Evidence So Far (Priority: final report)

Hypothesis under test: **Context governance improves long-running coding-agent
outcomes.** This report answers the plan's six questions from the evidence
produced this round only: `datasets/real-sessions/` (15 real sessions),
`evaluation/ambiguity-report.json`, `evaluation/scoring-calibration-stats.json`,
`evaluation/results/` (N=5 alternating comparisons, reference agent) and
`evaluation/results-trial2/` (real-agent launch record). Where an answer is
UNMEASURED, it says so — no extrapolation.

## Q1. Does governance improve task completion?

**UNKNOWN — not yet measured.** The only completed comparisons
(`evaluation/results/*-ref-r0..r4.json`) used the deterministic reference agent:
all three fixtures pass in both modes, and by the Priority-4 rule those runs are
evidence of nothing (both pass). The real-agent path (Claude CLI, haiku,
acceptEdits) launched for all six trial comparisons but every run recorded
`errors: 1, errorStage: "agent"` — a prompt-channel/launch mechanics failure, not
a task failure (`evaluation/results-trial2/`, `promptChannel: "stdin"`). The
channel is now fixed (prompt via argv) and `evaluation/results-trial3/` records
COMPLETED real-agent runs on all three fixtures (N=1, below plan minimum):
baseline and governed both pass 1/1 checks on every fixture. So a real agent
actually ran and both modes still pass — by the Priority-4 rule those runs prove
nothing about the hypothesis, but they do prove the measurement machinery works.
No workload survives selection that a real agent could fail with baseline, so the
missing measurement is: real-agent runs at N≥5 on real-session-derived workloads
(W1, `workload-selection.md`). The hypothesis is neither validated nor falsified.

## Q2. Does governance reduce prompt size?

**NOT AS CLAIMED at measured scales — the evidence currently points the other way.**
Raw comparison data (identical across N=5 reference reps, and independently
confirmed by the N=1 real-agent trial3 — identical token counts because the
harness serializes the prompt regardless of agent): governed promptTokens
are LARGER than baseline promptTokens on all three fixtures — 613 vs 368
(feature-work-greeting), 899 vs 514 (issue-fix-boundary), 858 vs 535
(refactor-rename-helper). The governed package adds per-item framing (~100+ tokens
per retained item) that the ungoverned serialization does not pay. Governance does
drop content (kept 4/7, 6/7, 6/8 of items), but at fixture scale the framing
overhead exceeds the content savings. Where ungoverned context is genuinely large
(real sessions: 26K→53K prompt growth in one session, 1.24M positive prompt-side
tokens across 15 sessions, 61 compactions — `scoring-calibration-stats.json`),
content savings should eventually dominate framing — but that crossover has NOT
been measured. Verdict: the mechanism reduces ITEMS but current prompt
SERIALIZATION adds overhead that has eaten the savings at every measured scale.
Any "reduces prompt size" claim is unsupported until a large-context workload is
compared end-to-end.

## Q3. What is the false-drop rate?

**0.4174 (91/218) by the re-acquisition proxy** — of DROPped items whose pathRef
was observable, 91 had the SAME file path/pattern opened again at a LATER turn in
the same session: governance discarded context the real session later needed.
Denominator caveat in `ambiguity-report.json` (`false_drop_note`): items without a
pathRef cannot show re-acquisition and are excluded; the metric therefore measures
the observable subset, and re-reference is a PROXY for "the drop was wrong", not
proof. Directionally this is evidence AGAINST naive DROP decisions on real
sessions: ~42% of observable drops were paid back by re-acquisition.

## Q4. What is the ambiguity rate?

**0.7198 (1,749/2,430)** items land in the middle band `[retainAtOrAbove=0.35,
keepAtOrAbove=0.65)` — the region the deterministic policy substitutes KEEP for,
and where a decision provider could change the outcome (`ambiguity-report.json`;
per-item records, reasonCode derivation documented in
`evaluation/ambiguity-instrument.mjs`). Also raw: 0 items rule-resolved (the
measurement path configures no rules), 681 decisively score-resolved, 749
budget-overflow downgrades. The band is the overwhelming share of decisions — a
provider, if enabled, would be consulted on ~72% of all items.

## Q5. Are decision providers justified?

**No — not yet, and the current evidence argues against enabling them as-is.**
(1) Cost/benefit is unmeasured: no provider has ever been consulted (the
experimental path sets `providerEscalationEnabled=false`), while the ambiguity
rate says a provider would be asked on ~72% of items — per-item model escalation
at that rate contradicts the deterministic-first doctrine's economics it is meant
to preserve. (2) No workload demonstrates a provider proposal that a corrected
deterministic policy would not have made. (3) The biggest measured decision lever
— recency scaling — is a CONSTANTS problem (Q6 below), addressable without a new
decision kind. Keeping the escalation band as a MEASUREMENT (manual-review
candidates) and not enabling providers is the evidence-backed choice. A provider
would need a demonstrated failing workload first — none exists yet.

## Q6. Which scoring constants should change?

Only one change is currently evidence-backed (full data and caveats in
`evaluation/scoring-calibration.md`):

- **halfLifeTurns 10 → session-scaled (larger).** Median recency feature value is
  0.0017 — the feature is dead for most real items (ages in tens–hundreds of
  turns, 61 compaction events); doubling it flips 8.3% of decisions; this variant
  was measured scale-preserving (no weight-ablation artefact).
- referenceSaturation: NO change (3→1 and 3→6 flip zero decisions; unmeasurable at
  95% F=0).
- weights: NO change yet (all remaining flip readings are rescaling artefacts, and
  priority is unmeasurable on this dataset, P≡T).
- token-estimator formula: NO change (per-session ratios 0.44–1.21 vs actual
  prompt-side growth; remaining error is capture mechanics, not the estimator).
- cost feature: range-evidence says it carries no signal at current budgets
  (C∈[0.976,0.999]); removal only after a large-context workload demonstrates the
  range problem — flagged, not applied.

## Verdict

**Not validated, partially falsified at the edges, hypothesis not yet decided.**
- Falsifying direction (real data): governance drops 42% of observable
  re-referenceable items (Q3), and governed prompts measured larger than
  baseline at every measured scale (Q2).
- The decisive measurement is missing: real-agent comparisons now RUN
  (`evaluation/results-trial3/`: argv channel fixed, real Claude CLI completed,
  both modes 1/1 on all fixtures) but only on fixtures where both modes pass —
  no baseline-failing workload has been compared at N≥5 yet (Q1).
- Next measurement steps, in order of evidence value: (1) build the W1
  real-session replay workloads (`workload-selection.md`) where baseline
  degradation is documented; (2) run real-agent comparisons on W1 at N≥5,
  alternating order; (3) recalibrate halfLifeTurns on those runs.
Per the decision rule, all three are measurements — no abstraction is proposed.

## Raw artifacts (committed)

- `datasets/real-sessions/` — 15 real session captures + manifest
- `evaluation/ambiguity-report.json` — per-item decision records + rates
- `evaluation/scoring-calibration-stats.json` + `evaluation/scoring-calibration.md`
- `evaluation/results/` — N=5 alternating reference-agent comparisons (raw, per rep)
- `evaluation/results-trial2/` — real-agent trial error record (stdin prompt channel)
- `evaluation/results-trial3/` — real-agent trial after argv fix (N=1, completed, both modes pass)
- `evaluation/workload-selection.md`, this report

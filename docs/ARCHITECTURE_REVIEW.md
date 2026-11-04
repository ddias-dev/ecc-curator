# ECC Curator — architecture review

Verdict up front: the deterministic core is shippable and green (I re-ran the suite: 192 pass / 0 fail), but the branch is roughly two phases of specification ahead of any measurement, and the thing it adds — a real-agent evaluation path — has produced zero results (`evaluation/` contains only scripted `*-paired.json`; no `*-real.json` exists). The design-stage hedging that was meant to protect honesty has started to rot.

## What to Keep

- The Phase 1–2 pipeline: inventory → score → govern → assemble (`src/pipeline/run.ts`), with the KEEP/DROP-only MVP gate. This is the only part with evidence behind it.
- The budget contract in [PROMPT_ASSEMBLER.md](docs/PROMPT_ASSEMBLER.md#L1): `L = min(window − reserve − margin, maxPrompt?)` with fixed-segment overflow failing explicitly, never silently. That contract is implemented, tested, and actually load-bearing.
- `SCORING_SPEC`'s formula shape and explicit-error discipline (`src/types/scoring.ts`) — the mechanism, not the constants. The T_i table is admitted as illustrative; the weights (0.30/0.25/0.15/0.20/0.10) are a hypothesis with zero calibration data behind them.
- The Claude Code `UserPromptSubmit` hook and the opt-in metadata logging — one real integration point exists; keep exactly what it demonstrates, nothing more.
- ADRs 001–004, 007, 009 in [docs/DECISIONS.md](docs/DECISIONS.md). Those are the decisions the code actually obeys (ADR-004 deterministic-first, ADR-009 measure outcomes).
- `CONTEXT_CLASSIFIER.md` and its "no silent defaults" rule (`src/classify/classify.ts`) — cheap, deterministic, and already shaping what the real session-capture work will need.

## What to Simplify

### Complexity verdicts on the named mechanisms

| Mechanism | Verdict | Why |
|---|---|---|
| Inventory events | **Simplify** | 7 typed kinds with monotone sequence, revision cross-refs, injected clocks — solving auditability for consumers that don't exist. Worse, `ITEM_ARCHIVED` ([src/types/inventory.ts:16](src/types/inventory.ts#L16)) is declared but never emitted in `src/inventory/inventory.ts` (zero occurrences). Keep a thin mutation log; the typed surface is a future replay/persistence system wearing a present-day costume. |
| Revision tracking | **Remove from MVP** | `revision`, `replacesId`, `expectedRevision`, `RevisionConflictError` ([src/types/inventory.ts:136](src/types/inventory.ts#L136)) solve optimistic concurrency for multiple writers. The MVP is single-threaded in-memory. No caller passes `expectedRevision` in the governance path. |
| Lifecycle states | **Simplify to 2** | 5 states (`ACTIVE/COMPRESSED/TRANSFORMED/ARCHIVED/DROPPED`) with a transition table, while the Governor can only execute KEEP/DROP. ARCHIVED is unreachable from governance — no `ARCHIVE` action exists in `GovernanceDecisionRecord`, and [docs/GOVERNOR_ALGORITHM.md](docs/GOVERNOR_ALGORITHM.md) overflow prose says "DROP or ARCHIVE if supported by policy," referencing a policy that was never built. |
| Archiving model | **Remove from MVP** | "Retrievable, excluded from snapshots, no cross-process guarantee" ([docs/CONTEXT_MODEL.md:470](docs/CONTEXT_MODEL.md#L470)) — every sentence is a promise about a persistence layer that doesn't exist. It buys nothing for KEEP/DROP. |
| Provider schemas | **Defer** | `ContextRetentionRequest/Proposal` envelopes, `policyVersion`, `requestId` correlation, 10 proposal-violation codes + 7 call-failure codes + provenance types ([src/types/decision.ts](src/types/decision.ts)) — a fully validated contract for providers that do not exist. The `DecisionKind` vs `DecisionRequestKind` naming collision ([src/types/governance.ts:12](src/types/governance.ts#L12) freezes one as an action alias, [src/types/decision.ts:13-19](src/types/decision.ts#L13) apologizes for it) is a symptom of this premature abstraction, not a fix. |
| Decision kinds | **Remove 5 of 6** | `MemoryImportance/CompressionStrategy/Transformation/Retry/ModelEscalation` ([docs/DECISION_SCHEMAS.md](docs/DECISION_SCHEMAS.md)) — and a 7th, `AgentHandoffDecision`, in JEV_INTEGRATION.md — each exists only as a heading. None has an input surface anyone has observed. |
| Portfolio allocation | **Defer** | The metaphor appears in 7 documents ([grep shows ARCHITECTURE, CONTEXT_MODEL, DECISIONS, GOVERNOR_ALGORITHM, ROADMAP, PROMPT_ASSEMBLER, CONFIGURATION](docs/ARCHITECTURE.md#L62)); an assembler `allocations` fractions field exists, a Phase 8 allocation engine does not. Before baselines exist, a knapsack layer is optimizing a problem you haven't measured. Keep the slogan; delete the allocation table in [docs/CONTEXT_MODEL.md:560](docs/CONTEXT_MODEL.md#L560) and the `allocations` request field until measured. |
| Prompt assembler contracts | **Keep, fix drift** | It's implemented and enforced — but [docs/PROMPT_ASSEMBLER.md](docs/PROMPT_ASSEMBLER.md) names `CandidateOverflow`/`SerializationOverflow` (2 occurrences) which appear in neither the documented `AssemblyResult` union nor the code's actual union (`FixedPromptOverflow`/`PinnedContextOverflow`/`UnresolvableOverflow`). Spec-drift that contract tests will eventually "enforce" for you is a trap, not a feature. |
| Plugin registry concepts | **Remove entirely** | [docs/PLUGIN_API.md](docs/PLUGIN_API.md)'s `Plugin`, `ContextSource`, `ScoringProvider`, `BudgetProvider`, `registry.register` — no code, no demand signal, and its own "proposed" self-label doesn't prevent it being the longest future-facing doc in the repo. The one registry that is real (`DecisionRegistryEntry`, [src/types/decision.ts:138](src/types/decision.ts#L138)) differs from it (`propose` vs `evaluate`), so it isn't even a draft of a future. |

### Documentation duplication

The same three things are restated across 6–9 docs each:

1. "Compression is a strategy. Governance is the decision." — verbatim in [README.md:20](README.md#L20), [docs/ARCHITECTURE.md:19-21](docs/ARCHITECTURE.md#L19), [docs/POSITIONING.md:28](docs/POSITIONING.md#L28), plus the variant "Compression makes context smaller / Governance makes context better" at [docs/ARCHITECTURE.md:419](docs/ARCHITECTURE.md#L419) and [docs/DECISIONS.md:659](docs/DECISIONS.md#L659). Five copies.
2. The KEEP/COMPRESS/TRANSFORM/DROP table and lifecycle/state diagrams appear in README, ARCHITECTURE, POSITIONING, CONTEXT_MODEL, ADR-002/007, PROMPT_ASSEMBLER, and the roadmap.
3. The rules→heuristics→optional-provider→Governor-validates pipeline and the 6-kind decision union appear in ARCHITECTURE, DECISION_INTELLIGENCE, DECISION_SCHEMAS, PROVIDERS, PLUGIN_API, and JEV_INTEGRATION — four diagrams of one concept.

Hierarchy that removes the maintenance burden: one canonical doc per concept, everything else links. POSITIONING.md owns framing (once). CONTEXT_MODEL.md owns item/type/state vocabulary. INVENTORY_API owns the API surface (and only the *implemented* part). GOVERNOR_ALGORITHM owns decision order. DECISIONS.md owns rationale — ADRs must not restate the flow diagrams they justify. ROADMAP owns phases. Delete the restatements rather than paraphrasing them.

The anti-claim hedges are already lying: [docs/INVENTORY_API.md:5](docs/INVENTORY_API.md#L5) says "The repository does not currently implement this API" — `src/inventory/inventory.ts` is 941 lines of exactly this API, ledger-verified. [docs/GOVERNOR_ALGORITHM.md:5](docs/GOVERNOR_ALGORITHM.md#L5) similarly claims it is "not evidence that a Governor exists." These were written to keep a design-stage honest; with the MVP in-tree they now under-claim against your own tests and will mislead reviewers. Either the docs track implementation state with one accurate status line each (the ROADMAP "Current status" paragraph already does this well) or the hedge ritual gets deleted.

### Narrative clarity

- README at 113 lines: keep the first 26; the "Who/what" and "Why compression alone is not enough" sections duplicate POSITIONING.md and the comparison table verbatim. Cut to ~50 lines, one positioning block, one honest status block, doc index.
- "Governance vs Compression" appears as positioning five times across four docs. It's a one-sentence thesis; it needs one home.

## What to Delete

- **Documents:** [docs/PLUGIN_API.md](docs/PLUGIN_API.md), [docs/JEV_INTEGRATION.md](docs/JEV_INTEGRATION.md) (451 lines for a provider PROVIDERS.md already demotes to a "compatibility note" and which has zero code), [docs/CONFIGURATION.md](docs/CONFIGURATION.md) (551 lines of a YAML schema — no loader exists; the real config is the hardcoded `ExperimentalIntegrationConfig` + [.claude/ecc-curator.json](.claude/ecc-curator.json), which just changed `contextWindowTokens` 65536→131072 in the working tree, i.e., the "proposed" config schema isn't what you actually edit).
- **Sections:** DECISIONS.md ADR-012's seven-step migration plan, repository-layout proposal, and Alternatives section (~150 of its 193 lines) — keep the three-line decision ("governance in Curator, execution in host, adapters optional and replaceable") until evidence justifies more; ROADMAP Phase 8's illustrative portfolio JSON; CONTEXT_MODEL's "Token Budget Allocation" percentage table; EVALUATION.md's benchmark-tree categories (`memory/`, `local-models/`, `synthetic/` — only `benchmarks/coding/` exists).
- **Interfaces/APIs (code):** the Phase 3 escalation subsystem for this MVP path — `src/types/decision.ts`, `src/governor/provider.ts`, `tests/decision.test.ts` (≈1,286 lines incl. tests) — move to an archive branch, don't ship in the governance path. Also `RevisionConflictError` + `expectedRevision` machinery, and `ITEM_ARCHIVED`.
- **Concepts:** ARCHIVED state, `replacesId`, the 5 conceptual decision kinds, `ecc-curator.yaml`, "Plugin" vocabulary (rename the one real thing to plainly `DecisionProviderRegistry` if it survives), and the "ECC ecosystem" projection (ecc-memory/ecc-router/runtime-adapters) that currently costs readers a whole README and ADR-010 to justify zero code.

## What to Defer

- Everything provider-shaped (Decision Provider Interface, d1-2B/Jev evaluation, Decision Schemas) until you can show the *ambiguity rate* — how often rules+scoring fail to decide on real sessions. Today that rate is unmeasured; you don't yet know an escalation path is ever needed.
- Compression/transformation executors (Phase 6): the MVP correctly keeps COMPRESS/TRANSFORM as contract values only; keep them out of the docs' diagrams too until an executor exists.
- Portfolio allocation engine, adaptive budgets (Phase 8).
- Multi-runtime adapter framework (ADR-012), Agents Window/Strata/OpenCode/Codex/Cline/Aider — each needs its own ADR when it gets code, not one mega-ADR naming six futures.
- Persistence/retrieval, replay from events, cross-process archiving.

## Highest-Risk Assumptions

1. **The core hypothesis is untested, and the current benchmarks can't test it.** [benchmarks/coding/issue-fix-boundary.json](benchmarks/coding/issue-fix-boundary.json) is an off-by-one fix in a 3-line file with ~12 context items. Both baseline and governed agents will pass it; the paired metric will be Δtokens ≈ nothing-of-interest. "Long-running session" pressure at 64K/128K has zero fixtures at 64K or 128K.
2. **Baseline framing is a hypothesis.** That failure mode is "task + all ungoverned context buried in the window" (your new [evaluation/real-agent.ts:50-56](evaluation/real-agent.ts#L50) baseline prompt) is asserted, not observed — you have no real session transcripts of a failing ungoverned run.
3. **Scoring constants are fabricated.** `DEFAULT_TYPE_BASELINES` and weights ([src/types/scoring.ts:23-33](src/types/scoring.ts#L23)) are reproducibility defaults; nothing calibrated them. They may be the entire reason governed context works or fails.
4. **Token estimation vs the actual GGUF vocab.** [src/token-estimator.ts](src/token-estimator.ts) is a conservative heuristic never checked against the target model's tokenizer; at a 0.65/0.35 threshold band, estimate error alone flips KEEP/DROP decisions.
5. **The hook ≠ the hypothesis.** The `UserPromptSubmit` hook appends selected context; it does not govern the conversation, tool turns, or PreCompact. The roadmap knows this — but the roadmap's "Phase 1–7 mostly checked" language is close enough to implying otherwise that the next reader gets a false completion signal.
6. **Harness fairness.** `compareEvaluationWorkload` runs baseline-then-governed, once ([evaluation/harness.ts:162-209](evaluation/harness.ts#L162)); order is fixed, repetition is manual, real results were never committed. Real agents are nondeterministic at coding-task resolution: any 30-day A/B needs interleaved repeats (N≥5) before the delta means anything.
7. **Provider need itself is unproven** — the whole Phase 3 exists to answer a question (rules/heuristics ambiguity) you've never counted. That's the strongest candidate for deletion, not deferral-in-spirit.

## 30-Day Build Plan

Solo founder, hypothesis only: *"governing context improves long-running coding-agent outcomes."* Ignore every deferred item above; none of it appears here.

- **Days 1–3 — Cut.** Delete the provider subsystem from the active branch (keep on a throwaway branch), delete PLUGIN_API/JEV/CONFIGURATION, fix the two stale "not implemented" claims, single-home the framing in POSITIONING, trim README to ~50 lines. This is a PR-size change; doing it first prevents every later measurement debate from arguing against a 1,900-line spec surface nobody has exercised.
- **Days 3–7 — Evidence, not design.** Write a session-capture tool (the opt-in metadata-only hook logging already exists — extend it): harvest 10–20 real long Claude Code sessions that actually hit context pressure. Reconstruct them into inventory items with the classifier's vocabulary. Delete the toy benchmarks as evidence-bearing; they stay only as plumbing tests (rename the scripted runner so nobody reads its results as outcomes).
- **Days 7–12 — Calibrate the three fabricated constants.** Diff your token estimator against the target GGUF tokenizer; compute a per-type reference signal from captured transcripts (items actually referenced by later turns = the T_i and recency data); measure the rules+score ambiguity rate — this single number decides whether Phase 3 should ever return.
- **Days 12–16 — Workload selection before any measurement.** From captures, pick 3–5 tasks where ungoverned replay *fails* (baseline-fails-first discipline — a benchmark both systems pass is dead weight). Replay at 64K and 128K budgets.
- **Days 16–24 — The actual experiment.** Make the hook the experiment: governed prompt every turn vs ungoverned. Extend `runner-real.mjs` with repeats and interleaved order (baseline→governed→governed→baseline…) — this is a ~1-hour harness change and it is required for the delta to mean anything. Commit the `*-real.json` results to the repo (today there are none).
- **Days 24–28 — One iteration against one failure.** If governed runs regress (a DROP removed the thing the agent needed), fix it in rules/thresholds on the real workload — not in a new abstraction. Log each change as a one-line reason in the ledger you already keep (drafts/PROGRESS_LEDGER.md style).
- **Days 28–30 — Write the result.** The artifact is a table: per workload, pass-rate baseline vs governed over N≥5 interleaved repeats, plus context tokens used per run. If the delta is within noise (and with these workloads it will be until Day 16 proved baseline failures exist), the honest outcome is "hypothesis not yet supported; here are the calibrated constants and the ambiguity rate" — and that document is worth more than another phase of architecture.

## Overall Architectural Grade

**C.** Split honestly:

- **Deterministic core (Phase 1–2): B.** It compiles, tests green (192/192, re-run this session), and its budgets/assembly contracts are real and enforced. It would be an A if it shed revision machinery and the five-state lifecycle.
- **Committed specification: D.** Roughly 60% of the docs' surface (PLUGIN_API, JEV_INTEGRATION, CONFIGURATION yaml, Decision Schemas' five conceptual kinds, ADR-012's migration plan, Phase 8 portfolio, the 6-runtime candidate list) describes capability with zero code, zero demand signal, and — in three cases — zero coherence with the code that exists instead (plugin `evaluate` vs `propose`; `CandidateOverflow` vs the real error union; `ITEM_ARCHIVED` never emitted). Two spec docs now assert the opposite of their own implementation ("does not currently implement this API" above 941 lines of it).
- **This branch specifically: C−.** The real-agent path is correct, honest plumbing — the trust-boundary and opt-in discipline are genuinely protective — but it adds a contract nobody has run (no `*-real.json` exists), and the harness fairness gap (single baseline-before-governed shot) means the day it does run, its first result is statistically inert.

The pattern across the repo is one sentence: **you are specifying the answer to "how do governance decisions help?" before anyone has established that they do.** The deterministic MVP plus captured-session evidence answers that question in 30 days; everything else in the branch is either load-bearing for that answer (pipeline, hook, dataset loader, classifier) or a costume for phases that the evidence may cancel before they're built. Prioritize deleting the costume over perfecting the pipeline — and make the first real-agent results land in-tree, because right now the most valuable thing in this branch is a file that doesn't exist yet (`feature-work-greeting-real.json`).
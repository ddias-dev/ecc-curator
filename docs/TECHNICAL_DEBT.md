# Technical Debt: documentation drift

Evidence-first record of documentation claims contradicted by the repository's own
code. Audited 2026-11-04 against README.md, POSITIONING.md, INVENTORY_API.md,
GOVERNOR_ALGORITHM.md, CONFIGURATION.md, PLUGIN_API.md, and JEV_INTEGRATION.md.
Each entry names the stale statement, the contradicting implementation evidence
(file:line, verified by grep/read this pass), and the minimal action. No
proposed redesigns — these are corrections to existing docs only.

## Verified mismatches

### 1. README.md:53 — "adapters and integrations are planned, not implemented"
- Statement: "adapters and integrations are planned, not implemented in this repository."
- Observed: `experimental/adapter.ts:288` `runExperimentalAdapter` is consumed by
  `experimental/claude-code-hook.mjs` (Claude Code integration; commits 532c680/1196f32,
  2026-11-03). README.md:75 itself says "experimental Claude Code UserPromptSubmit and
  PreCompact hooks" — internal contradiction within the same document.
- Action: scope the sentence to the four named external projects (RTK/Caveman/LLMLingua/Troglodita).

### 2. docs/INVENTORY_API.md:5 — "The repository does not currently implement this API."
- Observed: implemented. `src/types/inventory.ts:11-173` defines every type in the doc
  (InventoryEventType:11, InventoryEvent:23, ContextInventorySnapshot:37, ContextItemPatch:46,
  ContextItemReplacement:55, InventoryQuery:64, InventoryListOptions:79, ReferenceInput:88,
  NewContextItem:97) plus exactly the five typed errors (DuplicateContextItemError:111,
  ContextItemNotFoundError:123, RevisionConflictError:136, InvalidContextItemError:153,
  TokenEstimationError:168). `src/inventory/inventory.ts:305-325` implements the
  ContextInventoryEngine with injected clock/estimator.
- Action: remove the "not implemented" caveat; keep persistence/retrieval as future scope.

### 3. docs/INVENTORY_API.md:39 and :87-107 — contract block vs compiled contracts
- Statement: doc shows `transitionState(id, state, reason, expectedRevision?, replacement?)`,
  `advanceTurn()`/`snapshot()` with no args, no `drop()`, and `ContextMetadata` with an
  index signature.
- Observed: `src/inventory/inventory.ts:309-315` `transitionState(itemId, toState,
  replacement?, expectedRevision?, reason?)` (arg order differs); `:317` adds
  `drop(itemId, reason?)` absent from the doc; `:319` `advanceTurn(turns?)`; `:323`
  `snapshot(options?: SnapshotOptions)` with states filter. `src/types/context.ts:23-31`
  ContextMetadata has no index signature.
- Action: rewrite the block against the compiled contracts.

### 4. docs/GOVERNOR_ALGORITHM.md:5 — "not evidence that a Governor exists"
- Observed: `src/governor/govern.ts` implements the Governor: `decideItem():294` (pin
  hard-constraint :309, rule delegation :319, thresholds :364-388), `fitWorkingSet():465`,
  `govern():586`. The doc's own "Implementation note (Phase 3)" (lines 168, 181) already
  documents that code.
- Action: delete the disclaimer sentence.

### 5. docs/GOVERNOR_ALGORITHM.md:276 — "specifies intended behavior, not current functionality"
- Observed: contradicted by the doc's Phase-3 notes and by `src/governor/govern.ts` +
  `src/governor/provider.ts` implementing exactly what the doc specifies.
- Action: qualify to "compression/transformation execution remains future work"
  (genuinely unimplemented).

### 6. docs/GOVERNOR_ALGORITHM.md:23-74 — contract block vs frozen contracts
- Observed: doc's `decisionProvider?: DecisionProvider` vs
  `src/types/governance.ts:64` `decisionProvider?: ProviderProposalSource`; doc's
  `providerProposal?: DecisionProposal` vs governance.ts:94 `providerProposal?:
  GovernanceDecision` (stores only the action value); doc's
  `allowedActionsByType: Readonly<Record<string, readonly action[]>>` vs governance.ts:42
  `ReadonlyMap<string, ReadonlySet<GovernanceDecision>>`; doc's tuple
  `ambiguityRange?: readonly [number, number]` vs governance.ts:44-47 `{min, max}` object
  (enforced provider.ts:620-629). Runtime `govern()` returns GovernorBudgetResult with
  overflowItemIds/workingBudget/budgetConflicts (govern.ts:208-215), wider than the doc's
  GovernanceResult (which exists at governance.ts:81-85 but is not what govern() returns).
- Action: rewrite the block to match governance.ts/decision.ts frozen contracts.

### 7. docs/PLUGIN_API.md:343 — DecisionProvider interface "is not implemented"
- Observed: implemented since c707cca (2026-11-04). `src/types/decision.ts:96-121`
  ContextRetentionRequest/ContextRetentionProposal, :138-144 DecisionRegistryEntry.propose(),
  :192-200 DecisionEvaluationResult, :208-226 ContextRetentionProvenance;
  `src/governor/provider.ts:164` validateContextRetentionRequest, :257
  validateContextRetentionProposal, :391 evaluateContextRetentionRequest, :467
  resolveContextRetention, :607 gateEscalation.
- Action: state that the ContextRetentionDecision contract IS implemented (Phase 3);
  remaining kinds stay future.

### 8. docs/PLUGIN_API.md:303-341 — six-kind DecisionKind union + generic DecisionRequest/Proposal
- Observed: governance.ts:12 `DecisionKind` is an ALIAS of GovernanceDecision
  (KEEP|DROP|COMPRESS|TRANSFORM) — different semantics; the task kinds live at
  `src/types/decision.ts:37` DecisionRequestKind = "ContextRetentionDecision" ONLY;
  the other five kinds are deliberately excluded until their own contracts (decision.ts:29-35,
  Phase 4+). The generic DecisionRequest/DecisionProposal/DecisionProvider names exist
  nowhere in src (no grep matches).
- Action: rewrite using DecisionRequestKind/DecisionRegistryEntry terminology and note
  the governance.ts DecisionKind alias collision.

### 9. docs/PLUGIN_API.md:376-394 — "provider implementations are not currently present"
- Observed: the registry MECHANISM is implemented — DecisionRegistryEntry
  (decision.ts:138-144, enabled/timeoutMs capabilities), selectRegistryEntry first-entry-per-kind
  lookup (provider.ts:371-381), DEFAULT_CALL_TIMEOUT_MS = 5_000 (provider.ts:56). What
  remains absent: concrete providers (grep CompressionProvider|registry.register across src: none).
- Action: replace the illustrative registry with the real DecisionRegistryEntry contract;
  keep "no concrete providers implemented".

### 10. docs/JEV_INTEGRATION.md:334-356 — proposed `DecisionProvider.evaluate(...)` interface
- Observed: no `evaluate`/`DecisionResult` symbols exist anywhere in src. The implemented
  provider surface (2026-11-04) is `src/types/decision.ts:143`
  DecisionRegistryEntry.propose(request: ContextRetentionRequest): Promise<ContextRetentionProposal>
  with capability/enabled/timeoutMs gating and the Governor-side DecisionEvaluationResult
  envelope (decision.ts:192-200; failure codes :170-176, violation codes :178-188).
- Action: rewrite the interface section against the implemented contracts; the header
  claim at line 7 ("not an implemented Jev integration") remains true and stays.

### 11. docs/JEV_INTEGRATION.md:176-207 — Context Retention sample omits the wire envelope
- Observed: implemented ContextRetentionRequest requires requestId/kind/schemaVersion/
  policyVersion/allowedOutcomes + bounded input (itemId, itemType, taskSummary, tokenCost,
  ageTurns?, referenceCount?, pinned) — decision.ts:96-103, enforced by
  provider.ts:88-162; proposals must echo requestId/kind/schemaVersion and outcome must be in
  allowedOutcomes (provider.ts:266-294; requestId derivation "retain:<itemId>@<policyVersion>"
  provider.ts:64/170). The doc's sample ({"decision":"context_retention",...,"outcome":"COMPRESS"})
  omits every envelope field.
- Action: rewrite samples to the implemented wire shape.

## Omissions (not contradictions)

- README.md:79-97 documentation list omits `docs/CONTEXT_CLASSIFIER.md` and
  `docs/BENCHMARK_DATASETS.md`, both present and describing implemented subsystems
  (src/classify/classify.ts, evaluation/dataset.ts).
- CHANGELOG.md:160 still says "Provider support remains future work" and :216-223 lists
  Claude Code/ECC Harness as deferred, though the decision provider interface (c707cca),
  Claude Code hooks (532c680/1196f32), classifier, and real-agent path (cdbb7b4) landed
  2026-11-03/04 after the top [0.1.0] 2026-11-01 entry. CHANGELOG was outside the audited
  seven but is stale against its own content.

## Verified still accurate (sample of checks performed)

- README.md:75 hook/logging/harness claims match experimental/claude-code-hook.mjs
  LOGGABLE_EVENTS:18, logging.enabled gate (:256-262), metadata-only appendMetadataLog
  (:117-165), callback harness (evaluation/harness.ts).
- No d1-2B/Jev integration exists: repo grep finds those names only in comments
  (decision.ts:10/:82) and a test fixture string (tests/dataset.test.ts:63).
- Numeric thresholds match: keepAtOrAbove 0.65 / retainAtOrAbove 0.35 (GOVERNOR_ALGORITHM.md:132
  vs govern.ts:251-252); budget band edges are never asserted by the audited docs.
- CONFIGURATION.md core design-stage claims hold: no ecc-curator.yaml loader, no ECC_CONTEXT_WINDOW
  env var, no --profile CLI (zero grep matches outside docs); the 3-weight scoring example
  (recency 0.4 / references 0.3 / priority 0.3) does not match DEFAULT_WEIGHTS
  (src/scoring/score.ts:125-131: priority 0.30, recency 0.25, references 0.15, typeBaseline 0.20,
  cost 0.10) — flag as example drift, add pointer to DEFAULT_SCORING_CONFIG.

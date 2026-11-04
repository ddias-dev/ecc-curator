# Roadmap

> Build context governance for long-running local coding agents.

ECC Curator will evolve incrementally, validating the governance model before introducing advanced optimization and decision intelligence. The primary workload is long-running autonomous coding sessions under finite context and hardware budgets. Token reduction is an efficiency measure, not a success criterion by itself; task completion and quality must be evaluated alongside it.

Implementation specs: [Governor Algorithm](GOVERNOR_ALGORITHM.md), [Scoring Spec](SCORING_SPEC.md), [Inventory API](INVENTORY_API.md), and [Prompt Assembler](PROMPT_ASSEMBLER.md).

## Current status

The deterministic inventory, rules, scoring, Governor, and prompt-assembly pipeline for Phases 1–2 is implemented. The Phase 3 provider-neutral Decision Provider Interface is also implemented for `ContextRetentionDecision` (contracts in `src/types/decision.ts`, Governor-side enforcement in `src/governor/provider.ts`): gated provider escalation, typed validation and fallback codes, and decision provenance — with no decision-provider adapter implemented yet and baseline operation still never requiring a provider. Claude Code Agent is the first-class runtime target and already has a limited integration: an opt-in `UserPromptSubmit` hook adds explicitly selected governed context, and a paired evaluation harness is available. This does not govern the full conversation or autonomous tool turns, and no benchmark results or outcome improvements have been established.

**Current focus:** validate the Phase 1–2 pipeline in bounded, repeatable baseline-versus-governed workloads using the Phase 5 evaluation tooling. Benchmark datasets, loader/validation, and a paired dataset runner now exist (`docs/BENCHMARK_DATASETS.md`), and a metadata-only context classifier is in place (`docs/CONTEXT_CLASSIFIER.md`); the default runner still executes a scripted reference agent, and an opt-in real-agent evaluation path (`evaluation/runner-real.mjs`, explicit `--agent` callback required — nothing invokes a model or runtime by itself) now lets a user run the same bounded workloads with a real coding agent, but repeated real-agent runs and the resource measurements listed in Phase 5 remain future work. Do not treat Phase 7 as complete based on the experimental Claude Code hook.

## Runtime integration direction

The proposed integration direction is a runtime adapter framework, with **Claude Code Agent** as the first-class design target and existing integration. The adapter work should formalize and isolate the current Claude Code behavior without overstating its coverage. **Agents Window, Strata, OpenCode, Codex, Cline, and Aider** are runtimes to evaluate individually, not first-class targets by default. ECC Harness is not the target integration architecture; [ADR-012](DECISIONS.md#adr-012-replace-standalone-ecc-harness-with-runtime-adapters) proposes a staged transition and remains subject to acceptance and migration evidence. None of the candidate runtimes imply current compatibility. The initial local coding-model evaluation target is **ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF**. The reference local decision-provider evaluation candidate is **LiquidAI/d1-2B**; **Jev** is a reference provider candidate.

---

# Guiding Goals

Intended success measures include:

- Signal density
- Reasoning quality
- Agent runtime duration
- Context utilisation efficiency

while reducing:

- Token consumption
- Context-window exhaustion
- Unnecessary model escalation
- Verbose or redundant context

---

# Phase 0 — Foundation

**Objective:** Define the core architecture and governance model.

## Deliverables

- [x] Project architecture
- [x] Context item model
- [x] Governance principles
- [x] Evaluation methodology
- [x] Benchmark datasets — small offline fixture set (`benchmarks/`), loader/validation, and a paired baseline-versus-governed runner (real-agent measurements remain future work)
- [x] Token accounting framework

## Success Criteria

- [x] Architecture documented
- [x] Core abstractions stabilised for the deterministic MVP
- [x] Evaluation framework defined

---

# Phase 1 — Rules

**Objective:** Prove that context governance works without AI.

## Deliverables

- [x] Context inventory
- [x] Token estimation
- [x] Budget manager
- [x] Rule engine
- [x] Context classifier (narrow, deterministic, metadata-only; experimental — docs/CONTEXT_CLASSIFIER.md)
- [x] Prompt assembler

## Planned Governance Outcomes

```text
KEEP
DROP
```

## Example Rules

```yaml
terminal_output:
  drop_after_turns: 3

completed_tasks:
  drop_after_turns: 5

tool_output:
  max_retention: 10
```

## Success Criteria

- [x] Deterministic governance decisions are reproducible for the same inputs and policy
- [x] Context use and task outcomes can be measured against an ungoverned baseline using the evaluation harness
- [x] No external dependency is required for the deterministic baseline

---

# Phase 2 — Heuristics

**Objective:** Introduce scoring and prioritisation.

## Deliverables

- [x] Context scoring
- [x] Relevance heuristics
- [x] Recency weighting
- [x] Reference tracking
- [x] Context ageing

## Planned Governance Outcomes

```text
KEEP
COMPRESS
DROP
```

## Success Criteria

- [x] Policies are configurable and explainable
- [x] Governance choices can be evaluated against task outcomes and context budgets using the evaluation harness
- [x] Project-specific governance profiles can be expressed

---

# Phase 3 — Decision Provider Interface

**Objective:** Define a provider-neutral interface for optional decision intelligence.

The Governor remains responsible for policy, validation, final decisions, and execution. Provider output is advisory.

See [Decision Intelligence](DECISION_INTELLIGENCE.md), [Decision Schemas](DECISION_SCHEMAS.md), and [Providers](PROVIDERS.md) for the proposed interface, provider-independent contracts, and current evaluation-candidate status.

## Deliverables

- [x] Decision kinds and provider-independent schemas — implemented for `ContextRetentionDecision` (`src/types/decision.ts`); the other decision kinds remain conceptual
- [x] Provider capability declaration and registry contract — `DecisionRegistryEntry` with explicit opt-in `enabled` flags and deterministic first-capable lookup
- [x] Governor-side result validation and allowed-outcome enforcement — raw provider output handled as `untrusted`, re-validated against the request, normalized, and rejected with typed violation codes
- [x] Deterministic fallback behavior and provenance — gated escalation, byte-identical deterministic-record fallback, and `ContextRetentionProvenance` recording why a provider was or was not consulted

## Success Criteria

- Providers cannot bypass policy, budgets, or safeguards
- Disabled, failed, and invalid providers fall back deterministically
- No provider is required for baseline operation

---

# Phase 4 — Reference Providers

**Objective:** Evaluate reference providers independently behind the same Decision Provider Interface.

## Candidates

- [ ] LiquidAI/d1-2B — reference local decision-provider evaluation candidate
- [ ] Jev — reference provider candidate
- [ ] Local custom providers

Neither candidate is a core dependency or an implemented integration. d1-2B evaluation must include bounded decision state, local resource use, and its documented reliability caveat beyond about 64K tokens of state. See [Providers](PROVIDERS.md).

## Success Criteria

- Provider contract tests pass for each adapter before comparison
- Candidate status, model/version, license, runtime, and resource assumptions are documented
- Decision-provider failures do not bypass deterministic safeguards

---

# Phase 5 — Benchmarking and Evaluation

**Objective:** Compare provider-assisted decisions with deterministic baselines on long-running coding workloads.

## Deliverables

- [ ] Decision-specific evaluation datasets and expected outcomes
- [ ] Rules-only and heuristic-only baselines
- [ ] Independent d1-2B and Jev provider evaluations
- [ ] 32 GB RAM / 16 GB VRAM resource and coexistence measurements with the target coding model
- [ ] 64K and 128K agent-window workloads with bounded provider inputs
- [ ] Reporting for decision quality, false drops, task completion, tests, retries, escalation, latency, and resource use

## Success Criteria

- Reproducible measurements include provider versions and configuration
- Adoption is based on task outcomes and operational constraints, not provider branding or token reduction alone
- No measured compatibility or savings claim is published without supporting evidence

---

# Phase 6 — Compression and Transformation Providers

**Objective:** Execute strategies selected by governance through separate, replaceable providers.

## Deliverables

- [ ] Compression provider abstraction
- [ ] Evaluate potential RTK adapter
- [ ] Evaluate potential Caveman adapter
- [ ] Evaluate potential LLMLingua adapter
- [ ] Evaluate potential Troglodita adapter
- [ ] Log summarisation and test-result transformation providers

The listed projects are candidates, not current dependencies or validated compatibility targets. Decision providers choose only among registered strategies; execution remains separate.

## Success Criteria

- Governance decisions remain separate from compression and transformation execution
- Strategy outputs are checked before being returned to the context assembly flow

---

# Phase 7 — Runtime Adapter Integrations

**Objective:** Expose Curator governance in agent workflows through optional adapters, without transferring execution or model invocation out of the host agent.

> Agent integrations may consume [Agent Execution Rules](integrations/AGENT_EXECUTION_RULES.md) as a standard execution profile for context-aware development agents.

This adapter direction is proposed in [ADR-012](DECISIONS.md#adr-012-replace-standalone-ecc-harness-with-runtime-adapters). Define and test the runtime-neutral contract and capability reporting before claiming runtime support.

## First-Class Runtime Target

- [x] Claude Code Agent — existing limited `UserPromptSubmit` integration; formalize and isolate behind the runtime adapter boundary

## Runtime Adapter Candidates

- [ ] Agents Window — evaluate available integration points and contract fit
- [ ] Strata
- [ ] OpenCode
- [ ] Codex
- [ ] Cline
- [ ] Aider

## Success Criteria

- A versioned, runtime-neutral contract and explicit adapter capability model are tested independently of runtime SDKs
- Runtime-specific code and dependencies are isolated from the Curator core
- Integrations expose only capabilities supported by their host runtime
- The host agent retains ownership of planning, tool execution, and model invocation
- Evaluated in long-running autonomous coding sessions against an ungoverned baseline
- Task completion and test outcomes are not worse while context use is evaluated
- Evaluation includes the 32 GB RAM / 16 GB VRAM target profile and 64K and 128K context windows
- Model escalation and retries are measured without assuming governance will eliminate them

---

# Phase 8 — Context Portfolio Management

**Objective:** Treat context as a managed portfolio.

The proposed portfolio model treats each context item as an asset with measurable value.

Illustrative values only:

```json
{
  "value": 0.92,
  "cost": 450,
  "recency": 0.88,
  "references": 6
}
```

Governance becomes an optimisation problem:

```text
Maximise reasoning value
Within a fixed token budget
```

## Deliverables

- [ ] Portfolio allocation engine
- [ ] Dynamic budgeting
- [ ] Context categories
- [ ] Budget recommendations

## Success Criteria

- Automatic budget allocation
- Improved reasoning efficiency

---

# Proposed Ecosystem Direction

```text
ecc-curator
        ↓
Context Governance

ecc-memory
        ↓
Knowledge Governance

ecc-router
        ↓
Model Governance

runtime-adapters
        ↓
Host agent runtimes
```

This direction is proposed, not accepted or implemented. Governance remains in ECC Curator, execution remains in each host agent, and runtime adapters are replaceable integration components. See [ADR-012](DECISIONS.md#adr-012-replace-standalone-ecc-harness-with-runtime-adapters).

---

# North Star

For long-running coding work, evaluate whether governed context helps an agent complete the task reliably within a finite context budget. Record task completion, test outcomes, context use, retries, and escalation together. Numeric reduction goals should be set only after reproducible baseline measurements exist.

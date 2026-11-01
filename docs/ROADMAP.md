# Roadmap

> Build context governance for long-running local coding agents.

ECC Curator will evolve incrementally, validating the governance model before introducing advanced optimization and decision intelligence. The primary workload is long-running autonomous coding sessions under finite context and hardware budgets. Token reduction is an efficiency measure, not a success criterion by itself; task completion and quality must be evaluated alongside it.

## Initial integration targets

The first runtime integration targets are **Claude Code, ECC Harness, and Strata**. The initial local coding-model evaluation target is **ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF**. The reference local decision-provider evaluation candidate is **LiquidAI/d1-2B**; **Jev** is a reference provider candidate. These are evaluation targets, not claims of current support or compatibility.

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

- [ ] Project architecture
- [ ] Context item model
- [ ] Governance principles
- [ ] Evaluation methodology
- [ ] Benchmark datasets
- [ ] Token accounting framework

## Success Criteria

- Architecture documented
- Core abstractions stabilised
- Evaluation framework defined

---

# Phase 1 — Rules

**Objective:** Prove that context governance works without AI.

## Deliverables

- [ ] Context inventory
- [ ] Token estimation
- [ ] Budget manager
- [ ] Rule engine
- [ ] Context classifier
- [ ] Prompt assembler

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

- Deterministic governance decisions are reproducible for the same inputs and policy
- Context use and task outcomes can be measured against an ungoverned baseline
- No external dependency is required for the deterministic baseline

---

# Phase 2 — Heuristics

**Objective:** Introduce scoring and prioritisation.

## Deliverables

- [ ] Context scoring
- [ ] Relevance heuristics
- [ ] Recency weighting
- [ ] Reference tracking
- [ ] Context ageing

## Planned Governance Outcomes

```text
KEEP
COMPRESS
DROP
```

## Success Criteria

- Policies are configurable and explainable
- Governance choices can be evaluated against task outcomes and context budgets
- Project-specific governance profiles can be expressed

---

# Phase 3 — Decision Provider Interface

**Objective:** Define a provider-neutral interface for optional decision intelligence.

The Governor remains responsible for policy, validation, final decisions, and execution. Provider output is advisory.

See [Decision Intelligence](DECISION_INTELLIGENCE.md), [Decision Schemas](DECISION_SCHEMAS.md), and [Providers](PROVIDERS.md) for the proposed interface, provider-independent contracts, and current evaluation-candidate status.

## Deliverables

- [ ] Decision kinds and provider-independent schemas
- [ ] Provider capability declaration and registry contract
- [ ] Governor-side result validation and allowed-outcome enforcement
- [ ] Deterministic fallback behavior and provenance

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

# Phase 7 — Agent Integrations

**Objective:** Bring governance directly into agent workflows.

## Initial Integrations

- [ ] Claude Code
- [ ] ECC Harness
- [ ] Strata

## Other Potential Integrations

- [ ] OpenCode
- [ ] Codex
- [ ] Cline
- [ ] Aider

## Success Criteria

- Integrations expose governance within their agent workflows
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

# Long-Term Vision

```text
ECC Curator
        ↓
Context Governance

ECC Memory
        ↓
Knowledge Governance

ECC Router
        ↓
Model Governance

ECC Harness
        ↓
Agent Orchestration
```

ECC Curator becomes the context layer for the broader ECC ecosystem.

---

# North Star

For long-running coding work, evaluate whether governed context helps an agent complete the task reliably within a finite context budget. Record task completion, test outcomes, context use, retries, and escalation together. Numeric reduction goals should be set only after reproducible baseline measurements exist.

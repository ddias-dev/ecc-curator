# Roadmap

> Build context governance for long-running local coding agents.

ECC Curator will evolve incrementally, validating the governance model before introducing advanced optimization and decision intelligence. The primary workload is long-running autonomous coding sessions under finite context and hardware budgets. Token reduction is an efficiency measure, not a success criterion by itself; task completion and quality must be evaluated alongside it.

## Initial integration targets

The first runtime integration targets are **Claude Code, ECC Harness, and Strata**. The initial local-model evaluation target is **Qwen3 Flash Next Coder**, with future local coding models considered as evaluation expands. These are targets, not claims of current support or compatibility.

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

# Phase 1 — Deterministic Governance (MVP)

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

# Phase 2 — Governance Engine

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

# Phase 3 — Compression Adapters

**Objective:** Integrate existing optimisation technologies.

ECC Curator focuses on governance.

Compression remains pluggable.

## Deliverables

- [ ] Compression provider abstraction
- [ ] Evaluate potential RTK adapter
- [ ] Evaluate potential Caveman adapter
- [ ] Evaluate potential LLMLingua adapter
- [ ] Evaluate potential Troglodita adapter

The listed projects are candidates for future provider integrations, not current dependencies or validated compatibility targets.

## Strategy Selection

```text
KEEP

COMPRESS
  ├── RTK
  ├── Caveman
  ├── LLMLingua
  └── Troglodita

DROP
```

## Success Criteria

- Provider abstraction stabilised
- Multiple optimisation backends supported

---

# Phase 4 — Context Transformation

**Objective:** Add semantic transformations.

Not all information should be compressed.

Some information should be transformed.

## Deliverables

- [ ] Log summarisation
- [ ] Test result extraction
- [ ] Failure clustering
- [ ] Decision record generation
- [ ] Plan consolidation

## Supported Decisions

```text
KEEP
COMPRESS
TRANSFORM
DROP
```

## Example

Illustrative transformation examples only:

```text
5000-line test log
           ↓
Top 5 failures

1000-line Docker log
           ↓
Error summary

Large project plan
           ↓
Decision record
```

## Success Criteria

- Higher signal density than compression alone
- Structured outputs available to agents

---

# Phase 5 — Decision Intelligence

**Objective:** Introduce optional intelligent governance.

Governance remains deterministic-first.

Decision intelligence augments the system.

## Candidate Integrations

- Jev
- Custom scorers
- Domain-specific evaluators

## Potential Decisions

- ContextRetentionDecision
- CompressionDecision
- MemoryImportanceDecision
- RetryDecision
- ModelEscalationDecision

## Success Criteria

- Better context selection than heuristic scoring
- Pluggable decision providers

---

# Phase 6 — Agent Integrations

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

# Phase 7 — Context Portfolio Management

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

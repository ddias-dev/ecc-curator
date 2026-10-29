# Roadmap

> Build the governance layer for AI context.

ECC Curator will evolve incrementally, proving the governance model before introducing advanced optimisation and decision intelligence.

The roadmap prioritises measurable reductions in context size while maintaining or improving task success rates.

---

# Guiding Goals

Success is measured by improving:

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

## Supported Decisions

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

- 30-50% token reduction
- No external dependencies
- Reproducible results

---

# Phase 2 — Governance Engine

**Objective:** Introduce scoring and prioritisation.

## Deliverables

- [ ] Context scoring
- [ ] Relevance heuristics
- [ ] Recency weighting
- [ ] Reference tracking
- [ ] Context ageing

## Supported Decisions

```text
KEEP
COMPRESS
DROP
```

## Success Criteria

- 50-70% token reduction
- Configurable policies
- Project-specific governance profiles

---

# Phase 3 — Compression Adapters

**Objective:** Integrate existing optimisation technologies.

ECC Curator focuses on governance.

Compression remains pluggable.

## Deliverables

- [ ] Compression provider abstraction
- [ ] RTK adapter
- [ ] Caveman adapter
- [ ] LLMLingua adapter
- [ ] Troglodita adapter

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

## Integrations

- [ ] Claude Code
- [ ] OpenCode
- [ ] Codex
- [ ] Cline
- [ ] Aider
- [ ] ECC Harness

## Success Criteria

- Works transparently within agent runtimes
- Reduces context growth during long-running sessions

---

# Phase 7 — Context Portfolio Management

**Objective:** Treat context as a managed portfolio.

Each context item becomes an asset with measurable value.

Example:

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

# North Star Metric

For a representative engineering task:

```text
Original Context: 48,000 tokens

Curated Context: 12,000 tokens

Task Success Rate:
Equal or Higher
```

If ECC Curator can consistently achieve that outcome, the project succeeds.

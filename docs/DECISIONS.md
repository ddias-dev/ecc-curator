# Decisions

> Architecture Decision Records (ADRs) for ECC Curator.
>
> This document captures major architectural and product decisions, including rationale, alternatives considered, and consequences.

---

# ADR-001: ECC Curator Is A Governance Engine

**Status:** Accepted

## Context

Most context optimisation projects focus on reducing token counts through compression, filtering, or summarisation.

Examples include:

- RTK
- Caveman
- LLMLingua
- Troglodita

These projects optimise information that has already been selected for inclusion in context.

## Decision

ECC Curator will position itself as a **context governance engine** rather than a compression engine.

Its primary responsibility is deciding what deserves attention within a finite context budget.

## Consequences

### Positive

- Clear differentiation from existing projects
- Compatible with multiple optimisation providers
- Higher-level abstraction
- Focus on attention allocation

### Negative

- Requires more sophisticated decision-making
- Less immediately measurable than simple compression

---

# ADR-002: Governance Before Optimisation

**Status:** Accepted

## Context

Compression is only one of many possible outcomes for a context item.

Not all information should be compressed.

Some information should be removed entirely.

Some information should be transformed.

Some information should remain untouched.

## Decision

Every context item must first go through governance before optimisation.

```text
Information
    ↓
Governance
    ↓
Keep
Compress
Transform
Drop
```

## Consequences

ECC Curator remains independent of any specific optimisation technology.

---

# ADR-003: Compression Providers Must Be Pluggable

**Status:** Accepted

## Context

The context optimisation ecosystem is evolving rapidly.

New techniques appear frequently.

Locking the architecture to a specific optimisation engine would limit future flexibility.

## Decision

Compression and transformation technologies will be implemented as providers.

Examples:

```text
RTK
Caveman
LLMLingua
Troglodita
Future Providers
```

ECC Curator chooses the strategy.

Providers execute the optimisation.

## Consequences

### Positive

- Future-proof architecture
- Easy experimentation
- Ecosystem compatibility

### Negative

- Additional abstraction layer
- More integration testing required

---

# ADR-004: Deterministic First

**Status:** Accepted

## Context

Many context-management systems immediately depend on AI models.

This increases complexity and introduces non-deterministic behaviour.

ECC Curator should be useful before any AI-assisted governance exists.

## Decision

The first implementation will rely exclusively on:

- token budgeting
- rules
- heuristics
- scoring functions

No LLM dependency is required for the MVP.

## Consequences

### Positive

- Reproducible results
- Simpler implementation
- Easier debugging
- Lower cost

### Negative

- Less adaptive than intelligent decision engines

---

# ADR-005: Decision Intelligence Is Optional

**Status:** Accepted

## Context

Projects such as Jev introduce structured decision intelligence.

These capabilities may improve governance quality but should not become mandatory.

## Decision

Decision intelligence providers will remain optional.

Potential examples:

```text
Jev
Custom Scorers
Future Evaluators
```

ECC Curator functions without them.

## Consequences

### Positive

- Works offline
- Works locally
- Supports local-first environments
- Avoids vendor lock-in

---

# ADR-006: Context Is A Portfolio

**Status:** Accepted

## Context

Traditional conversation history treats all context as equal.

In practice, some context is substantially more valuable than other context.

## Decision

ECC Curator models context as a portfolio of assets competing for limited budget.

Example:

```text
Current Goal       High Value
Current Task       High Value
Current File       High Value

Recent Plan        Medium Value

Terminal Output    Low Value
```

Every item has:

```text
Cost
Value
Age
Priority
```

## Consequences

Budget allocation becomes an explicit optimisation problem.

---

# ADR-007: Keep, Compress, Transform, Drop

**Status:** Accepted

## Context

Binary retention decisions are insufficient.

Compression alone cannot represent all governance outcomes.

## Decision

ECC Curator supports four governance outcomes.

```text
KEEP
COMPRESS
TRANSFORM
DROP
```

### KEEP

Retain unchanged.

### COMPRESS

Reduce token footprint while preserving meaning.

### TRANSFORM

Convert into a more useful representation.

Examples:

```text
Log
    ↓
Failure Summary

Test Results
    ↓
Structured Findings

Plan
    ↓
Decision Record
```

### DROP

Remove from the working context.

## Consequences

Provides enough flexibility to support future governance strategies.

---

# ADR-008: Local LLMs Are A First-Class Use Case

**Status:** Accepted

## Context

Most context-window failures occur on local and smaller models.

These environments benefit most from aggressive governance.

## Decision

ECC Curator will optimise for:

- local LLM deployments
- air-gapped environments
- constrained context windows
- autonomous coding agents

## Consequences

Features will prioritise context efficiency over cloud-scale assumptions.

---

# ADR-009: Measure Success By Task Outcomes

**Status:** Accepted

## Context

Token reduction alone is an insufficient metric.

Removing context is easy.

Removing the wrong context is harmful.

## Decision

Success will be evaluated using both:

### Efficiency Metrics

```text
Token Reduction
Compression Ratio
Prompt Size
Latency
```

### Quality Metrics

```text
Task Success Rate
Issue Resolution Rate
Test Pass Rate
Agent Completion Rate
```

## Consequences

Optimisations that reduce tokens but harm outcomes are considered regressions.

---

# ADR-010: Future ECC Ecosystem Alignment

**Status:** Accepted

## Context

ECC Curator is expected to become part of a larger ecosystem.

## Decision

ECC Curator focuses exclusively on:

```text
Context Governance
```

Other responsibilities remain separate.

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

ecc-harness
    ↓
Agent Orchestration
```

## Consequences

Clear boundaries reduce architectural overlap and improve maintainability.

---

# Guiding Principle

> Compression makes context smaller.
>
> Governance makes context better.

ECC Curator exists to maximise reasoning value within finite context budgets.

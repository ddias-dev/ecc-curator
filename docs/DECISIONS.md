# Decisions

> Architecture Decision Records (ADRs) for ECC Curator.
>
> This document captures major architectural and product decisions, including rationale, alternatives considered, and consequences.

These decisions describe the intended design. They do not imply that the proposed runtime capabilities or integrations are implemented.

---

# ADR-001: ECC Curator Is A Governance Engine

**Status:** Accepted

## Context

The projects used as examples in this documentation are described by their focus on optimization techniques such as tool-output optimization, compression, or token reduction:

- RTK
- Caveman
- LLMLingua
- Troglodita

ECC Curator's intended distinction is to make the governance decision about context inclusion and treatment. This is a positioning distinction, not a comparative evaluation of those projects.

## Decision

ECC Curator will position itself as a **context governance engine** rather than a compression engine.

Its primary responsibility is deciding what deserves attention within a finite context budget.

## Consequences

### Positive

- Clear differentiation from existing projects
- Designed to allow multiple optimisation providers
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
- Provider choice is not fixed to one technology

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

# ADR-005: Decision Intelligence Is Optional and Provider-Neutral

**Status:** Accepted

## Context

Decision intelligence may be supplied by interchangeable optional providers.

These capabilities may improve governance quality but should not become mandatory.

## Decision

Decision intelligence providers will remain optional and interchangeable behind a provider-neutral interface.

Potential examples:

```text
LiquidAI/d1-2B (reference local evaluation candidate)
Jev (reference provider candidate)
Local custom providers
Future providers
```

ECC Curator functions without them.

The provider interface, schemas, and examples are proposals, not implemented integrations.

## Consequences

### Positive

- Intended to support offline and local-first environments
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

Long-running coding agents accumulate context across plans, memories, diffs, logs, test output, and tool responses. Local deployments may have fewer practical options for escaping context pressure through larger hosted models, making context governance especially valuable.

## Decision

ECC Curator will prioritize:

- local LLM deployments
- air-gapped environments
- constrained context windows
- autonomous coding agents
- long-running coding sessions on commodity hardware

## Consequences

Features will prioritize context governance and task outcomes for local-first workflows. Local-model and agent compatibility remains a design target until integrations are implemented and evaluated.

---

# ADR-009: Measure Success By Task Outcomes

**Status:** Accepted

## Context

Token reduction alone is an insufficient metric.

Removing context is easy.

Removing the wrong context is harmful.

## Decision

Future evaluations will measure both:

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

# ADR-011: Decision Providers Are Advisory

**Status:** Accepted (implemented for `ContextRetentionDecision` on 2026-11-04; see [Decision Intelligence](DECISION_INTELLIGENCE.md) and `src/types/decision.ts` / `src/governor/provider.ts`)

## Context

Rules and heuristics can resolve many governance cases deterministically. Optional providers may help assess ambiguous classification, scoring, or routing decisions. Providers may be remote, local, unavailable, or produce invalid outputs; they must not become authority over the governance engine.

## Decision

Decision providers return proposals only. The ECC Curator Governor validates provider output, applies policies and budgets, and makes the final governance decision.

```text
Decision Provider
        ↓
     Proposal
        ↓
Governor validates policies, budgets,
schemas, and deterministic safeguards
        ↓
  Final governance decision
```

Provider output must never bypass:

- policies and user-pinned context
- budgets and allowlisted strategies
- schema and outcome validation
- deterministic safeguards, including retry and escalation limits

When a provider is disabled, unavailable, fails, or returns invalid output, the Governor follows the configured deterministic fallback. Compression and transformation execution remains a separate responsibility.

LiquidAI/d1-2B and Jev are provider candidates, not core dependencies. Provider-specific evaluation does not change this boundary.

## Consequences

### Positive

- Governance policy remains owned by ECC Curator
- Deterministic-first and local-first operation does not require decision inference
- Providers can be replaced or compared against common schemas
- Invalid or unavailable providers cannot silently bypass safeguards

### Negative

- The Governor requires explicit validation, fallback, and provenance behavior
- Provider contracts and decision schemas require versioning and contract tests
- Provider proposals need evaluation against deterministic baselines before adoption

---

# Guiding Principle

> Compression makes context smaller.
>
> Governance makes context better.

ECC Curator exists to maximise reasoning value within finite context budgets.

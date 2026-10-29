# ECC Curator

> Curating context for intelligent agents operating under finite attention and context constraints.

ECC Curator is a context governance engine for AI agents.

Instead of continuously expanding context until a model exhausts its token budget, ECC Curator actively manages working memory by retaining high-value information, compressing redundancy, and removing irrelevant context before it reaches the model.

The result is higher signal density, lower token consumption, longer autonomous execution, and improved reasoning efficiency on both local and cloud models.

---

## The Problem

Modern AI agents are remarkably capable but fundamentally constrained by finite context windows.

As agents work, they accumulate:

- conversation history
- plans
- tool outputs
- terminal logs
- test results
- code diffs
- memory entries
- retrieved documents

Over time, context grows faster than understanding.

More context does not necessarily lead to better reasoning.

In practice, excessive context often causes:

- context window exhaustion
- token budget overruns
- degraded reasoning quality
- repeated failures
- unnecessary model escalation
- increased latency and cost

The challenge is no longer generating information.

The challenge is deciding what deserves attention.

---

## The ECC Curation Principle

ECC Curator is based on a simple observation:

> As context grows, information density decreases. Beyond a certain point, additional context contributes more noise than reasoning value.

The role of a curator is therefore to maximise information density within a finite context budget.

For every piece of information, a curator must decide:

```text
KEEP
COMPRESS
DROP
```

This transforms context management from passive accumulation into active governance.

---

## What ECC Curator Does

ECC Curator sits between an agent and a language model.

```text
Agent
  │
  ▼
ECC Curator
  │
  ├── Budget Manager
  ├── Rule Engine
  ├── Context Scorer
  ├── Compression Engine
  └── Memory Manager
  │
  ▼
LLM
```

Before each model invocation, ECC Curator evaluates available context and determines:

- What must be preserved
- What can be compressed
- What should be removed
- How much budget remains
- Which information provides the highest reasoning value per token

---

## Goals

- Prevent context-window exhaustion
- Increase signal density
- Reduce token consumption
- Improve local LLM usability
- Extend autonomous agent runtime
- Enable intelligent memory retention
- Provide deterministic and explainable context governance

---

## Non-Goals

ECC Curator is not:

- a vector database
- a memory store
- a retrieval engine
- a model router
- a workflow orchestrator

Instead, ECC Curator focuses on one responsibility:

> Managing what enters the model's context window.

---

## Example

Raw context:

```text
Goal                         300 tokens
Current Task                 500 tokens
Source File                4,000 tokens
Recent Diff                2,000 tokens
Terminal Output           12,000 tokens
Test Results               8,000 tokens
Historical Plans           6,000 tokens

Total                     32,800 tokens
```

After curation:

```text
Goal                         KEEP
Current Task                 KEEP
Source File                  KEEP
Recent Diff                  KEEP
Terminal Output              COMPRESS
Test Results                 COMPRESS
Historical Plans             DROP

Total                     9,400 tokens
```

Same task.

Less noise.

Higher signal density.

---

## Roadmap

### Phase 1 — Deterministic Governance

- Token budgeting
- Priority rules
- Context classification
- Keep/Compress/Drop pipeline

### Phase 2 — Adaptive Scoring

- Heuristic importance scoring
- Dynamic retention policies
- Memory ageing

### Phase 3 — Decision Intelligence

- Jev integration
- Context retention decisions
- Compression decisions
- Memory importance evaluation

### Phase 4 — Ecosystem Integration

- Claude Code
- OpenCode
- Codex
- Cline
- Aider
- ECC Harness

---

## Vision

Today's agents try to reason over everything they have seen.

Tomorrow's agents will reason over only what matters.

ECC Curator exists to make finite context windows feel effectively larger by increasing information density rather than increasing token limits.

The future of autonomous agents is not more context.

It is better context.

---

## Status

🚧 Early Design Phase

The project is currently focused on defining:

- context item schemas
- budgeting algorithms
- retention policies
- governance architecture
- evaluation methodology

Contributions, ideas, and experiments are welcome.

# Evaluation Framework

> Token reduction is not the goal.
>
> Better reasoning at lower context cost is the goal.

ECC Curator must prove that context governance improves efficiency **without reducing task success**.

This document defines the evaluation strategy, benchmarks, datasets, and success criteria used throughout the project.

---

# Core Hypothesis

ECC Curator is built around a simple hypothesis:

> A smaller, higher-signal context produces equal or better outcomes than a larger, lower-signal context.

Traditional approaches often measure success using token reduction alone.

ECC Curator measures both:

```text
Efficiency
+
Outcome Quality
```

Reducing tokens while harming reasoning is considered a regression.

---

# Evaluation Principles

## Measure Outcomes, Not Optimisations

A 90% reduction in prompt size is meaningless if task success falls.

Success must be evaluated using real agent outcomes.

---

## Reproducibility

Evaluations should be:

- deterministic where possible
- benchmarkable
- repeatable
- versioned

Results should be comparable across releases.

---

## Model Neutrality

ECC Curator should work across:

- local LLMs
- cloud models
- coding agents
- general-purpose agents

Evaluation must avoid overfitting to one vendor or model.

---

# Evaluation Pipeline

```text
Raw Context
      │
      ▼
ECC Curator
      │
      ▼
Curated Context
      │
      ▼
Agent Execution
      │
      ▼
Task Outcome
      │
      ▼
Metrics
```

The objective is to compare:

```text
Baseline
vs
Governed Context
```

under identical tasks.

---

# Evaluation Levels

## Level 1 — Governance Metrics

Measures how ECC Curator changes context.

Questions:

- How much context was removed?
- How much was compressed?
- How much was transformed?
- How much budget was saved?

These metrics do not evaluate reasoning quality.

---

## Level 2 — Agent Metrics

Measures impact on execution.

Questions:

- Did the task complete?
- Did retries increase?
- Did failures increase?
- Was model escalation avoided?

---

## Level 3 — Outcome Metrics

Measures real-world success.

Questions:

- Was the issue fixed?
- Did tests pass?
- Was the refactor completed?
- Did the agent achieve its goal?

Ultimately these metrics matter most.

---

# Efficiency Metrics

## Token Reduction

Percentage decrease between raw and curated context.

```text
(raw_tokens - curated_tokens)
───────────────────────────── × 100
         raw_tokens
```

Example:

```text
48,000 → 12,000

Reduction = 75%
```

---

## Signal Density

Estimate of useful information retained within the final budget.

```text
useful_information
──────────────────
total_tokens
```

Future versions may automate this calculation.

---

## Budget Utilisation

Measures prompt size relative to available window.

Example:

```text
Window: 64,000

Prompt: 18,000

Utilisation: 28%
```

Lower utilisation creates additional headroom.

---

## Compression Ratio

For items processed by compression providers.

```text
original_size
─────────────
final_size
```

Example:

```text
4:1
10:1
25:1
```

---

# Quality Metrics

## Task Success Rate

Percentage of tasks successfully completed.

```text
successful_tasks
────────────────
total_tasks
```

This is one of the primary metrics.

---

## Test Pass Rate

Used for software engineering tasks.

```text
passed_tests
────────────
total_tests
```

---

## Agent Completion Rate

Measures how often an agent finishes the assigned objective.

Example:

```text
Baseline: 72%

ECC Curator: 81%
```

---

## Escalation Avoidance Rate

Measures how often governance avoids unnecessary movement to larger models.

Example:

```text
Local Model
      ↓
No Escalation Required
```

Reducing escalation lowers cost and latency.

---

# Governance Metrics

## Keep Rate

Percentage of items retained unchanged.

```text
KEEP
```

---

## Compression Rate

Percentage of items compressed.

```text
COMPRESS
```

---

## Transformation Rate

Percentage of items transformed.

```text
TRANSFORM
```

---

## Drop Rate

Percentage of items removed entirely.

```text
DROP
```

---

# Benchmark Categories

## Coding Agent Sessions

Representative workloads:

- bug fixing
- feature implementation
- code review
- refactoring
- dependency upgrades

Expected sources:

```text
Diffs
Logs
Tests
Plans
Tool Output
```

---

## Long-Horizon Tasks

Tasks requiring extended context retention.

Examples:

- multi-hour development sessions
- research projects
- architectural migrations

These workloads are particularly susceptible to context explosion.

---

## Local LLM Scenarios

A primary focus area.

Examples:

```text
8K Context
16K Context
32K Context
64K Context
```

The hypothesis is that ECC Curator delivers the greatest benefit in constrained environments.

---

# Benchmark Dataset Structure

```text
benchmarks/

├── coding/
│   ├── issue-fix/
│   ├── feature-work/
│   └── refactor/
│
├── memory/
│   ├── long-session/
│   └── context-growth/
│
├── local-models/
│   ├── 8k/
│   ├── 16k/
│   ├── 32k/
│   └── 64k/
│
└── synthetic/
    ├── logs/
    ├── plans/
    └── tool-output/
```

---

# Baseline Comparisons

ECC Curator should be compared against:

## No Governance

```text
Agent
  ↓
LLM
```

---

## Compression Only

Examples:

- RTK
- Caveman
- LLMLingua
- Troglodita

```text
Agent
  ↓
Compression
  ↓
LLM
```

---

## Governance + Compression

```text
Agent
  ↓
ECC Curator
  ↓
Compression Provider
  ↓
LLM
```

This is the expected long-term architecture.

---

# North Star Benchmark

A representative coding task should achieve:

```text
Raw Context:
48,000 tokens

Curated Context:
12,000 tokens

Reduction:
75%

Task Success Rate:
Equal or Higher
```

This benchmark embodies the project's core thesis.

---

# Success Criteria

ECC Curator succeeds if it consistently demonstrates:

- Significant context reduction
- Higher signal density
- Equal or improved task outcomes
- Reduced context-window failures
- Better performance on constrained local models

The goal is not to maximise compression.

The goal is to maximise reasoning value per token.

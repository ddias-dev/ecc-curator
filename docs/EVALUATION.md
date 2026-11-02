# Evaluation Framework

> Token reduction is not the goal.
>
> Better reasoning at lower context cost is the goal.

ECC Curator is intended to be evaluated on whether context governance improves efficiency **without reducing task success**. No benchmark results, validated savings, or task-quality improvements are reported in this repository.

This document defines the evaluation strategy, benchmarks, datasets, and success criteria used throughout the project.

## Initial Target Profile

The first evaluation profile should reflect long-running local coding sessions rather than isolated prompt compression:

| Dimension | Initial target |
|----------|----------------|
| Agent environments | Claude Code, ECC Harness, Strata |
| Models | ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF; future local coding models |
| Hardware profile | 32 GB RAM, 16 GB VRAM |
| Context windows | 64K and 128K tokens |
| Workload | Long-running autonomous coding sessions |
| Session inputs | Plans, memories, diffs, test output, logs, tool responses, and conversation history |

These are intended test targets, not a claim that integrations are available or that results have been measured. Record the exact model build, quantization, runtime, task, and hardware for every result so comparisons are reproducible.

LiquidAI/d1-2B is the reference local decision-provider evaluation candidate; Jev is a reference provider candidate. Neither has an implemented adapter here. Evaluate each against rules-only and heuristics-only baselines, including bounded provider input sizes and peak resource use alongside the target coding model. See [Decision Intelligence](DECISION_INTELLIGENCE.md).

---

# Core Hypothesis

ECC Curator is built around a hypothesis to test:

> A smaller, higher-signal context produces equal or better outcomes than a larger, lower-signal context.

Token reduction alone can miss whether useful context was lost or task quality changed.

Evaluation should measure both:

```text
Efficiency
+
Outcome Quality
```

Reducing tokens while harming reasoning is considered a regression.

---

# Evaluation Principles

## Measure Outcomes, Not Optimisations

A large prompt reduction is not a success if task completion or quality falls.

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

## Deterministic MVP Harness

The Phase 1 harness runs the fixtures in `src/eval/scenarios.ts` through the deterministic pipeline. `src/eval/metrics.ts` reports token savings, token-reduction rate, item-retention rate, task-success rate, and test-pass rate as numeric values. Task and test outcomes must be supplied from observed evaluations; scenario fixtures do not claim benchmark or quality results.

## Token Reduction

Percentage decrease between raw and curated context.

```text
(raw_tokens - curated_tokens)
───────────────────────────── × 100
         raw_tokens
```

Illustrative example only; this is not a benchmark result:

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

Illustrative example only; this is not a benchmark result:

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

Illustrative example only; this is not a benchmark result:

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

Illustrative example only; this is not a benchmark result:

```text
Baseline: 72%

ECC Curator: 81%
```

---

## Escalation Avoidance Rate

Measures how often governance avoids unnecessary movement to larger models.

Illustrative example only; this is not a benchmark result:

```text
Local Model
      ↓
No Escalation Required
```

Whether escalation is unnecessary, and any associated cost or latency effect, must be established by evaluation.

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

Start with the target profile above, then extend across context sizes as integrations and hardware permit. The key question is whether governance lets an agent complete longer coding tasks without context saturation, quality loss, or avoidable model escalation.

Optional future comparison scenarios may include:

```text
8K Context
16K Context
32K Context
64K Context
128K Context
```

One hypothesis to test is whether governance delivers more benefit in constrained environments.

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

The projects below describe possible comparison categories, not integrations validated by this repository:

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

# North Star Evaluation

Compare governed and ungoverned context on the same long-running coding workloads. Report context use alongside task completion, test outcomes, retries, and escalation behavior. Do not publish a token-saving claim without a reproducible measurement and its paired task-quality result.

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

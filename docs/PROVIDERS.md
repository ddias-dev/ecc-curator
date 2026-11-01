# Decision Providers

ECC Curator is a context-governance engine. Rules and heuristics are the deterministic baseline; optional decision providers can help evaluate ambiguous cases. **Governance, policy, validation, and execution remain inside ECC Curator.**

This document describes provider categories and evaluation status. It does not claim that any provider is integrated or supported by a running implementation.

## Provider flow

```text
Rules → Heuristics → Optional Decision Provider
                              ├── LiquidAI/d1-2B
                              ├── Jev
                              ├── Local custom providers
                              └── Future providers
                                      ↓
                          Proposal for the Governor
                                      ↓
                      ECC Curator validates and decides
```

Provider output is a proposal only. The Governor applies policy, checks budgets and allowed outcomes, and selects deterministic fallback when needed. A decision provider does not compress, transform, drop context, retry work, or switch models by itself.

## Current categories and status

| Category | Intended role | Status |
|---|---|---|
| Rules | Explicit deterministic policies, pins, limits, fixed mappings, and safety guards | Proposed baseline; no runtime implementation in this repository |
| Heuristics | Transparent scores and rankings using task relevance, recency, references, and token cost | Proposed baseline; no runtime implementation in this repository |
| LiquidAI d1 | Optional decision-model provider for typed classification/scoring/routing proposals | d1-2B is the reference local evaluation candidate; no adapter or evaluation result is present |
| Jev | Optional decision provider implementing the same provider-independent contract | Reference provider candidate; no adapter or evaluation result is present |
| Custom providers | Local or domain-specific implementation of the common interface | Extension direction; no provider runtime is present |

## LiquidAI/d1-2B

**LiquidAI/d1-2B is currently the reference local evaluation candidate** because Liquid AI describes it as a decision model with typed outputs that align with ECC Curator's classification, scoring, and routing workload. This is a candidate selection for evaluation—not an endorsement, implementation claim, or proven fit for the target hardware.

The model-card specifications and caveats, including the reported context length and reduced reliability beyond about 64K tokens of state, are summarized in [Decision Intelligence](DECISION_INTELLIGENCE.md). ECC Curator has not verified memory/VRAM use, latency, accuracy on coding-session governance, or coexistence with the target coding model. Provider requests should be bounded and task-scoped.

`d1-ultra` is not a reference candidate until its model details, access conditions, licensing, runtime, and resource requirements are verifiable. No performance is inferred from its name.

## Jev

Jev remains a **reference provider candidate**. It is not the architectural centrepiece, required dependency, or assumed default. Jev-specific integration details belong in [Jev Provider Compatibility](JEV_INTEGRATION.md); those details are proposals until implemented and evaluated.

## Local custom and future providers

Custom providers may wrap local decision models or rule/heuristic systems where a separate adapter boundary is useful. Every provider must follow the same decision kinds and schemas in [Decision Schemas](DECISION_SCHEMAS.md), declare its capabilities, and pass the same contract tests and task evaluations. Provider choice must not change governance policy or schema semantics.

## Evaluation before adoption

Compare providers against rules-only and heuristics-only baselines on the same long-running coding workloads. Evaluate decision accuracy, false drops, task completion, tests, retries, escalations, latency, peak RAM/VRAM, and behavior on bounded provider state sizes. Record model and provider versions and the exact configuration.

No provider should be treated as integrated, supported, or recommended for production until its adapter exists, its contract tests pass, and reproducible evaluation evidence is published.

# ECC Curator Positioning

## Problem statement

Long-running coding agents accumulate plans, logs, tool output, test results, diffs, memories, and conversation history. In sessions that run against finite context windows and hardware resources, passing this material forward indiscriminately can crowd out the information needed for the next task step. The result can be context saturation, token exhaustion, degraded reasoning, unnecessary model escalation, or weaker autonomous workflows.

This is a product problem to evaluate, not a measured result established by this repository. ECC Curator is currently documented as a design; compatibility and productivity claims require implementation and reproducible evaluation.

## Target users

ECC Curator is for people running long-running, autonomous coding sessions, especially:

- Developers using local coding models on commodity hardware
- Users of coding-agent runtimes such as Claude Code, ECC Harness, and Strata
- Teams that need context use to remain explicit, predictable, and governed
- Contributors building runtime integrations or context-optimization providers

The named runtimes, models, and hardware are initial targets, not verified support.

## Positioning

**Context governance for long-running local coding agents.**

ECC Curator is a proposed governance layer that treats session context as a finite, task-oriented working set. Before context is assembled for the next model call, the governor decides which items to keep, compress, transform, or drop. The host agent remains responsible for task execution.

## Differentiation

Compression is a strategy. Governance is the decision.

Compression tools can optimize selected text, but compression alone does not determine whether an item remains relevant, should be preserved unchanged, should be represented differently, or should be removed. ECC Curator's intended role is to make that lifecycle and budget decision, then optionally route a selected action to a provider.

| Project | Focus described in this repository | ECC Curator distinction |
|---|---|---|
| RTK | Tool-output optimization | Governs whether accumulated context should be retained and which action to take |
| Caveman | Natural-language compression | Treats compression as one possible governance outcome |
| LLMLingua | Prompt compression | Includes selection, retention, transformation, and removal in addition to compression |
| Troglodita | Token reduction | Allocates a finite context budget across competing items |

These are concise descriptions of the projects' stated focus, not a comparative evaluation of their capabilities. They are potential complementary providers; no adapter compatibility or integration is established by this documentation.

The governance flow is:

```text
Context item
     ↓
Governance decision
     ├── Keep
     ├── Compress
     ├── Transform
     └── Drop
```

## Mission

> Keep long-running coding agents productive within finite context budgets by governing what they retain, transform, compress, or discard. Local-first deployment on commodity hardware is the primary design target.

## Product narrative

As a coding session progresses, its useful working set changes. The current goal and active task may remain essential, while old plans, repeated tool output, completed test logs, and stale diffs may no longer deserve space. ECC Curator is designed to make these trade-offs explicit rather than forwarding an ever-growing history or treating every problem as a compression task.

The first design target is a local coding workflow with a 32 GB RAM, 16 GB VRAM reference profile, 64K–128K context windows, and models such as Qwen3 Flash Next Coder. Claude Code, ECC Harness, and Strata are initial runtime integration targets. These choices guide implementation and evaluation; they are not current compatibility claims.

ECC Curator is deterministic-first and governance-led. Rules, budgets, and heuristics form the proposed baseline. Compression and transformation providers can carry out selected strategies, while optional decision intelligence may help with ambiguous choices. The long-term product question is whether governed context helps an agent complete longer coding work reliably within a finite budget. Token reduction is a supporting measure, never the sole definition of success.

# ECC Curator

> **Context governance for long-running local coding agents.**

Long-running coding sessions accumulate plans, logs, tool output, test results, diffs, memories, and conversation history. Carrying all of it forward can fill a finite context window, bury useful evidence, and put pressure on constrained hardware. A 64K or 128K window is still a budget—not an instruction to retain everything.

ECC Curator is a design-stage governance layer for deciding what context should reach the next model call. It treats session context as a budgeted working set and selects an action for each item:

```text
Governance
    ↓
Keep
Compress
Transform
Drop
```

**Compression is a strategy. Governance is the decision.** A shorter version of irrelevant material is still irrelevant; important information may need to be kept unchanged or transformed into a more useful form. ECC Curator is intended to govern accumulated context before it is assembled for the next step, with task outcomes—not token reduction alone—as the measure of success.

## Who and what this is for

The primary use case is long-running, autonomous coding work on local models and commodity hardware. Initial integration targets are **Claude Code, ECC Harness, and Strata**. The initial evaluation profile targets **Qwen3 Flash Next Coder**, future local coding models, **32 GB RAM, 16 GB VRAM**, and **64K or 128K context windows**.

These are design and evaluation targets, not claims of current compatibility, benchmarked performance, or validated savings. The repository currently describes the proposed architecture and evaluation approach; integrations and productivity results are not yet established.

## Why compression alone is not enough

Compression can reduce the size of selected information, but it does not by itself decide whether that information belongs in the working context. Long sessions need lifecycle decisions: retain an active goal, preserve a useful test finding, transform verbose output, compress relevant detail, or drop stale noise. A compression provider may execute a chosen strategy; it does not replace the governance decision.

| Project | Focus described here | ECC Curator's distinct role |
|---|---|---|
| [RTK](https://github.com/rtk-ai/rtk) | Tool-output optimization | Govern whether accumulated context is retained and what action should be taken |
| [Caveman](https://github.com/JuliusBrussee/caveman) | Natural-language compression | Treat compression as one possible governance outcome |
| [LLMLingua](https://github.com/microsoft/LLMLingua) | Prompt compression | Govern selection, retention, transformation, and removal as well as compression |
| [Troglodita](https://github.com/leninejunior/troglodita) | Token reduction | Allocate a finite context budget across competing items |

These are high-level descriptions based on the projects' stated roles, not a comparative product evaluation. The projects are potential complementary providers; adapters and integrations are planned, not implemented in this repository.

## Intended workflow

```text
Accumulated session context
    ↓
Inventory and budget
    ↓
Governance decision
    ├── Keep
    ├── Compress
    ├── Transform
    └── Drop
    ↓
Context assembled for the next model call
```

The design is deterministic-first, model- and runtime-agnostic, and local-first. It preserves the host agent's responsibility for coding and execution; ECC Curator's proposed responsibility is governing the context supplied to that work.

## Project status

This repository is in the early design phase. The architecture, context model, proposed extension interfaces, configuration examples, and evaluation approach are documented, but do not imply that the corresponding runtime capabilities or integrations are already available.

## Documentation

- [Positioning](docs/POSITIONING.md) — Problem, target users, differentiation, and mission
- [Target Environment](docs/TARGET_ENVIRONMENT.md) — Intended users, hardware, integrations, workflows, and constraints
- [Architecture](docs/ARCHITECTURE.md) — Governance architecture and components
- [Context Model](docs/CONTEXT_MODEL.md) — Context items, metadata, and outcomes
- [Decision Records](docs/DECISIONS.md) — Accepted design decisions
- [Configuration](docs/CONFIGURATION.md) — Proposed configuration model
- [Plugin API](docs/PLUGIN_API.md) — Proposed plugin interfaces and extension model
- [Jev Integration](docs/JEV_INTEGRATION.md) — Optional decision-intelligence design
- [Evaluation Framework](docs/EVALUATION.md) — Initial targets and evaluation methodology
- [Roadmap](docs/ROADMAP.md) — Development phases and initial integration targets

### Suggested reading order

1. [Positioning](docs/POSITIONING.md)
2. [Target Environment](docs/TARGET_ENVIRONMENT.md)
3. [Architecture](docs/ARCHITECTURE.md)
4. [Context Model](docs/CONTEXT_MODEL.md)
5. [Evaluation Framework](docs/EVALUATION.md)
6. [Roadmap](docs/ROADMAP.md)

<!-- ECC Curator README: design-stage overview; see docs/ for details. -->

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

The primary use case is long-running, autonomous coding work on local models and commodity hardware. Runtime integration is intended to use optional, replaceable adapters, with **Claude Code Agent** as the first-class design target and existing integration. **Agents Window, Strata, OpenCode, Codex, Cline, and Aider** are among the runtimes under consideration. The initial evaluation profile targets **ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF**, future local coding models, **32 GB RAM, 16 GB VRAM**, and **64K or 128K context windows**.

These are design and evaluation targets, not claims of current compatibility, benchmarked performance, or validated savings. The runtime adapter direction is proposed in [ADR-012](docs/DECISIONS.md#adr-012-replace-standalone-ecc-harness-with-runtime-adapters); adapter support is not yet established. The repository currently describes the architecture and evaluation approach; productivity results are not yet established.

ECC Curator owns governance. Optional decision providers can propose answers for ambiguous decisions, but policy, validation, and final decisions stay in the Governor:

```text
ECC Curator
    ↓
Governance

Decision Providers
    ↓
Optional proposals
```

**LiquidAI/d1-2B** is the reference local decision-provider evaluation candidate; **Jev** is a reference provider candidate. Neither is integrated or required. See [Decision Intelligence](docs/DECISION_INTELLIGENCE.md), [Decision Schemas](docs/DECISION_SCHEMAS.md), and [Providers](docs/PROVIDERS.md).

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

The design is deterministic-first, model- and runtime-agnostic, and local-first. It preserves the host agent's responsibility for coding and execution; ECC Curator's proposed responsibility is governing the context supplied to that work. Runtime-specific integration belongs in optional adapters, not in the governance core.

## Project status

This repository includes a deterministic TypeScript MVP, experimental Claude Code `UserPromptSubmit` and `PreCompact` hooks, opt-in metadata-only logging, and a callback-based evaluation harness for local measurement. The prompt hook appends explicitly selected governed context without changing Claude Code's model routing. The integration is not a general runtime adapter framework or a production-ready integration, and makes no performance or quality claims.

## Documentation

- [Positioning](docs/POSITIONING.md) — Problem, target users, differentiation, and mission
- [Target Environment](docs/TARGET_ENVIRONMENT.md) — Intended users, hardware, integrations, workflows, and constraints
- [Architecture](docs/ARCHITECTURE.md) — Governance architecture and components
- [Context Model](docs/CONTEXT_MODEL.md) — Context items, metadata, and outcomes
- [Decision Records](docs/DECISIONS.md) — Accepted design decisions
- [Configuration](docs/CONFIGURATION.md) — Proposed configuration model
- [Decision Intelligence](docs/DECISION_INTELLIGENCE.md) — Provider-neutral optional decision architecture
- [Decision Schemas](docs/DECISION_SCHEMAS.md) — Provider-independent governance decision contracts
- [Providers](docs/PROVIDERS.md) — Provider categories, candidates, and status
- [Governor Algorithm](docs/GOVERNOR_ALGORITHM.md) — Deterministic governance order, budget pressure, and provider fallback
- [Scoring Spec](docs/SCORING_SPEC.md) — Normalized heuristic scoring formula and examples
- [Inventory API](docs/INVENTORY_API.md) — Proposed context inventory interfaces and lifecycle
- [Prompt Assembler](docs/PROMPT_ASSEMBLER.md) — Deterministic prompt ordering and budget contract
- [Agent Execution Rules](docs/integrations/AGENT_EXECUTION_RULES.md) — Operational guidance for long-running coding agents and future ECC integrations
- [Plugin API](docs/PLUGIN_API.md) — Proposed plugin interfaces and extension model
- [Evaluation Framework](docs/EVALUATION.md) — Initial targets and evaluation methodology
- [Experimental Integration](docs/EXPERIMENTAL_INTEGRATION.md) — Optional adapter, context bounds, and baseline-versus-governed evaluation
- [Roadmap](docs/ROADMAP.md) — Development phases and initial integration targets

### Suggested reading order

1. [Positioning](docs/POSITIONING.md)
2. [Target Environment](docs/TARGET_ENVIRONMENT.md)
3. [Architecture](docs/ARCHITECTURE.md)
4. [Context Model](docs/CONTEXT_MODEL.md)
5. [Governor Algorithm](docs/GOVERNOR_ALGORITHM.md)
6. [Scoring Spec](docs/SCORING_SPEC.md)
7. [Inventory API](docs/INVENTORY_API.md)
8. [Prompt Assembler](docs/PROMPT_ASSEMBLER.md)
9. [Decision Intelligence](docs/DECISION_INTELLIGENCE.md)
10. [Decision Schemas](docs/DECISION_SCHEMAS.md)
11. [Evaluation Framework](docs/EVALUATION.md)
12. [Roadmap](docs/ROADMAP.md)
13. [Agent Execution Rules](docs/integrations/AGENT_EXECUTION_RULES.md)

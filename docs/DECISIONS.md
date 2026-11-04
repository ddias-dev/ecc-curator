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

# ADR-012: Replace Standalone ECC Harness with Runtime Adapters

**Status:** Proposed

This proposal would supersede the ECC Harness portion of [ADR-010](#adr-010-future-ecc-ecosystem-alignment) if accepted. It does not change the boundaries assigned to ECC Curator, ECC Memory, or ECC Router.

## Context

ECC Curator's core value is context governance:

- Context inventory and budget management
- Context scoring and the Governor
- Prompt assembly
- The `KEEP`, `COMPRESS`, `TRANSFORM`, and `DROP` lifecycle
- The optional, advisory Decision Provider framework

Curator is intended to sit between an agent runtime and model invocation. The host agent owns task execution; Curator governs the context selected for the next invocation. Runtime-specific integration is a delivery mechanism for that governance, not a reason to move orchestration into Curator.

ECC Harness is currently understood to be largely glue around Claude Code. That may be useful today, but its independent value is uncertain if it is coupled to one runtime. If the project adopts Agents Window, the runtime's own execution and orchestration capabilities may make a separate Harness unnecessary. Claude Code Agent is already the first-class integration; Agents Window, Strata, OpenCode, Codex, Cline, and Aider are additional runtimes under consideration. Their integration mechanisms and capabilities differ, and none should be assumed compatible until tested.

## Problem Statement

A standalone, first-class ECC Harness risks making an agent runtime or orchestration product the center of an ecosystem whose distinct value is governance. Runtime-specific glue can become a hard dependency, duplicate host-agent responsibilities, and tie Curator's roadmap to the lifecycle and API choices of a particular runtime. A migration from Claude Code to Agents Window could strand Harness features that do not have value outside that integration.

At the same time, removing Harness without a stable integration boundary could discard useful workflows and leave each runtime integration to invent its own governance semantics. The decision must separate execution from governance without presuming that every runtime offers equivalent extension points.

## Decision

Adopt a runtime adapter strategy in place of treating ECC Harness as a standalone first-class orchestration product.

1. **Governance remains in ECC Curator.** Inventory, budgets, scoring, policy, governance decisions, lifecycle actions, prompt assembly, and decision-provider validation remain Curator responsibilities.
2. **Execution remains in the host agent.** The host agent continues to own planning, tool use, task execution, model invocation, and runtime-specific session management.
3. **Runtime integrations are adapters.** An adapter translates a host runtime's available context and lifecycle events into Curator's versioned, runtime-neutral contract, then returns governed context or applies the supported governance actions through that runtime's extension points.
4. **Adapters are replaceable and optional.** A runtime adapter may depend on its target runtime's APIs, but neither Curator's core nor another adapter may require it. Adapter failures or absence must not imply that Curator itself requires a different runtime; deterministic core behavior remains usable independently.
5. **Keep the core contract capability-based.** Do not assume that every runtime supports hooks, mutable prompts, pre-compaction events, or equivalent capabilities. Adapters must declare supported integration points and limitations rather than pretending to provide parity.
6. **Keep Claude Code Agent first-class.** Treat the existing Claude Code integration as the primary runtime design and validation target while isolating its runtime-specific mechanics behind the adapter boundary. Preserve and characterize its implemented capabilities; do not imply that the current hooks govern the full conversation or autonomous tool turns. Agents Window and other runtimes remain candidates for adapter evaluation, not first-class targets by default.
7. **Deprecate Harness in stages, not by immediate deletion.** Preserve any demonstrated Harness-only capabilities during migration. Retain or reconsider a standalone orchestration product only if it provides independently valuable, runtime-neutral functionality that cannot appropriately live in an adapter or host agent.

The intended request path is:

```text
Agent Runtime
    ↓ context / lifecycle event
Runtime Adapter
    ↓ runtime-neutral governance request
ECC Curator
    ↓ governed context / lifecycle decisions
Runtime Adapter
    ↓ supported context update
Agent Runtime
    ↓
Model invocation (owned by the host agent)
```

The adapter does not take over execution, and Curator does not become the model caller. The shorthand “Agent Runtime → Runtime Adapter → ECC Curator → Model” describes the governance position in the flow, not a transfer of model invocation ownership.

## Alternatives Considered

### Keep ECC Harness as a standalone orchestration product

**Reasons to keep it:**

- A Harness may offer a consistent execution surface, lifecycle controls, telemetry, and repeatable evaluation across otherwise fragmented runtimes.
- It could be valuable to users who want a managed or opinionated agent workflow rather than the host runtime's native behavior.
- If it has substantial runtime-neutral features, replacing it with thin adapters could lose capabilities or force each integration to reimplement them.
- An independently maintained Harness could insulate users from incompatible runtime APIs and provide a stable product surface.

**Reasons not to make it the default direction:**

- The current implementation is described as largely Claude Code glue, so independent orchestration value has not yet been established.
- Owning execution broadens scope and risks duplicating host-agent responsibilities that vary by runtime.
- A Harness can become an implicit runtime dependency and make migration to another host costly.
- It could blur the ecosystem boundary between context governance and agent orchestration.

**Assessment:** Keep this option open if evidence establishes independent value, but do not assume that integration glue alone justifies a first-class orchestration product.

### Keep a Claude Code-specific Harness and add adapters alongside it

This preserves existing workflows in the short term, but creates two competing integration models and risks permanent special treatment for one runtime. It is acceptable as a migration bridge, not as the target architecture, unless Claude Code's orchestration features prove uniquely valuable to users.

### Put all runtime integrations inside ECC Curator

This is initially convenient and may simplify a small prototype. Over time, runtime SDKs, release cycles, permissions, and compatibility tests would couple the governance core to optional platforms. It also makes it harder to install or upgrade one adapter independently. A shared, separately versioned adapter distribution is preferred; a monorepo remains an implementation option if repository maintenance later justifies it.

### Require one common agent runtime API

A common API could simplify integrations, but requiring every host to implement it would contradict portability and exclude runtimes with different extension models. Keep the Curator-facing contract common and let each adapter declare which parts of it the host can satisfy.

## Consequences

### Positive

- Protects Curator's focus on context governance and keeps orchestration with the host.
- Reduces the risk that Curator's core is coupled to Claude Code, Agents Window, or another runtime.
- Allows adapters to be replaced, upgraded, or removed on their own lifecycle.
- Makes cross-runtime portability an explicit architectural constraint rather than an aspiration.
- Provides a clear place to isolate runtime-specific code, dependencies, and compatibility limitations.
- Establishes a clear path to preserve the existing Claude Code integration while separating it from governance internals.

### Negative and risks

- Different runtimes expose different hooks and context surfaces; adapters may not offer equal governance coverage.
- A shared contract and adapter capability model add design, versioning, and compatibility-test costs.
- Distributing and supporting several adapters can require more maintenance than a single opinionated Harness.
- Host-agent execution may not permit Curator to inspect or alter all relevant context, limiting the benefit of governance in some integrations.
- Users may lose Harness workflows if they are removed before an equivalent host-native or adapter-based path exists.
- A separate adapter project can fragment releases or leave adapters stale unless ownership and support expectations are explicit.

These are real trade-offs. The adapter strategy is not a promise of universal runtime parity, nor does it establish that existing Harness behavior is already covered elsewhere.

## Migration Plan

1. **Inventory before removal.** Identify Harness features, runtime assumptions, users, configuration, and any behavior not already provided by ECC Curator or the host runtime. Record which capabilities are orchestration and which are governance integration.
2. **Define and version the boundary.** Specify the runtime-neutral request/response contract, lifecycle semantics, capability declaration, error behavior, and compatibility policy. Keep runtime SDKs and adapter implementations out of Curator core.
3. **Test the boundary independently.** Add contract tests using a fake runtime and verify that adapters cannot bypass Curator policies, budgets, validation, or deterministic fallback. Treat the host's model invocation as outside adapter ownership.
4. **Formalize the existing Claude Code integration.** Keep its current behavior working while documenting its capabilities and limitations, then place its runtime-specific mechanics behind the adapter boundary. Do not imply that the current hooks govern the full conversation or autonomous tool turns.
5. **Validate additional runtimes according to evidence.** Evaluate Agents Window, Strata, OpenCode, Codex, Cline, and Aider individually; prioritize based on user need and available APIs rather than promising parity across the list.
6. **Deprecate Harness compatibility deliberately.** Once equivalent governance paths are documented and validated for affected users, announce the deprecation, provide a migration path, and maintain a stated compatibility window. Remove Harness-only packaging or orchestration code only after its unique capabilities have been migrated, explicitly retained as a separate product, or accepted as a loss.
7. **Reassess with usage evidence.** Compare adapter maintenance, coverage, task outcomes, and user demand with the cost and value of retaining Harness. Revisit this ADR if a runtime-neutral orchestration product demonstrates independent value.

## Updated Ecosystem Architecture

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

runtime-adapters
    ├── agents-window
    ├── claude-code
    ├── strata
    ├── opencode
    ├── codex
    ├── cline
    └── aider
```

For a governed model step, the host agent supplies the adapter's available context; the adapter requests governance from ECC Curator; and the host agent invokes its selected model with the resulting context. ECC Memory and ECC Router remain separate governance domains, not implicit dependencies of Curator or of every adapter. Any future composition among these products should use explicit contracts.

## Recommended Repository Structure

Keep the governance core and its public runtime-neutral contract in the ECC Curator repository. Distribute runtime-specific adapters separately so each can own only its target runtime dependencies, release cadence, and integration tests. A possible ecosystem layout is:

```text
ecc-curator/
    src/
        inventory/
        budget/
        scoring/
        governor/
        assembler/
        providers/
        runtime/
            contract.ts
            capabilities.ts
    tests/
        core/
        runtime-contract/
    docs/
        integrations/
        DECISIONS.md

runtime-adapters/
    claude-code/
        src/
        tests/
        README.md
    agents-window/
        src/
        tests/
        README.md
    strata/
    opencode/
    codex/
    cline/
    aider/
    shared/
        contract-tests/
```

This is a target boundary, not a requirement to reorganize the current source tree immediately. The exact packaging (separate repositories versus a separately versioned workspace) should follow the project's release and maintenance capacity. In either form, Curator core must not import runtime SDKs, adapter-specific configuration, or orchestration code. Each adapter should declare its supported runtime versions and capabilities, depend only on the stable Curator contract, and run shared contract tests plus target-specific integration tests.

## Recommendation

Adopt the runtime adapter framework as the target and phase out ECC Harness as a first-class orchestration product, while retaining it temporarily as a compatibility bridge where needed. This is the best fit for Curator's distinct governance value and for portability across a changing agent ecosystem. Do not delete Harness or claim equivalent adapter coverage until feature inventory, user migration, and runtime-specific validation show that no unique, relied-upon capability is being silently lost. Reconsider keeping a standalone Harness if evidence demonstrates valuable runtime-neutral orchestration that adapters and host runtimes cannot appropriately provide.

---

# Guiding Principle

> Compression makes context smaller.
>
> Governance makes context better.

ECC Curator exists to maximise reasoning value within finite context budgets.

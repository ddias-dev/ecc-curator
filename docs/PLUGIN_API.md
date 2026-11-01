# Plugin API

> ECC Curator is designed to support extensions to its governance model.
>
> The proposed plugin design separates core governance from scoring engines, compression systems, transformation providers, and decision intelligence.

This document sketches a proposed plugin architecture. The interfaces and examples are not a statement that a plugin runtime or listed provider is currently implemented.

---

# Design Goals

The plugin system must be:

- Modular
- Deterministic
- Language-model agnostic
- Runtime configurable
- Designed for backward compatibility
- Easy to test

A plugin should be able to add capabilities without modifying the ECC Curator core.

---

# Plugin Categories

The proposed plugin categories are:

```text
Context Sources
Scoring Providers
Compression Providers
Transformation Providers
Decision Providers
Budget Providers
```

---

# Architecture

```mermaid
flowchart TB

    Inventory["Context Inventory"]

    Sources["Context Sources"]

    Scoring["Scoring Providers"]

    Decisions["Decision Providers"]

    Compression["Compression Providers"]

    Transform["Transformation Providers"]

    Budget["Budget Providers"]

    Governor["ECC Governor"]

    Final["Curated Context"]

    Sources --> Inventory

    Inventory --> Scoring
    Inventory --> Decisions
    Inventory --> Budget

    Scoring --> Governor
    Decisions --> Governor
    Budget --> Governor

    Governor --> Compression
    Governor --> Transform

    Compression --> Final
    Transform --> Final
```

---

# Plugin Lifecycle

In this proposed design, plugins follow this lifecycle.

```text
Load
Initialize
Execute
Dispose
```

Example:

```typescript
await plugin.initialize();

const result = await plugin.execute(input);

await plugin.dispose();
```

---

# Base Plugin Interface

```typescript
export interface Plugin {
  name: string;

  version: string;

  initialize(): Promise<void>;

  dispose(): Promise<void>;
}
```

All plugin types extend this interface.

---

# Context Source Plugins

Context sources provide information to the inventory.

Examples:

- Agent messages
- Files
- Git diffs
- Logs
- MCP sources
- External memory systems

## Interface

```typescript
export interface ContextSource
  extends Plugin {

  collect(): Promise<ContextItem[]>;
}
```

---

# Scoring Provider Plugins

Scoring providers assign value scores.

Example:

```text
Goal          1.00

Current Task  0.95

Build Log     0.10
```

## Interface

```typescript
export interface ScoringProvider
  extends Plugin {

  score(
    item: ContextItem
  ): Promise<number>;
}
```

Returns:

```text
0.0 -> 1.0
```

---

# Budget Provider Plugins

Budget providers determine available prompt budget.

Example:

```yaml
context_window: 64000

reserve_output: 8000
```

## Interface

```typescript
export interface BudgetProvider
  extends Plugin {

  getBudget(
    inventory: ContextInventory
  ): Promise<TokenBudget>;
}
```

---

# Compression Provider Plugins

Compression providers reduce token footprint.

ECC Curator chooses when compression occurs.

Providers implement how.

Examples:

- RTK
- Caveman
- LLMLingua
- Troglodita

## Interface

```typescript
export interface CompressionProvider
  extends Plugin {

  compress(
    item: ContextItem
  ): Promise<ContextItem>;
}
```

## Illustrative example only; not a measured result

```text
Original
────────
5000 Tokens

Compressed
──────────
300 Tokens
```

---

# Transformation Provider Plugins

Transformation providers create higher-value representations.

Unlike compression, transformation may change structure.

## Example

```text
Raw Log
    ↓
Failure Summary
```

```text
Test Output
    ↓
Structured Findings
```

## Interface

```typescript
export interface TransformationProvider
  extends Plugin {

  transform(
    item: ContextItem
  ): Promise<ContextItem>;
}
```

---

# Decision Provider Plugins

Decision providers help evaluate governance decisions.

The intended deterministic baseline uses:

```text
Rules
+
Heuristics
```

Future implementations may use:

```text
Jev
Local Models
Custom Evaluators
```

## Interface

```typescript
export interface DecisionProvider
  extends Plugin {

  evaluate(
    request: DecisionRequest
  ): Promise<DecisionResult>;
}
```

---

# Governance Decisions

Decision providers may evaluate:

```text
KEEP
COMPRESS
TRANSFORM
DROP
```

Example:

```typescript
interface DecisionResult {
  outcome:
    | "KEEP"
    | "COMPRESS"
    | "TRANSFORM"
    | "DROP";

  confidence: number;

  reason?: string;
}
```

---

# Proposed Provider Registry

The proposed design registers plugins within a central registry.

```typescript
registry.register(
  plugin
);
```

Example:

```typescript
registry.register(
  new LLMLinguaProvider()
);

registry.register(
  new JevProvider()
);
```

---

# Configuration

Plugins are enabled through configuration.

Example:

```yaml
plugins:

  scoring:
    - heuristic

  compression:
    - llmlingua
    - caveman

  transformations:
    - summariser

  decisions:
    - jev
```

---

# Strategy Resolution

The intended strategy-resolution flow selects a provider based on the governance decision.

Example:

```text
Context Item
      ↓

Decision

      ↓

COMPRESS

      ↓

LLMLingua
```

or

```text
Context Item
      ↓

Decision

      ↓

TRANSFORM

      ↓

Failure Summary Plugin
```

Governance remains separate from execution.

---

# Example Plugin

A minimal scoring provider:

```typescript
export class StaticScorer
  implements ScoringProvider {

  name = "static";

  version = "1.0.0";

  async initialize() {}

  async dispose() {}

  async score(
    item: ContextItem
  ): Promise<number> {

    if (item.type === "goal") {
      return 1.0;
    }

    if (
      item.type === "terminal_output"
    ) {
      return 0.2;
    }

    return 0.5;
  }
}
```

---

# Future Extensions

Possible future plugin categories:

```text
Memory Providers
Retrieval Providers
Telemetry Providers
Evaluation Providers
Agent Providers
```

The architecture should support new plugin types without requiring changes to the governance engine.

---

# Guiding Principle

> ECC Curator decides **what should happen**.
>
> Plugins decide **how it happens**.

This separation allows governance policies to remain stable while optimisation technologies continue evolving.

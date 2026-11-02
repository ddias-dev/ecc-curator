# Configuration

> The proposed ECC Curator configuration uses a declarative configuration file.
>
> The examples describe a design for budgets, governance policies, plugin providers, and optimization strategies; they are not evidence of a working configuration loader.
>
> The separate [experimental integration](EXPERIMENTAL_INTEGRATION.md) implements only its local `ecc_curator.enabled` toggle and deterministic adapter settings. It does not implement this document's general-purpose YAML loader or provider configuration.

This document describes the proposed configuration model.

The proposed scoring, governance, inventory, and assembly semantics are specified in [Scoring Spec](SCORING_SPEC.md), [Governor Algorithm](GOVERNOR_ALGORITHM.md), [Inventory API](INVENTORY_API.md), and [Prompt Assembler](PROMPT_ASSEMBLER.md).

---

# Configuration Philosophy

The configuration design follows three principles:

## Explicit Over Implicit

Context governance should be visible and predictable.

```yaml
terminal_output:
  action: drop
```

is preferred over hidden behaviour.

---

## Deterministic By Default

The default configuration should not require:

- LLMs
- Any decision provider
- Cloud services
- External APIs

All intelligent capabilities are optional.

---

## Progressive Complexity

A minimal configuration should be usable without requiring optional providers.

Advanced users should be able to enable:

- custom scoring
- compression providers
- optional decision providers
- custom plugins
- organisation-wide policies

---

# Configuration File

The proposed configuration filename is:

```text
ecc-curator.yaml
```

Repository-level configuration:

```text
project/
├── ecc-curator.yaml
└── ...
```

Global configuration:

```text
~/.ecc-curator/config.yaml
```

The proposed precedence is for repository settings to override global settings.

---

# Minimal Configuration

```yaml
version: 1

budget:
  context_window: 64000
  output_reserve: 8000
```

---

# Full Configuration Example

```yaml
version: 1

budget:
  context_window: 64000
  output_reserve: 8000

scoring:
  provider: heuristic

governance:
  default_action: compress

plugins:
  compression:
    - llmlingua
    - rtk

decision_intelligence:
  context_retention:
    provider: d1-2b

  memory_importance:
    provider: jev

  compression_strategy:
    provider: heuristic

policies:
  terminal_output:
    action: compress

  completed_task:
    action: drop
    ttl_turns: 5

  goal:
    action: keep
```

---

# Budget Configuration

The budget section controls prompt allocation.

Example:

```yaml
budget:
  context_window: 64000
  output_reserve: 8000
```

Result:

```text
Available Context Budget

64000 - 8000

= 56000 Tokens
```

---

## Budget Fields

```yaml
budget:
```

| Field | Description |
|---------|-------------|
| context_window | Maximum model context window |
| output_reserve | Reserved response budget |
| max_prompt_tokens | Optional prompt limit override |
| warning_threshold | Budget warning threshold |

Example:

```yaml
budget:
  context_window: 128000
  output_reserve: 10000
  warning_threshold: 0.8
```

---

# Governance Configuration

Defines default governance behaviour.

Example:

```yaml
governance:
  default_action: compress
```

Valid actions:

```text
keep
compress
transform
drop
```

---

# Policy Configuration

Policies define deterministic behaviour for context types.

Example:

```yaml
policies:

  terminal_output:
    action: compress

  test_result:
    action: transform

  completed_task:
    action: drop
```

---

## TTL Policies

Items may automatically expire.

Example:

```yaml
policies:

  terminal_output:
    ttl_turns: 3

  plan:
    ttl_turns: 10
```

After the specified number of turns the item becomes eligible for removal.

---

# Context Type Policies

Example:

```yaml
policies:

  goal:
    action: keep

  task:
    action: keep

  plan:
    action: compress

  memory:
    action: keep

  terminal_output:
    action: drop
```

---

# Portfolio Allocation

Optional budget allocation by category.

Example:

```yaml
allocation:

  goals: 5

  tasks: 10

  files: 30

  diffs: 20

  memories: 15

  retrieved_content: 10

  logs: 5

  reserve: 5
```

Values are percentages.

---

# Scoring Providers

Controls how reasoning value is calculated.

Example:

```yaml
scoring:
  provider: heuristic
```

Scoring identifiers shown in this proposed model:

```text
heuristic
custom
```

`heuristic` is a deterministic baseline target; `custom` denotes an extension point. This does not indicate implemented runtime support.

Future providers:

```text
local-model
embedding
hybrid
```

---

## Heuristic Configuration

Example:

```yaml
scoring:

  provider: heuristic

  weights:

    recency: 0.4

    references: 0.3

    priority: 0.3
```

---

# Decision Intelligence

Provider selection is proposed per decision kind. Rules and heuristics remain the deterministic baseline, and the Governor validates provider proposals before making the final decision.

```yaml
decision_intelligence:
  context_retention:
    provider: d1-2b

  memory_importance:
    provider: jev

  compression_strategy:
    provider: heuristic

  transformation:
    provider: none

  retry:
    provider: none

  model_escalation:
    provider: none
```

This example demonstrates a configuration shape only. `d1-2b`, `jev`, and `none` do not imply that corresponding adapters or a configuration loader are implemented. The provider interface and safeguards are described in [Decision Intelligence](DECISION_INTELLIGENCE.md); see [Providers](PROVIDERS.md) for evaluation status.

---

# Compression Providers

Compression providers optimise retained context.

Example:

```yaml
compression:

  providers:
    - llmlingua

    - caveman

    - rtk
```

Provider order determines priority.

---

# Transformation Providers

Transformation providers replace raw information with more useful representations.

Example:

```yaml
transformations:

  providers:
    - log-summary

    - test-summary

    - decision-record
```

Typical examples:

```text
Build Log
      ↓
Failure Summary

Test Output
      ↓
Structured Findings
```

---

# Plugin Configuration

Plugins are enabled individually.

Example:

```yaml
plugins:

  scoring:
    - heuristic

  compression:
    - llmlingua

  transformations:
    - test-summary

decision_intelligence:
  context_retention:
    provider: d1-2b

  memory_importance:
    provider: jev

  compression_strategy:
    provider: heuristic
```

See:

```text
docs/PLUGIN_API.md
```

for plugin development details.

---

# Environment Overrides

Configuration values may be overridden through environment variables.

Example:

```bash
ECC_CONTEXT_WINDOW=128000
ECC_OUTPUT_RESERVE=10000
```

The intended configuration precedence gives environment values priority. Decision-provider environment override names are not standardized in this proposal.

---

# Profiles

Profiles allow multiple governance strategies.

Example:

```yaml
profiles:

  local:

    budget:
      context_window: 32000

  cloud:

    budget:
      context_window: 200000
```

Usage:

```bash
ecc-curator --profile local
```

---

# Recommended Profiles

## Local LLM

```yaml
budget:
  context_window: 64000

policies:
  terminal_output:
    action: drop

  test_result:
    action: compress
```

Optimised for constrained environments.

---

## Cloud Model

```yaml
budget:
  context_window: 200000

policies:
  terminal_output:
    action: compress
```

These are illustrative profiles in the proposed configuration model, not validated runtime configurations.

# Scoring Specification

> A deterministic heuristic score ranks context items; it does not replace policy or make the final governance decision.

This specification proposes a reproducible score for context prioritization. It is a design contract, not implemented scoring behavior or a validated optimum. The Governor consumes scores; the [Prompt Assembler](PROMPT_ASSEMBLER.md) uses them for ordering when policy permits.

## Score range and formula

For an eligible context item `i`, calculate:

```text
S_i = clamp(0, 1,
  w_p * P_i
  + w_r * R_i
  + w_f * F_i
  + w_t * T_i
  + w_c * C_i)
```

Default weights:

| Component | Symbol | Weight |
|---|---:|---:|
| Explicit priority | `P_i` | 0.30 |
| Recency | `R_i` | 0.25 |
| Reference boost | `F_i` | 0.15 |
| Context-type baseline | `T_i` | 0.20 |
| Cost affordability | `C_i` | 0.10 |
| **Total** | | **1.00** |

All component values and the final score are finite numbers in `[0, 1]`. Weights must be finite, non-negative, and sum to `1.0` within a configured floating-point tolerance. If configuration is invalid, initialization fails explicitly rather than silently normalizing weights.

## Inputs and normalization

Inputs:

- `priority`: explicit item priority from metadata, expected in `[0, 1]`.
- `ageTurns`: non-negative number of turns since creation/update relevant to the item.
- `references`: non-negative integer number of references/uses observed by the inventory.
- `tokenCount`: non-negative estimated cost in tokens.
- `contextType`: a recognized context category.
- `workingBudget`: positive token budget available to governed items.

Normalization:

1. Reject non-finite values and invalid negative counts.
2. The Inventory API normalizes missing metadata at ingestion: `priority` to the type baseline, `ageTurns` and `references` to `0`. The scorer receives these values explicitly.
3. Validate priority in `[0, 1]`; return an error for out-of-range values rather than silently clamping.
4. `tokenCount` must come from the inventory token estimator. If unavailable, the item is unscored and cannot participate in size-sensitive allocation until estimated.
5. Unknown context types use `T_i = 0.50` and emit an `UNKNOWN_CONTEXT_TYPE` diagnostic.
6. When no positive `workingBudget` is available, return an explicit scoring error; do not treat cost as free.

## Components

### Priority `P_i`

Use the validated explicit priority:

```text
P_i = metadata.priority
```

The Inventory API ensures priority is present by applying the context-type baseline at ingestion when the host omits it.

User pinning is a hard Governor policy, not an extra score bonus. This avoids implying that a high score can override a pin or other constraint.

### Recency `R_i`

Use exponential half-life decay based on age in turns:

```text
R_i = 2 ^ (-ageTurns / halfLifeTurns)
```

where:

- `ageTurns >= 0`
- `halfLifeTurns > 0` is the configured recency half-life in turns
- default `halfLifeTurns = 10` for the initial deterministic profile

Examples: age `0` gives `1.0`; age `10` gives `0.5`; age `20` gives `0.25`. The half-life is configurable and should be tuned through evaluation, not treated as a measured optimum. Use a numerically stable implementation and clamp the result to `[0,1]`.

### Reference boost `F_i`

Use a saturating function so early repeated use matters more than very large counts:

```text
F_i = references / (references + saturation)
```

where `references` is a non-negative count and default `saturation = 3`. `references = 0` gives `0`; `references = 3` gives `0.5`. This is a ranking signal, not proof of semantic value.

### Context-type baseline `T_i`

Default baselines:

| Context type | `T_i` | Rationale |
|---|---:|---|
| `goal` | 1.00 | Governing objective |
| `task` | 0.95 | Current work |
| `file` | 0.80 | High when task-relevant; priority/references refine it |
| `diff` | 0.80 | Active changes can be important; age and references refine it |
| `memory` | 0.75 | Potentially persistent project knowledge |
| `test_result` | 0.65 | Findings matter; raw output may be verbose |
| `plan` | 0.60 | Useful but may become stale or be transformable |
| `retrieved_content` | 0.55 | Relevance depends on the active task |
| `tool_output` | 0.40 | Often ephemeral/noisy |
| `terminal_output` | 0.35 | Often ephemeral/noisy |
| unknown | 0.50 | Neutral fallback with diagnostic |

These initial values are explicit defaults for reproducibility, not empirically validated importance labels. Profiles may override them.

### Cost affordability `C_i`

Normalize token cost against the current working budget:

```text
costRatio = min(1, tokenCount / workingBudget)
costAffordability = 1 - costRatio
```

where `tokenCount` is the item's token count and `workingBudget > 0` is the budget available for governed items after fixed prompt and output reserves. An item at or above the whole working budget gets `C_i = 0`; cost affects ranking but does not by itself cause a drop.

## Reference implementation pseudocode

```text
function score(item, workingBudget, config):
    validateFiniteNonNegative(item.metadata.ageTurns, item.metadata.references, item.tokenCount)
    validateFinitePositive(workingBudget)

    typeBaseline = config.typeBaselines[item.type] ?? 0.50
    priority = item.metadata.priority
    validateRange(priority, 0, 1)

    recency = clamp01(2 ** (-item.metadata.ageTurns / config.recencyHalfLifeTurns))
    references = item.metadata.references /
      (item.metadata.references + config.referenceSaturation)
    affordability = 1 - min(1, item.tokenCount / workingBudget)

    result =
        config.weights.priority * priority
      + config.weights.recency * recency
      + config.weights.references * references
      + config.weights.typeBaseline * typeBaseline
      + config.weights.costAffordability * affordability

    return clamp01(result)
```

The MVP should use the defaults above as versioned constants or validated configuration. Scores must be reproducible for identical item metadata and scoring configuration.

## Worked examples

Assume the default weights, a 10-turn recency half-life, reference saturation `3`, and `workingBudget = 10,000`.

### Current goal

Inputs: type `goal`, priority `1.00`, age `0`, references `3`, cost `500`.

```text
R = 1
F = 3 / (3 + 3) = 0.5
C = 1 - 500 / 10,000 = 0.95
S = 0.30(1) + 0.25(1) + 0.15(0.5) + 0.20(1) + 0.10(0.95)
  = 0.920
```

### Old terminal output

Inputs: type `terminal_output`, priority `0.20`, age `20`, references `0`, cost `2,000`.

```text
R = 2 ^ (-20 / 10) = 0.25
F = 0 / (0 + 3) = 0
C = 1 - 2,000 / 10,000 = 0.80
S = 0.30(0.20) + 0.25(0.25) + 0.15(0)
  + 0.20(0.35) + 0.10(0.80)
  = 0.2725
```

The score ranks this item lower; the Governor still applies TTL rules and budget policy explicitly.

### Current test result

Inputs: type `test_result`, priority `0.70`, age `2`, references `2`, cost `1,000`.

```text
R = 2 ^ (-2 / 10) ≈ 0.8706
F = 2 / (2 + 3) = 0.4
C = 1 - 1,000 / 10,000 = 0.90
S ≈ 0.30(0.70) + 0.25(0.8706) + 0.15(0.4)
  + 0.20(0.65) + 0.10(0.90)
  ≈ 0.708
```

These examples verify arithmetic for the specified formula only; they are illustrative scores, not benchmark results or claims about task quality.

## Interpretation and boundaries

- Score is a relative prioritization feature, not a probability of usefulness.
- A score alone does not choose `KEEP`, `COMPRESS`, `TRANSFORM`, or `DROP`; the Governor applies configured thresholds, rules, budgets, and safeguards.
- Pins, user instructions, privacy constraints, and explicit policy are not overridden by score.
- Never use token cost as a direct reason to drop without the Governor's configured budget-pressure policy.

## Future provider-based extensions

An optional provider may propose a relevance score or classification using the provider-independent contract in [Decision Schemas](DECISION_SCHEMAS.md). The Governor must validate output bounds and retain final authority. Provider scoring should be compared with this heuristic baseline on the same long-running coding workloads. No provider is required for baseline operation.

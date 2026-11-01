# Prompt Assembler

> The Prompt Assembler turns the Governor's validated working-set plan into an ordered prompt package and checks its final budget.

This specification describes the intended assembler contract. No prompt assembler is implemented in this repository. Governance decisions are made by the Governor; assembly must not silently change them except through an explicit overflow policy. See [Governor Algorithm](GOVERNOR_ALGORITHM.md), [Inventory API](INVENTORY_API.md), and [Configuration](CONFIGURATION.md).

## Responsibilities

The Prompt Assembler:

- Accepts fixed host prompt segments, an available budget, and Governor-approved context items.
- Applies configured portfolio allocations and deterministic ordering.
- Serializes a provider/runtime-neutral package, leaving final host-specific rendering to an adapter.
- Estimates/counts the complete serialized input and enforces the input budget.
- Reports included, excluded, transformed, and overflowed items with reasons and token accounting.

It does not classify, score, decide governance actions, execute compression/transformation, or call the language model.

## Input contracts

```typescript
export type PromptSegmentRole =
  | "system"
  | "developer"
  | "user"
  | "context";

export interface PromptSegment {
  id: string;
  role: PromptSegmentRole;
  content: string;
  fixed: boolean;
  order: number;
}

export interface ApprovedContextItem {
  item: ContextItem;
  action: "KEEP" | "COMPRESS" | "TRANSFORM";
  score: number;
  policyPriority: number;
  category: string;
  tokenCount: number;
}

export interface AssemblyBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  maxPromptTokens?: number;
}

export interface AssemblyRequest {
  fixedSegments: readonly PromptSegment[];
  candidates: readonly ApprovedContextItem[];
  budget: AssemblyBudget;
  allocations?: Readonly<Record<string, number>>;
  overflowPolicy?: "exclude-lowest-ranked" | "error";
  estimator: PromptTokenEstimator;
  serialization: PromptSerialization;
}

export interface PromptTokenEstimator {
  readonly id: string;
  readonly version: string;
  readonly exact: boolean;
  countSerialized(text: string): number;
  countSegment(segment: PromptSegment): number;
  countContextItem(item: ContextItem): number;
}

export interface PromptSerialization {
  readonly id: string;
  readonly version: string;
  serialize(
    fixedSegments: readonly PromptSegment[],
    contextItems: readonly ContextItem[]
  ): string;
}
```

`ApprovedContextItem` must only contain items whose Governor result is not `DROP`. `COMPRESS` and `TRANSFORM` items must contain the validated replacement representation from the separate executor, not the unprocessed original under a misleading action label.

## Output package

```typescript
export interface PromptPackage {
  schemaVersion: "1";
  segments: readonly PromptSegment[];
  contextItems: readonly ContextItem[];
  serializedInput: string;
  tokenCount: number;
  budget: {
    contextWindowTokens: number;
    outputReserveTokens: number;
    safetyMarginTokens: number;
    inputLimitTokens: number;
    remainingTokens: number;
  };
  report: AssemblyReport;
}

export interface AssemblyReport {
  included: readonly AssemblyItemRecord[];
  excluded: readonly AssemblyItemRecord[];
  tokenCounts: {
    fixedSegments: number;
    contextItems: number;
    serializedPackage: number;
  };
  allocationUse: Readonly<Record<string, number>>;
  overflow?: {
    requiredTokens: number;
    availableTokens: number;
    pinnedItemIds: readonly string[];
  };
}

export interface AssemblyItemRecord {
  itemId: string;
  category: string;
  tokenCount: number;
  score: number;
  reasonCode: string;
}

export type AssemblyResult =
  | { ok: true; package: PromptPackage }
  | {
      ok: false;
      error:
        | "FixedPromptOverflow"
        | "PinnedContextOverflow"
        | "UnresolvableOverflow"
        | "InvalidBudget"
        | "InvalidTokenEstimate";
      report: AssemblyReport;
    };
```

The serialized package is the authoritative object sent to the runtime adapter. If the host constructs additional prompt text after assembly, that text must be included in the budget check or reserved explicitly.

## Budget enforcement

Calculate the item-input limit:

```text
L = min(
  contextWindowTokens - outputReserveTokens - safetyMarginTokens,
  maxPromptTokens if configured)
```

Require all inputs to be finite non-negative integers and `L >= 0`. If fixed serialized segments exceed `L`, return `{ ok: false, error: "FixedPromptOverflow" }`; do not remove or truncate fixed content silently.

Token accounting:

1. Count fixed segments using the serialization-aware estimator.
2. Count each candidate's serialized representation, including any role/label/separator overhead.
3. Select candidates under budget and optional allocations.
4. Serialize the entire package and estimate/count it again to capture framing overhead.
5. If final count exceeds `L`, follow `overflowPolicy` (default: `exclude-lowest-ranked`): remove lowest-ranked non-pinned candidates deterministically and reserialize until it fits or no removable candidate remains. With `error`, return a failure rather than excluding candidates.
6. If pinned/fixed content still exceeds the limit, return an explicit overflow result, not a success-shaped package.

Use an exact model/runtime tokenizer when available. Otherwise, use the configured conservative estimator and label counts as estimates. A token window is model/runtime-specific; a generic character-count approximation cannot guarantee fit.

## Ordering strategy

Preserve fixed segments exactly in their supplied `order`; ties are resolved by `id` ascending. Context items are ordered in priority tiers:

1. Pinned items, subject to explicit policy and overflow errors.
2. Goal and current task items.
3. Remaining items by score descending.
4. Ties: `policyPriority` ascending (lower number means stronger precedence), recency (`ageTurns`) ascending, reference count descending, token count ascending, then item ID ascending.

Place selected context segments after the fixed system/developer segments and before the final user/task segment if the host serialization contract requires it. Since hosts differ, actual role ordering belongs in `PromptSerialization`, but the chosen order must be explicit, stable, and covered by tests. Do not reorder within a fixed segment group unless the host adapter says so.

## Portfolio allocation

`allocations` maps context categories to fractions of the context-item budget, between `0` and `1`. Values must be finite and their sum must not exceed `1.0`.

Recommended MVP interpretation:

- Treat each configured category allocation as a **soft first-pass cap**, not a hard quota.
- Fill each category up to its cap using the stable global ordering.
- Redistribute unused capacity in a second pass across remaining candidates in global order.
- Unallocated fraction remains reserve unless `redistributeUnallocated` is explicitly enabled by policy.
- Pinned/mandatory items may exceed category caps, but never the total input limit; total overflow is explicit.

If allocations are absent, all candidates compete in one global pool. Allocation is not an entitlement to displace fixed segments or pinned items.

## Tie-breaking

All ordering must be deterministic for an identical request:

1. Pin and policy tier.
2. Score descending.
3. Policy priority ascending.
4. Context type tier: goal, task, file/diff, memory, test result, plan, retrieved content, tool/terminal output, unknown.
5. Age ascending.
6. References descending.
7. Token cost ascending.
8. Item ID ordinal ascending.

The same comparator must be used for capacity redistribution and final overflow removal (reverse order among removable items).

## Overflow handling

Return `AssemblyResult` with explicit structured errors:

- `FixedPromptOverflow`: fixed segments exceed available input budget.
- `PinnedContextOverflow`: pinned items plus fixed segments exceed available budget.
- `CandidateOverflow`: non-pinned candidates were excluded to satisfy budget; record this in a successful package's report if final serialized package fits.
- `SerializationOverflow`: full serialized form exceeds budget after selection; re-run deterministic removal/re-serialization.
- `UnresolvableOverflow`: no permitted candidate can be removed and final form remains over budget.

Never silently truncate text or split an item. Truncation/summarization is a `TRANSFORM` strategy decided and executed before assembly.

## Observability and reporting

Report:

- Requested budget, output reserve, safety margin, calculated input limit, and remaining tokens.
- Estimator/provider identity and version; whether counts are exact or estimated.
- Fixed-segment, item, and final serialized token counts.
- Included/excluded item IDs, categories, scores, token cost, and reason codes.
- Category allocation caps and utilization, overflow status, and dropped-by-assembly items.
- Serialization schema/version and deterministic ordering version.

Avoid logging context content by default. Reports should not expose secrets or full prompts unless explicit privacy policy permits it.

## Worked example

Assume an input limit of `1,000` tokens after fixed segments. Three approved items:

| Item | Pin | Score | Cost |
|---|---:|---:|---:|
| Active goal | Yes | 0.98 | 250 |
| Current test finding | No | 0.78 | 500 |
| Old terminal output | No | 0.30 | 400 |

Selection:

1. Include the pinned goal (`250`).
2. Include the test finding (`750` total).
3. Terminal output would exceed the limit (`1,150`), so exclude it with `ASSEMBLY_BUDGET_OVERFLOW`.
4. Serialize and re-count framing overhead. If it is within `1,000`, return the package; otherwise remove the lowest-ranked non-pinned item and retry. If only pinned/fixed content remains and is too large, return `PinnedContextOverflow`.

This is an illustrative selection example, not a benchmark or measured token result.

## MVP scope

- Pure deterministic selection and ordering over Governor-approved items.
- Fixed-segment budget accounting and serialization-aware token estimation interface.
- Stable tie-breaks, optional soft category caps, final re-count, and explicit overflow results.
- Reports with IDs, counts, reason codes, and estimator provenance; no raw content logging by default.
- No implicit truncation, summarization, provider calls, persistence, or model invocation.

## Future optimization paths

- Runtime-specific tokenization and exact serialized request builders.
- Adaptive category allocations from measured workloads.
- Incremental reassembly and content deduplication where semantics permit.
- Retrieval-backed context expansion under a second explicit budget.
- Evaluation-driven ordering changes; preserve versioned comparator behavior for reproducibility.

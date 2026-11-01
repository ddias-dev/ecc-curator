# Decision Schemas

These provider-independent schemas describe proposed requests and responses for decision intelligence. They are conceptual documentation, not implemented types or a guarantee of JSON Schema/runtime validation.

## Shared types

```typescript
type DecisionKind =
  | "ContextRetentionDecision"
  | "MemoryImportanceDecision"
  | "CompressionStrategyDecision"
  | "TransformationDecision"
  | "RetryDecision"
  | "ModelEscalationDecision";

interface DecisionRequest<TInput> {
  requestId: string;
  kind: DecisionKind;
  schemaVersion: "1";
  input: TInput;
  allowedOutcomes: readonly string[];
  policyVersion: string;
}

interface DecisionProposal<TOutcome> {
  requestId: string;
  kind: DecisionKind;
  schemaVersion: "1";
  outcome: TOutcome;
  confidence?: number;
  scores?: Record<string, number>;
  rationaleCode?: string;
}
```

All confidence and score values, when provided, are finite numbers in `[0, 1]`. Free-form provider reasoning is intentionally not required. The Governor validates the response, checks the request ID and kind, and applies policy before deciding.

## ContextRetentionDecision

**Purpose:** Propose the treatment of one context item for the active working set.

```typescript
type ContextRetentionOutcome =
  | "KEEP"
  | "COMPRESS"
  | "TRANSFORM"
  | "DROP";

interface ContextRetentionInput {
  itemId: string;
  itemType: string;
  taskSummary: string;
  contentSummary?: string;
  tokenCost: number;
  ageTurns?: number;
  referenceCount?: number;
  pinned: boolean;
}

type ContextRetentionProposal =
  DecisionProposal<ContextRetentionOutcome>;
```

Provider input should be bounded and privacy-filtered. `pinned` is descriptive; the provider cannot override the Governor's pin policy.

## MemoryImportanceDecision

**Purpose:** Propose an importance score and optional retention tier for an existing memory.

```typescript
type MemoryRetentionTier =
  | "WORKING"
  | "LONG_TERM"
  | "PERMANENT"
  | "DISPOSABLE";

interface MemoryImportanceInput {
  memoryId: string;
  summary: string;
  taskSummary?: string;
  referenceCount: number;
  ageTurns: number;
  userPinned: boolean;
}

interface MemoryImportanceOutcome {
  importance: number;
  tier: MemoryRetentionTier;
}

type MemoryImportanceProposal =
  DecisionProposal<MemoryImportanceOutcome>;
```

Importance must be in `[0, 1]`. The Governor remains responsible for policy around pinned or permanent memories.

## CompressionStrategyDecision

**Purpose:** Select or rank a compression strategy already registered and allowed by policy.

```typescript
interface CompressionStrategyInput {
  itemId: string;
  itemType: string;
  tokenCost: number;
  availableStrategies: readonly string[];
  taskSummary: string;
}

interface CompressionStrategyOutcome {
  strategyId: string;
}

type CompressionStrategyProposal =
  DecisionProposal<CompressionStrategyOutcome>;
```

`strategyId` must match an entry in `availableStrategies`; this decision does not invoke or perform compression.

## TransformationDecision

**Purpose:** Select a registered transformation or recommend that no transformation is appropriate.

```typescript
interface TransformationInput {
  itemId: string;
  itemType: string;
  tokenCost: number;
  availableTransformations: readonly string[];
  taskSummary: string;
}

interface TransformationOutcome {
  action: "TRANSFORM" | "NO_TRANSFORM";
  transformationId?: string;
}

type TransformationProposal =
  DecisionProposal<TransformationOutcome>;
```

When `action` is `TRANSFORM`, `transformationId` is required and must be allowlisted. The provider chooses an option; a separate transformation executor produces output.

## RetryDecision

**Purpose:** Advise whether another attempt is appropriate given a bounded failure and attempt state.

```typescript
interface RetryInput {
  operationId: string;
  errorCategory: string;
  attemptCount: number;
  maxAttempts: number;
  idempotent: boolean;
  transientError: boolean;
}

interface RetryOutcome {
  action: "RETRY" | "STOP";
}

type RetryProposal = DecisionProposal<RetryOutcome>;
```

The Governor must enforce `maxAttempts`, idempotency requirements, and stop policies regardless of provider output.

## ModelEscalationDecision

**Purpose:** Advise whether a configured candidate model change merits consideration.

```typescript
interface ModelEscalationInput {
  currentModelId: string;
  candidateModelIds: readonly string[];
  reason: "CONTEXT_PRESSURE" | "CAPABILITY_GAP" | "REPEATED_FAILURE" | "OTHER";
  userApprovalRequired: boolean;
  localOnly: boolean;
}

interface ModelEscalationOutcome {
  action: "STAY" | "RECOMMEND_CANDIDATE";
  candidateModelId?: string;
}

type ModelEscalationProposal =
  DecisionProposal<ModelEscalationOutcome>;
```

Any recommended model must be in `candidateModelIds`. The Governor enforces user approval, local-only, privacy, resource, and cost policies; provider output cannot trigger escalation by itself.

## Validation requirements

For all decision kinds, the Governor must:

- Validate shape, schema version, request ID, and decision kind.
- Validate outcome enums, required fields, score bounds, and allowlists.
- Enforce policy and hard safeguards independently of provider confidence.
- Treat missing, malformed, unsupported, or failed provider output as a provider failure and apply configured deterministic fallback.
- Keep provider proposals distinct from final governance decisions and from strategy execution.

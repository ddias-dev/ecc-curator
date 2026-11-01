# Inventory API

> The Context Inventory is the governed working set, not necessarily the complete durable history of a coding session.

This document defines a proposed in-memory MVP API consistent with [Context Model](CONTEXT_MODEL.md). The repository does not currently implement this API. Persistence and retrieval beyond the active process are future scope.

## Core interfaces

```typescript
export type ContextType =
  | "goal"
  | "task"
  | "plan"
  | "memory"
  | "file"
  | "diff"
  | "tool_output"
  | "terminal_output"
  | "test_result"
  | "retrieved_content"
  | (string & {});

export type ContextLifecycleState =
  | "ACTIVE"
  | "COMPRESSED"
  | "TRANSFORMED"
  | "ARCHIVED"
  | "DROPPED";

export interface ContextMetadata {
  priority: number;
  ageTurns: number;
  references: number;
  source: string;
  compressed: boolean;
  transformed: boolean;
  pinned: boolean;
  [key: string]: unknown;
}

export interface ContextItem {
  id: string;
  type: ContextType;
  content: string;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
  metadata: ContextMetadata;
  state: ContextLifecycleState;
  revision: number;
  replacesId?: string;
  tags?: readonly string[];
}

export type InventoryEventType =
  | "ITEM_ADDED"
  | "ITEM_UPDATED"
  | "ITEM_REMOVED"
  | "ITEM_ARCHIVED"
  | "ITEM_STATE_CHANGED"
  | "TURN_ADVANCED"
  | "REFERENCE_RECORDED";

export interface InventoryEvent {
  sequence: number;
  eventId: string;
  type: InventoryEventType;
  itemId: string;
  occurredAt: string;
  revision?: number;
  reason?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface ContextInventorySnapshot {
  version: number;
  items: readonly ContextItem[];
  tokenCount: number;
}
```

`ContextItem` extends the existing conceptual fields with lifecycle state, revision, and replacement provenance. These additions make state transitions explicit and auditable; they do not imply durable storage. `tokenCount` is the current representation's estimate and must be refreshed whenever content changes.

## Core interface

```typescript
export interface ContextInventory {
  advanceTurn(): number;
  add(input: NewContextItem): ContextItem;
  update(id: string, patch: ContextItemPatch, expectedRevision?: number): ContextItem;
  transitionState(
    id: string,
    state: ContextLifecycleState,
    reason: string,
    expectedRevision?: number,
    replacement?: ContextItemReplacement
  ): ContextItem;
  remove(id: string, reason?: string): ContextItem;
  archive(id: string, reason?: string): ContextItem;
  get(id: string): ContextItem | undefined;
  query(query: InventoryQuery): readonly ContextItem[];
  list(options?: InventoryListOptions): readonly ContextItem[];

  recordReference(id: string, reference: ReferenceInput): ContextItem;
  snapshot(): ContextInventorySnapshot;
  events(afterSequence?: number): readonly InventoryEvent[];
}
```

Public methods either return the documented result or throw a typed error (`DuplicateContextItemError`, `ContextItemNotFoundError`, `RevisionConflictError`, `InvalidContextItemError`, or `TokenEstimationError`). They must not silently return success-shaped defaults.

```typescript
export interface ContextItemPatch {
  type?: ContextType;
  content?: string;
  metadata?: Partial<ContextMetadata>;
  tags?: readonly string[];
}

export interface ContextItemReplacement {
  content: string;
  tokenCount: number;
  metadata?: Partial<ContextMetadata>;
}
```

## Operations and semantics

| Operation | Semantics |
|---|---|
| `add(input)` | Validate ID/type/content/metadata; estimate tokens if omitted; set state to `ACTIVE`, revision `1`, and timestamps; reject duplicate IDs; emit `ITEM_ADDED`. |
| `advanceTurn()` | Increment the inventory turn index and each active item's derived `ageTurns` by one; emit one `TURN_ADVANCED` event. Age changes do not increment content revision. |
| `update(id, patch, expectedRevision?)` | Return a new immutable item; increment revision and `updatedAt`; re-estimate token count when content changes; optionally enforce optimistic revision; emit `ITEM_UPDATED`. Lifecycle changes use transition methods/policy. |
| `transitionState(id, state, reason, expectedRevision?, replacement?)` | Apply an allowed lifecycle transition, increment revision, and emit `ITEM_STATE_CHANGED`. `COMPRESSED` and `TRANSFORMED` require a validated replacement representation and set the matching metadata flag; `DROPPED` clears content and token count, retaining only a metadata tombstone with no retrieval guarantee. |
| `remove(id, reason?)` | Physically remove the item from this inventory and return the removed item. Emit a tombstone `ITEM_REMOVED` event without duplicating content. This does not promise deletion from any future external archive. |
| `archive(id, reason?)` | Transition to `ARCHIVED`; retain metadata and content in the MVP in-memory inventory but exclude it from active snapshots unless explicitly queried. Retrieval across process restarts is not provided. Emit `ITEM_ARCHIVED`. |
| `get(id)` | Return the current immutable item or `undefined`; no implicit state filter. |
| `query(query)` | Filter by type, state, source, tag, age, pinned flag, and/or text predicate supported by the implementation. Return a deterministic sequence. |
| `list(options?)` | List items; default includes active states only. Explicit options may include archived/dropped items. Sort by stable insertion sequence then ID unless a sort is supplied. |

### State transitions

```text
ACTIVE ──compress succeeds──> COMPRESSED
ACTIVE ──transform succeeds─> TRANSFORMED
ACTIVE ──archive────────────> ARCHIVED
ACTIVE ──governor drops─────> DROPPED
COMPRESSED ──replace────────> COMPRESSED
TRANSFORMED ──replace───────> TRANSFORMED
COMPRESSED / TRANSFORMED ──archive──> ARCHIVED
Any retained state ──remove─────────> physically absent
```

Invalid transitions fail explicitly. A successful compression/transformation creates a new revision of the item with replacement content, updated token count, and the corresponding state flag. If policy requires preserving the original, archive a separately identified copy before replacement; otherwise do not imply that raw content remains retrievable. `DROPPED` clears content and carries no retrieval guarantee. Physical `remove()` is separate.

## Query contracts

```typescript
export interface InventoryQuery {
  ids?: readonly string[];
  types?: readonly ContextType[];
  states?: readonly ContextLifecycleState[];
  sources?: readonly string[];
  tagsAny?: readonly string[];
  pinned?: boolean;
  minAgeTurns?: number;
  maxAgeTurns?: number;
  textIncludes?: string;
}

export interface InventoryListOptions {
  states?: readonly ContextLifecycleState[];
  orderBy?: "insertion" | "updatedAt" | "createdAt" | "tokenCount";
  direction?: "asc" | "desc";
  limit?: number;
}
```

MVP query behavior:

- Empty filters match all items in the selected states.
- Multiple values in one field are ORed; different fields are ANDed.
- Text matching is exact substring matching with a documented case-sensitivity setting; no semantic search is implied.
- Stable tie-break is `id` ascending after the requested order.
- Invalid ranges or negative `limit` are validation errors.
- Default `list()` and `snapshot()` contain only `ACTIVE`, `COMPRESSED`, and `TRANSFORMED` items; `ARCHIVED` and `DROPPED` require explicit inclusion.

## Lifecycle and event behavior

Inventory mutations are immutable from the caller's perspective and increment an inventory `version`. Each successful mutation emits exactly one monotonically sequenced event. A failed operation emits no success event.

Events include IDs, revision, timestamp, reason code, and non-sensitive metadata. Do not include full item content in events by default. Reference events should include the source/relationship category and timestamp but avoid retaining arbitrary source payloads.

```typescript
export interface ReferenceInput {
  sourceId?: string;
  relationship: "used" | "mentioned" | "supports" | "derived_from";
  occurredAt?: string;
}
```

`recordReference()` increments `metadata.references` by one, updates `updatedAt` only if reference updates are configured to affect item recency, increments revision, and emits `REFERENCE_RECORDED`. The MVP must choose and document that configuration; default recommendation is references do **not** reset age, preventing repeated lookups from making stale material appear newly created.

The host calls `advanceTurn()` once per completed agent turn, not once per tool event. Newly added items start at age zero. An update that changes the item's substantive content resets age to zero; metadata-only updates and reference events do not reset age unless explicitly configured.

## Context ingestion

Ingestion adapters normalize host-agent events into `NewContextItem`:

```typescript
export interface NewContextItem {
  id: string;
  type: ContextType;
  content: string;
  tokenCount?: number;
  metadata: Partial<ContextMetadata> & Pick<ContextMetadata, "source">;
  tags?: readonly string[];
}
```

Rules:

- Preserve source and creation time when supplied by the host; otherwise use an injected clock.
- Normalize metadata to the Context Model shape: default `priority` to the type baseline (or neutral baseline if unknown), `ageTurns`/`references` to `0`, and `compressed`/`transformed`/`pinned` to `false`.
- Deduplicate by stable `id`; duplicate `add()` is an error, not an implicit update.
- Validate content and metadata size before storing.
- Do not assume the inventory should ingest every transcript/tool event. Source adapters apply collection policy.
- Pinned state is metadata for display; enforcement belongs to the Governor's policy layer.

## Token estimation

Token estimation is injected rather than hardcoded into the inventory:

```typescript
export interface TokenEstimator {
  estimate(text: string, context?: { modelId?: string; encodingId?: string }): number;
}
```

The selected estimator and version should be recorded with evaluation data. If a target tokenizer is available, use it; otherwise use a documented conservative estimator and mark counts as estimates. Empty content may estimate to zero. Negative, non-finite, or unavailable estimates produce `TokenEstimationError`; do not silently store zero for non-empty content.

## MVP implementation scope

- In-memory inventory with immutable item values.
- Add, update, remove, archive, get, query, list, reference tracking, snapshots, and ordered events.
- Injected clock, ID source, and token estimator for deterministic tests.
- Input validation, duplicate detection, optional optimistic revision checks, and explicit typed errors.
- No database, cross-process persistence, vector search, semantic retrieval, or guaranteed archive recovery.

## Future scope

- Durable persistence and migration/versioning.
- Retrieval across archived or dropped history, subject to explicit retention policy.
- Transactional batches, concurrent writers, and event-log replay.
- Host-specific ingestion connectors and semantic query providers.
- Token estimators specialized by model/runtime.

See [Context Model](CONTEXT_MODEL.md) for concepts and [Roadmap](ROADMAP.md) for intended phases.

// ECC Curator — inventory contracts.
// Source of truth: docs/INVENTORY_API.md (with docs/CONTEXT_MODEL.md).
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums.
// NOTE (default snapshot state): default list() and snapshot() contain only
// ACTIVE, COMPRESSED, and TRANSFORMED items; ARCHIVED and DROPPED require
// explicit inclusion (docs/INVENTORY_API.md, "Query contracts").

import type { ContextItem, ContextMetadata, ContextType, ContextLifecycleState } from "./context.ts";

// Inventory event kinds (docs/INVENTORY_API.md, "Lifecycle and event behavior").
export type InventoryEventType =
  | "ITEM_ADDED"
  | "ITEM_UPDATED"
  | "ITEM_REMOVED"
  | "ITEM_ARCHIVED"
  | "ITEM_STATE_CHANGED"
  | "TURN_ADVANCED"
  | "REFERENCE_RECORDED";

// One monotonically sequenced event per successful mutation. Events carry IDs,
// revision, timestamp, reason code, and non-sensitive metadata; full item
// content is not included by default.
export interface InventoryEvent {
  sequence: number; // integer >= 0; monotonically increasing per inventory
  eventId: string;
  type: InventoryEventType;
  itemId?: string; // absent for inventory-level events (e.g. TURN_ADVANCED)
  occurredAt: string; // ISO-8601, from injected clock
  revision?: number; // item revision the event applies to, when item-scoped
  reason?: string; // explicit reason code for audit/evaluation
  details?: Readonly<Record<string, unknown>>; // non-sensitive metadata only
}

// Default snapshot excludes ARCHIVED/DROPPED unless explicitly requested; see
// NOTE at top of file. tokenCount is the sum of current representations'
// estimated tokens.
export interface ContextInventorySnapshot {
  version: number; // integer >= 0; increments on each successful mutation
  items: readonly ContextItem[];
  tokenCount: number; // integer >= 0
}

// Patch surface for update(); content changes re-estimate tokenCount and
// increment revision. Lifecycle changes go through transitionState(), not
// update().
export interface ContextItemPatch {
  type?: ContextType;
  content?: string;
  metadata?: Partial<ContextMetadata>;
  tags?: readonly string[];
}

// Validated replacement representation required by COMPRESSED and
// TRANSFORMED transitions; carries the new content and refreshed token count.
export interface ContextItemReplacement {
  content: string;
  tokenCount: number; // integer >= 0; refreshed estimate for replacement content
  metadata?: Partial<ContextMetadata>;
}

// MVP query semantics: empty filters match all items in the selected states;
// values within one field are ORed; fields are ANDed; text matching is exact
// substring.
export interface InventoryQuery {
  ids?: readonly string[];
  types?: readonly ContextType[];
  states?: readonly ContextLifecycleState[];
  sources?: readonly string[]; // match against metadata.source
  tagsAny?: readonly string[];
  pinned?: boolean; // match against metadata.pinned
  minAgeTurns?: number; // inclusive lower bound, integer >= 0
  maxAgeTurns?: number; // inclusive upper bound; must be >= minAgeTurns
  textIncludes?: string; // exact substring match
}

// Default list() includes active states only (ACTIVE/COMPRESSED/TRANSFORMED).
// Stable tie-break is id ascending after the requested order; a negative
// limit is a validation error.
export interface InventoryListOptions {
  states?: readonly ContextLifecycleState[];
  orderBy?: "insertion" | "updatedAt" | "createdAt" | "tokenCount";
  direction?: "asc" | "desc";
  limit?: number; // integer >= 0
}

// Reference recording: increments metadata.references by one; references do
// not reset age by default (docs/INVENTORY_API.md, recordReference()).
export interface ReferenceInput {
  sourceId?: string;
  relationship: "used" | "mentioned" | "supports" | "derived_from";
  occurredAt?: string; // ISO-8601; defaults to injected clock
}

// Normalized ingestion shape; metadata must carry `source`; other metadata
// fields are defaulted by ingestion adapters (priority baseline, ageTurns/
// references 0, flags false). Duplicate add() by stable id is an error.
export interface NewContextItem {
  id: string;
  type: ContextType;
  content: string;
  tokenCount?: number; // estimated via injected TokenEstimator when omitted
  metadata: Partial<ContextMetadata> & Pick<ContextMetadata, "source">;
  tags?: readonly string[];
}

// Typed error contracts. Public methods either return the documented result
// or throw one of these; they must not silently return success-shaped
// defaults. A failed operation emits no success event.

// Thrown when add() receives an id that already exists in the inventory.
export class DuplicateContextItemError extends Error {
  code: string;
  itemId: string; // the colliding id

  constructor(itemId: string, message?: string) {
    super(message ?? `Context item id already exists: ${itemId}`);
    this.code = "DUPLICATE_CONTEXT_ITEM";
    this.itemId = itemId;
  }
}

// Thrown when an id-addressed operation cannot find the item.
export class ContextItemNotFoundError extends Error {
  code: string;
  itemId: string; // the missing id

  constructor(itemId: string, message?: string) {
    super(message ?? `Context item not found: ${itemId}`);
    this.code = "CONTEXT_ITEM_NOT_FOUND";
    this.itemId = itemId;
  }
}

// Thrown when an optimistic expectedRevision does not match the item's
// current revision.
export class RevisionConflictError extends Error {
  code: string;
  itemId: string; // the conflicted item
  expected: number; // caller-provided expected revision
  actual: number; // current revision in the inventory

  constructor(itemId: string, expected: number, actual: number, message?: string) {
    super(message ?? `Revision conflict for ${itemId}: expected ${expected}, actual ${actual}`);
    this.code = "REVISION_CONFLICT";
    this.itemId = itemId;
    this.expected = expected;
    this.actual = actual;
  }
}

// Thrown for invalid item input (bad id/type/content/metadata) or invalid
// transitions and query/list validation failures.
export class InvalidContextItemError extends Error {
  code: string;
  itemId: string; // the offending item id, when one applies ("" otherwise)
  reason: string; // explicit validation reason code

  constructor(itemId: string, reason: string, message?: string) {
    super(message ?? `Invalid context item ${itemId}: ${reason}`);
    this.code = "INVALID_CONTEXT_ITEM";
    this.itemId = itemId;
    this.reason = reason;
  }
}

// Thrown when token estimation fails: negative, non-finite, or unavailable
// estimates. Never silently store zero for non-empty content.
export class TokenEstimationError extends Error {
  code: string;
  reason: string; // explicit estimation failure reason

  constructor(reason: string, message?: string) {
    super(message ?? `Token estimation failed: ${reason}`);
    this.code = "TOKEN_ESTIMATION_FAILED";
    this.reason = reason;
  }
}

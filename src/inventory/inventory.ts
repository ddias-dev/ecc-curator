// src/inventory/inventory.ts
// ECC Curator - in-memory Context Inventory engine (Sprint 2).
// Contract sources: docs/INVENTORY_API.md ("Core interface", "Operations and
// semantics", "State transitions", "Query contracts", "Lifecycle and event
// behavior", "Context ingestion", "Token estimation", "MVP implementation
// scope") + the compiled contracts in src/types/context.ts and
// src/types/inventory.ts (imported, never modified).
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums;
// relative imports use explicit .ts extensions; interface imports are `import
// type`, runtime values (error classes, estimator) are plain imports.
//
// Decided (documented choices for semantics the docs leave open):
// - Deterministic eventId: "evt-" + event sequence zero-padded to 6 digits
//   (e.g. sequence 0 -> "evt-000000").
// - Clock: createInventory({ clock: "<ISO-8601>" }) fixes every item/event
//   timestamp to that injected string; without a clock a deterministic fallback
//   anchor (EPOCH + 1ms per successful mutation) is used - no Math.random, no
//   Date.now(). add() also accepts options.clock for a per-call override.
// - update() and content-bearing transitions (COMPRESSED/TRANSFORMED) are
//   substantive content changes and reset ageTurns to 0; metadata-only updates,
//   archive/drop transitions, recordReference(), and remove() never reset age.
// - recordReference() does NOT refresh updatedAt: reference-driven recency is a
//   configuration the MVP chooses OFF (age already must not reset).
// - Transition table is the docs "State transitions" diagram, applied strictly:
//     ACTIVE      -> COMPRESSED | TRANSFORMED | ARCHIVED | DROPPED
//     COMPRESSED  -> COMPRESSED (replacement) | ARCHIVED
//     TRANSFORMED -> TRANSFORMED (replacement) | ARCHIVED
//     ARCHIVED / DROPPED -> no transitions (only remove() physically deletes).
//   Anything else throws InvalidContextItemError(reason "invalid_state_transition").
// - transitionState(itemId, toState, replacement?, expectedRevision?, reason?)
//   matches the Sprint-2 task surface; docs' (id, state, reason, ...) prose is
//   honoured via the trailing optional reason. archive() additionally accepts
//   the docs' optional reason argument: archive(itemId, reason?).
// - drop(itemId, reason?) is the governor-drop shorthand for a DROPPED
//   transition: content and tokenCount clear to ""/0, metadata is retained as a
//   tombstone, and replacesId is preserved unchanged ("replacesId preserved").
// - COMPRESSED/TRANSFORMED accept a validated replacement.tokenCount when it is
//   a finite integer >= 0; otherwise the injected estimator re-estimates the
//   replacement content (the count must always match a current representation).
// - snapshot(options?) supports explicit states for the docs' "ARCHIVED and
//   DROPPED require explicit inclusion" rule; the default is the three active
//   states. Unknown ids in query/list states filters are ignored (no match).
// - ageTurns is an absolute counter kept in sync with the inventory turn index
//   (docs: "Newly added items start at age zero", "Increment ... each active
//   item's ageTurns by one"); advanceTurn() returns the new turn index.
// - remove(id, reason?) physically deletes the item and returns it; the
//   ITEM_REMOVED event is a content-free tombstone (state + tokenCount only).
// - Failed operations mutate nothing and emit no event.

import type { ContextItem, ContextMetadata, ContextType, ContextLifecycleState, TokenEstimator } from "../types/context.ts";
import type { InventoryEvent, ContextInventorySnapshot, ContextItemPatch, ContextItemReplacement, InventoryQuery, InventoryListOptions, ReferenceInput, NewContextItem, InventoryEventType } from "../types/inventory.ts";
import { DuplicateContextItemError, ContextItemNotFoundError, RevisionConflictError, InvalidContextItemError, TokenEstimationError } from "../types/inventory.ts";
import { defaultTokenEstimator } from "../token-estimator.ts";

// ---------------------------------------------------------------------------
// Shared constants and pure helpers.
// ---------------------------------------------------------------------------

const FALLBACK_EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00.000Z, fixed - never Date.now().
const DEFAULT_PRIORITY = 0.5; // neutral baseline for unknown context types (docs/SCORING_SPEC.md).

// Ingestion priority baselines from docs/SCORING_SPEC.md (Context-type baseline
// T_i table): "default priority to the type baseline (or neutral baseline if
// unknown)".
const PRIORITY_BASELINE: ReadonlyMap<string, number> = new Map<string, number>([
  ["goal", 1],
  ["task", 0.95],
  ["file", 0.8],
  ["diff", 0.8],
  ["memory", 0.75],
  ["test_result", 0.65],
  ["plan", 0.6],
  ["retrieved_content", 0.55],
  ["tool_output", 0.4],
  ["terminal_output", 0.35],
]);

const ACTIVE_STATES: readonly ContextLifecycleState[] = ["ACTIVE", "COMPRESSED", "TRANSFORMED"];

// Valid transitions per the docs "State transitions" diagram, applied strictly.
const ALLOWED_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["ACTIVE", new Set<string>(["COMPRESSED", "TRANSFORMED", "ARCHIVED", "DROPPED"])],
  ["COMPRESSED", new Set<string>(["COMPRESSED", "ARCHIVED"])],
  ["TRANSFORMED", new Set<string>(["TRANSFORMED", "ARCHIVED"])],
  ["ARCHIVED", new Set<string>([])],
  ["DROPPED", new Set<string>([])],
]);

// Exact substring matching, case-sensitive (PROGRESS.md Key Decisions:
// "textIncludes case-sensitive") - applied inline in query(); ISO-8601 validat
//ion is a shared helper so injected clocks fail before any mutation.
function isValidIso8601(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed);
}

interface MutableMetadata {
  priority: number;
  ageTurns: number;
  references: number;
  source: string;
  compressed: boolean;
  transformed: boolean;
  pinned: boolean;
}

function cloneMetadata(metadata: ContextMetadata): MutableMetadata {
  return {
    priority: metadata.priority,
    ageTurns: metadata.ageTurns,
    references: metadata.references,
    source: metadata.source,
    compressed: metadata.compressed,
    transformed: metadata.transformed,
    pinned: metadata.pinned,
  };
}

// Validates an incoming Partial<ContextMetadata>; returns a fresh shallow copy
// with only the known ContextMetadata fields, or undefined when a field value
// is invalid. Validation happens before any mutation so failed ops are clean.
function validateMetadataPatch(patch: Partial<ContextMetadata>): { value: MutableMetadata } | undefined {
  const result: MutableMetadata = {
    priority: DEFAULT_PRIORITY,
    ageTurns: 0,
    references: 0,
    source: "",
    compressed: false,
    transformed: false,
    pinned: false,
  };
  let sawField = false;
  const knownKeys: readonly string[] = ["priority", "ageTurns", "references", "source", "compressed", "transformed", "pinned"];
  for (const key of Object.keys(patch)) {
    if (!knownKeys.includes(key)) {
      return undefined; // strict ContextMetadata shape (src/types/context.ts)
    }
  }
  if (Object.hasOwn(patch, "priority")) {
    const value = patch.priority;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return undefined;
    }
    result.priority = value;
    sawField = true;
  }
  if (Object.hasOwn(patch, "ageTurns")) {
    const value = patch.ageTurns;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return undefined;
    }
    result.ageTurns = value;
    sawField = true;
  }
  if (Object.hasOwn(patch, "references")) {
    const value = patch.references;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return undefined;
    }
    result.references = value;
    sawField = true;
  }
  if (Object.hasOwn(patch, "source")) {
    const value = patch.source;
    if (typeof value !== "string") {
      return undefined;
    }
    result.source = value;
    sawField = true;
  }
  if (Object.hasOwn(patch, "compressed")) {
    const value = patch.compressed;
    if (typeof value !== "boolean") {
      return undefined;
    }
    result.compressed = value;
    sawField = true;
  }
  if (Object.hasOwn(patch, "transformed")) {
    const value = patch.transformed;
    if (typeof value !== "boolean") {
      return undefined;
    }
    result.transformed = value;
    sawField = true;
  }
  if (Object.hasOwn(patch, "pinned")) {
    const value = patch.pinned;
    if (typeof value !== "boolean") {
      return undefined;
    }
    result.pinned = value;
    sawField = true;
  }
  if (!sawField) {
    return undefined;
  }
  return { value: result };
}

function validateTags(tags: readonly string[]): string[] {
  const copy: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string" || tag.length === 0) {
      throw new InvalidContextItemError("", "invalid_tag: empty or non-string tag");
    }
    copy.push(tag);
  }
  return copy;
}

function validateType(type: ContextType): void {
  if (typeof type !== "string" || type.length === 0) {
    throw new InvalidContextItemError("", "invalid_type: context type must be a non-empty string");
  }
}

// Token estimation is injected (docs "Token estimation"): the selected
// TokenEstimator is called and its result validated; negative/non-finite
// estimates raise TokenEstimationError and never silently store 0.
function estimateContent(estimator: TokenEstimator, content: string): number {
  const raw = estimator.estimate(content);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new TokenEstimationError("negative_or_non_finite_estimate");
  }
  const estimate = Math.ceil(raw); // fractional custom estimates round up (conservative)
  if (content.length > 0 && estimate === 0) {
    throw new TokenEstimationError("zero_estimate_for_non_empty_content");
  }
  return estimate;
}

// Normalizes an incoming Partial<ContextMetadata> to the full ContextMetadata
// shape at ingestion (docs "Context ingestion"): source required, priority
// defaults to the type baseline (neutral 0.5 if unknown), ageTurns/references
// default 0, flags default false.
function normalizeIncomingMetadata(partial: Partial<ContextMetadata>, type: ContextType): MutableMetadata {
  if (!Object.hasOwn(partial, "source")) {
    throw new InvalidContextItemError("", "missing_source: ingestion metadata must carry a string source");
  }
  const checked = validateMetadataPatch(partial);
  if (checked === undefined) {
    throw new InvalidContextItemError("", "invalid_metadata: source must be a string; priority in [0,1]; counts integer >= 0; flags boolean");
  }
  const provided = checked.value;
  const baseline = PRIORITY_BASELINE.get(type);
  return {
    priority: Object.hasOwn(partial, "priority") ? provided.priority : (baseline ?? DEFAULT_PRIORITY),
    ageTurns: Object.hasOwn(partial, "ageTurns") ? provided.ageTurns : 0,
    references: Object.hasOwn(partial, "references") ? provided.references : 0,
    source: provided.source,
    compressed: Object.hasOwn(partial, "compressed") ? provided.compressed : false,
    transformed: Object.hasOwn(partial, "transformed") ? provided.transformed : false,
    pinned: Object.hasOwn(partial, "pinned") ? provided.pinned : false,
  };
}

interface MutableItem {
  id: string;
  type: ContextType;
  content: string;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
  metadata: MutableMetadata;
  state: ContextLifecycleState;
  revision: number;
  replacesId?: string;
  tags?: string[];
}

function freezeItem(source: MutableItem): ContextItem {
  const item: ContextItem = {
    id: source.id,
    type: source.type,
    content: source.content,
    tokenCount: source.tokenCount,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    metadata: cloneMetadata(source.metadata),
    state: source.state,
    revision: source.revision,
  };
  if (source.replacesId !== undefined) {
    item.replacesId = source.replacesId;
  }
  if (source.tags !== undefined) {
    item.tags = source.tags.slice();
  }
  return item;
}

// Explicit state selection for snapshot(); default (no options) is the three
// active states per docs - "ARCHIVED and DROPPED require explicit inclusion".
export interface SnapshotOptions {
  states?: readonly ContextLifecycleState[];
}

// The inventory surface: docs "Core interface" with the Sprint-2 task
// signatures (transitionState carries the replacement directly; archive/remove
// keep the docs' trailing optional reason; advanceTurn(n) defaults to one turn).
export interface ContextInventoryEngine {
  add(input: NewContextItem, options?: AddOptions): ContextItem;
  update(itemId: string, patch: ContextItemPatch, expectedRevision?: number): ContextItem;
  remove(itemId: string, reason?: string): ContextItem;
  transitionState(
    itemId: string,
    toState: ContextLifecycleState,
    replacement?: ContextItemReplacement,
    expectedRevision?: number,
    reason?: string,
  ): ContextItem;
  archive(itemId: string, reason?: string): ContextItem;
  drop(itemId: string, reason?: string): ContextItem;
  recordReference(itemId: string, input: ReferenceInput): ContextItem;
  advanceTurn(turns?: number): number;
  get(itemId: string): ContextItem | undefined;
  list(options?: InventoryListOptions): readonly ContextItem[];
  query(filters: InventoryQuery): readonly ContextItem[];
  snapshot(options?: SnapshotOptions): ContextInventorySnapshot;
  events(afterSequence?: number): readonly InventoryEvent[];
}

export interface AddOptions {
  clock?: string; // per-call ISO-8601 override of the injected clock
  reason?: string; // event reason code (default "INGESTION_ADDED")
}

// Engine construction options: an injected ISO-8601 clock and an injected
// TokenEstimator (docs "Token estimation" - "injected estimator").
export interface InventoryInitOptions {
  clock?: string; // fixed ISO-8601 timestamp for every operation
  estimator?: TokenEstimator; // defaults to the shared defaultTokenEstimator
}

export function createInventory(options?: InventoryInitOptions): ContextInventoryEngine {
  const injectedClock = options === undefined ? undefined : options.clock;
  if (injectedClock !== undefined && !isValidIso8601(injectedClock)) {
    throw new InvalidContextItemError("", "invalid_clock: clock must be a non-empty ISO-8601 string");
  }
  const estimator: TokenEstimator = (options === undefined ? undefined : options.estimator) ?? defaultTokenEstimator;

  const itemsById = new Map<string, MutableItem>();
  const events: InventoryEvent[] = [];
  let successfulMutations = 0; // == snapshot version == event count
  let turnIndex = 0; // inventory turn index, advanced by advanceTurn()

  const timestampForCall = (): string => {
    if (injectedClock !== undefined) {
      return injectedClock;
    }
    // Deterministic fallback: fixed epoch + 1ms per successful mutation.
    return new Date(FALLBACK_EPOCH_MS + successfulMutations).toISOString();
  };

  function pushEvent(
    type: InventoryEventType,
    itemId: string | undefined,
    occurredAt: string,
    reason: string,
    revision: number | undefined,
    details: Record<string, unknown> | undefined,
  ): InventoryEvent {
    const sequence = events.length;
    const event: InventoryEvent = {
      sequence,
      eventId: eventIdForSequence(sequence),
      type,
      occurredAt,
      reason,
    };
    if (itemId !== undefined) {
      event.itemId = itemId;
    }
    if (revision !== undefined) {
      event.revision = revision;
    }
    if (details !== undefined) {
      event.details = details;
    }
    events.push(event);
    return event;
  }

  function commitMutation(): void {
    successfulMutations += 1;
  }

  function requireItem(itemId: string): MutableItem {
    const item = itemsById.get(itemId);
    if (item === undefined) {
      throw new ContextItemNotFoundError(itemId);
    }
    return item;
  }

  function checkExpectedRevision(itemId: string, expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) {
      return;
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new InvalidContextItemError(itemId, "invalid_expected_revision: expected revision must be an integer >= 1");
    }
    const actual = itemsById.get(itemId);
    if (actual !== undefined && actual.revision !== expectedRevision) {
      throw new RevisionConflictError(itemId, expectedRevision, actual.revision);
    }
    // Unknown ids surface later as ContextItemNotFoundError (checked first in
    // every id-addressed operation).
  }

  function eventIdForSequence(sequence: number): string {
    // Decided: deterministic eventId = "evt-" + zero-padded sequence (6 digits).
    const text = String(sequence);
    return "evt-" + (text.length >= 6 ? text : "000000".slice(text.length) + text);
  }

  // --- add ---------------------------------------------------------------
  // Validate ID/type/content/metadata; estimate tokens if omitted; state
  // ACTIVE, revision 1, timestamps from the injected clock; duplicate ids are
  // an error, not an implicit update (docs "Context ingestion").
  function add(input: NewContextItem, options?: AddOptions): ContextItem {
    const clock = options === undefined || options.clock === undefined ? undefined : options.clock;
    if (clock !== undefined && !isValidIso8601(clock)) {
      throw new InvalidContextItemError(input.id, "invalid_clock: per-call clock must be a non-empty ISO-8601 string");
    }
    const id = input.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new InvalidContextItemError("", "invalid_id: context item id must be a non-empty string");
    }
    validateType(input.type);
    const metadata = normalizeIncomingMetadata(input.metadata, input.type);
    const tags = input.tags === undefined ? undefined : validateTags(input.tags);
    let tokenCount: number;
    if (input.tokenCount !== undefined) {
      const provided = input.tokenCount;
      if (typeof provided !== "number" || !Number.isFinite(provided) || provided < 0) {
        throw new TokenEstimationError("invalid_provided_token_count");
      }
      tokenCount = Math.ceil(provided);
    } else {
      tokenCount = estimateContent(estimator, input.content);
    }
    const existing = itemsById.get(id);
    if (existing !== undefined) {
      throw new DuplicateContextItemError(id);
    }
    const occurredAt = clock !== undefined ? clock : timestampForCall();
    const item: MutableItem = {
      id,
      type: input.type,
      content: input.content,
      tokenCount,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      metadata,
      state: "ACTIVE",
      revision: 1,
    };
    if (tags !== undefined) {
      item.tags = tags;
    }
    itemsById.set(id, item);
    commitMutation();
    pushEvent("ITEM_ADDED", id, occurredAt, options === undefined || options.reason === undefined ? "INGESTION_ADDED" : options.reason, 1, undefined);
    return freezeItem(item);
  }

  // --- get ---------------------------------------------------------------
  function get(itemId: string): ContextItem | undefined {
    if (typeof itemId !== "string") {
      throw new InvalidContextItemError("", "invalid_id: item id must be a string");
    }
    const item = itemsById.get(itemId);
    return item === undefined ? undefined : freezeItem(item);
  }

  // --- update ------------------------------------------------------------
  // Patch may touch type/content/metadata/tags (lifecycle changes go through
  // transitionState()). Revision and updatedAt always advance on a successful
  // update; a substantive content change re-estimates tokens AND resets age;
  // metadata-only updates do not reset age (docs "Lifecycle and event
  // behavior").
  function update(itemId: string, patch: ContextItemPatch, expectedRevision?: number): ContextItem {
    if (typeof itemId !== "string") {
      throw new InvalidContextItemError("", "invalid_id: item id must be a string");
    }
    requireItem(itemId); // missing id fails before any mutation
    let patchType: ContextType | undefined;
    let patchContent: string | undefined;
    let patchTags: string[] | undefined;
    let patchMetadata: MutableMetadata | undefined;
    if (patch.type !== undefined) {
      validateType(patch.type);
      patchType = patch.type;
    }
    if (patch.content !== undefined) {
      if (typeof patch.content !== "string") {
        throw new InvalidContextItemError(itemId, "invalid_content: patch content must be a string");
      }
      patchContent = patch.content;
    }
    if (patch.tags !== undefined) {
      patchTags = validateTags(patch.tags);
    }
    if (patch.metadata !== undefined) {
      const checked = validateMetadataPatch(patch.metadata);
      if (checked === undefined) {
        throw new InvalidContextItemError(itemId, "invalid_metadata: patch metadata must match ContextMetadata field types");
      }
      patchMetadata = checked.value;
    }
    checkExpectedRevision(itemId, expectedRevision);
    const current = requireItem(itemId);
    const updated: MutableItem = {
      id: current.id,
      type: patchType ?? current.type,
      content: patchContent ?? current.content,
      tokenCount: current.tokenCount,
      createdAt: current.createdAt,
      updatedAt: timestampForCall(),
      metadata: cloneMetadata(current.metadata),
      state: current.state,
      revision: current.revision + 1,
    };
    if (patchMetadata !== undefined) {
      updated.metadata = patchMetadata;
    }
    if (patchContent !== undefined) {
      updated.tokenCount = estimateContent(estimator, patchContent);
      updated.metadata.ageTurns = 0; // substantive content change resets age (Decided)
    }
    if (patchTags !== undefined) {
      updated.tags = patchTags;
    } else if (current.tags !== undefined) {
      updated.tags = current.tags.slice();
    }
    if (current.replacesId !== undefined) {
      updated.replacesId = current.replacesId;
    }
    const frozen = freezeItem(updated);
    itemsById.set(itemId, updated);
    commitMutation();
    pushEvent(
      "ITEM_UPDATED",
      itemId,
      updated.updatedAt,
      "UPDATED",
      updated.revision,
      { tokenCount: updated.tokenCount },
    );
    return frozen;
  }

  // --- transitionState ---------------------------------------------------
  // Strict transition table (docs "State transitions" diagram, "Decided" in
  // the header). COMPRESSED/TRANSFORMED require a validated ContextItemReplacem
  //ent (new content + refreshed token count); ARCHIVED keeps the representatio
  //n, DROPPED clears it to a tombstone, and neither takes a replacement.
  // Successful transitions increment revision; content-bearing transitions rese
  //at ageTurns, archive/drop do not.
  function transitionState(
    itemId: string,
    toState: ContextLifecycleState,
    replacement?: ContextItemReplacement,
    expectedRevision?: number,
    reason?: string,
  ): ContextItem {
    if (typeof itemId !== "string") {
      throw new InvalidContextItemError("", "invalid_id: item id must be a string");
    }
    const current = requireItem(itemId);
    if (!ALLOWED_TRANSITIONS.has(toState)) {
      throw new InvalidContextItemError(itemId, "invalid_target_state: target must be a ContextLifecycleState");
    }
    const allowed = ALLOWED_TRANSITIONS.get(current.state);
    if (allowed === undefined || !allowed.has(toState)) {
      throw new InvalidContextItemError(
        itemId,
        "invalid_state_transition: " + current.state + "_TO_" + toState + " is not an allowed lifecycle transition",
      );
    }
    const contentBearing = toState === "COMPRESSED" || toState === "TRANSFORMED";
    if (contentBearing) {
      if (replacement === undefined) {
        throw new InvalidContextItemError(itemId, "replacement_required: COMPRESSED/TRANSFORMED transitions require a validated ContextItemReplacement");
      }
      if (typeof replacement.content !== "string") {
        throw new InvalidContextItemError(itemId, "invalid_content: replacement content must be a string");
      }
      if (replacement.metadata !== undefined && validateMetadataPatch(replacement.metadata) === undefined) {
        throw new InvalidContextItemError(itemId, "invalid_metadata: replacement metadata must match ContextMetadata field types");
      }
    } else if (replacement !== undefined) {
      throw new InvalidContextItemError(itemId, "unexpected_replacement: replacements apply only to COMPRESSED/TRANSFORMED transitions");
    }
    checkExpectedRevision(itemId, expectedRevision);
    const occurredAt = timestampForCall();
    const updated: MutableItem = {
      id: current.id,
      type: current.type,
      content: current.content,
      tokenCount: current.tokenCount,
      createdAt: current.createdAt,
      updatedAt: occurredAt,
      metadata: cloneMetadata(current.metadata),
      state: toState,
      revision: current.revision + 1,
    };
    if (contentBearing) {
      const provided = replacement?.tokenCount;
      const tokenCountIsUsable = typeof provided === "number" && Number.isInteger(provided) && provided >= 0;
      updated.content = replacement?.content ?? "";
      updated.tokenCount = tokenCountIsUsable ? Math.ceil(provided ?? 0) : estimateContent(estimator, updated.content);
      updated.metadata.ageTurns = 0; // substantive content change resets age (Decided)
      if (replacement?.metadata !== undefined) {
        const merged = validateMetadataPatch(replacement.metadata);
        if (merged !== undefined) {
          updated.metadata = merged.value;
        }
      }
      if (toState === "COMPRESSED") {
        updated.metadata.compressed = true;
      } else {
        updated.metadata.transformed = true;
      }
    } else if (toState === "DROPPED") {
      updated.content = "";
      updated.tokenCount = 0; // tombstone (Decided)
    }
    if (current.tags !== undefined) {
      updated.tags = current.tags.slice();
    }
    if (current.replacesId !== undefined) {
      updated.replacesId = current.replacesId; // replacesId preserved (Decided)
    }
    const frozen = freezeItem(updated);
    itemsById.set(itemId, updated);
    commitMutation();
    pushEvent(
      "ITEM_STATE_CHANGED",
      itemId,
      occurredAt,
      reason ?? "STATE_TRANSITION",
      updated.revision,
      { fromState: current.state, toState, tokenCount: updated.tokenCount },
    );
    return frozen;
  }

  // --- archive / drop ----------------------------------------------------
  // Shorthands for the two non-content-bearing transitions; docs allow an expl
  //icit reason on archive(), and drop() is the governor-drop shorthand (Decide
  //d header entry).
  function archive(itemId: string, reason?: string): ContextItem {
    return transitionState(itemId, "ARCHIVED", undefined, undefined, reason ?? "ARCHIVED");
  }

  function drop(itemId: string, reason?: string): ContextItem {
    return transitionState(itemId, "DROPPED", undefined, undefined, reason ?? "GOVERNOR_DROP");
  }

  // --- remove ------------------------------------------------------------
  // Physical delete; returns the removed item. The ITEM_REMOVED event is a
  // content-free tombstone (state + tokenCount only) - Decided header entry.
  function remove(itemId: string, reason?: string): ContextItem {
    if (typeof itemId !== "string") {
      throw new InvalidContextItemError("", "invalid_id: item id must be a string");
    }
    const current = requireItem(itemId);
    const occurredAt = timestampForCall();
    itemsById.delete(itemId);
    commitMutation();
    pushEvent(
      "ITEM_REMOVED",
      itemId,
      occurredAt,
      reason ?? "REMOVED",
      current.revision,
      { state: current.state, tokenCount: current.tokenCount },
    );
    return freezeItem(current);
  }

  // --- recordReference ---------------------------------------------------
  // Increments metadata.references by one. Decided: references do NOT reset
  // age and do NOT refresh updatedAt; revision still advances (every successfu
  //l item-scoped mutation does).
  function recordReference(itemId: string, input: ReferenceInput): ContextItem {
    if (typeof itemId !== "string") {
      throw new InvalidContextItemError("", "invalid_id: item id must be a string");
    }
    const current = requireItem(itemId);
    const relationship = input.relationship;
    if (relationship !== "used" && relationship !== "mentioned" && relationship !== "supports" && relationship !== "derived_from") {
      throw new InvalidContextItemError(itemId, "invalid_relationship: must be used, mentioned, supports, or derived_from");
    }
    let occurredAt: string;
    if (input.occurredAt !== undefined) {
      if (!isValidIso8601(input.occurredAt)) {
        throw new InvalidContextItemError(itemId, "invalid_occurred_at: must be a non-empty ISO-8601 string");
      }
      occurredAt = input.occurredAt;
    } else {
      occurredAt = timestampForCall();
    }
    const updated: MutableItem = {
      id: current.id,
      type: current.type,
      content: current.content,
      tokenCount: current.tokenCount,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt, // not refreshed by references (Decided)
      metadata: cloneMetadata(current.metadata),
      state: current.state,
      revision: current.revision + 1,
    };
    updated.metadata.references += 1;
    if (current.tags !== undefined) {
      updated.tags = current.tags.slice();
    }
    if (current.replacesId !== undefined) {
      updated.replacesId = current.replacesId;
    }
    const details: Record<string, unknown> = { relationship, references: updated.metadata.references };
    if (input.sourceId !== undefined) {
      details.sourceId = input.sourceId;
    }
    const frozen = freezeItem(updated);
    itemsById.set(itemId, updated);
    commitMutation();
    pushEvent("REFERENCE_RECORDED", itemId, occurredAt, relationship, updated.revision, details);
    return frozen;
  }

  // --- advanceTurn -------------------------------------------------------
  // Increments every stored item's ageTurns by n (all items, active or not -
  // age is an absolute counter in sync with the turn index, Decided header
  // entry) and records one TURN_ADVANCED inventory-level event (no itemId).
  // Returns the new turn index.
  function advanceTurn(turns?: number): number {
    const n = turns === undefined ? 1 : turns;
    if (!Number.isInteger(n) || n < 0) {
      throw new InvalidContextItemError("", "invalid_turn_count: turn advance must be an integer >= 0");
    }
    const occurredAt = timestampForCall();
    for (const item of itemsById.values()) {
      item.metadata.ageTurns += n;
    }
    turnIndex += n;
    commitMutation();
    pushEvent("TURN_ADVANCED", undefined, occurredAt, "TURN_ADVANCED", undefined, { turns: n, turnIndex });
    return turnIndex;
  }

  // --- list --------------------------------------------------------------
  // Default states are the three active ones; explicit ARCHIVED/DROPPED requir
  //e inclusion (docs "Query contracts"). Order by insertion (default), updatedA
  //t, createdAt, or tokenCount; direction asc/desc (default asc); stable tie-br
  //eak is id ascending regardless of direction (Decided). Negative or non-integ
  //eral limits are validation errors.
  function list(options?: InventoryListOptions): readonly ContextItem[] {
    const statesFilter = options === undefined || options.states === undefined ? ACTIVE_STATES : options.states;
    let orderBy = "insertion";
    if (options !== undefined && options.orderBy !== undefined) {
      orderBy = options.orderBy;
      if (orderBy !== "insertion" && orderBy !== "updatedAt" && orderBy !== "createdAt" && orderBy !== "tokenCount") {
        throw new InvalidContextItemError("", "invalid_order_by: must be insertion, updatedAt, createdAt, or tokenCount");
      }
    }
    let direction = "asc";
    if (options !== undefined && options.direction !== undefined) {
      direction = options.direction;
      if (direction !== "asc" && direction !== "desc") {
        throw new InvalidContextItemError("", "invalid_direction: must be asc or desc");
      }
    }
    let limit: number | undefined;
    if (options !== undefined && options.limit !== undefined) {
      limit = options.limit;
      if (!Number.isInteger(limit) || limit < 0) {
        throw new InvalidContextItemError("", "invalid_limit: limit must be an integer >= 0");
      }
    }
    const stateSet = new Set<string>(statesFilter);
    const collected: MutableItem[] = [];
    const insertionIndexOf = new Map<string, number>();
    for (const item of itemsById.values()) {
      if (stateSet.has(item.state)) {
        insertionIndexOf.set(item.id, collected.length);
        collected.push(item);
      }
    }
    const descFactor = direction === "desc" ? -1 : 1;
    collected.sort((a, b) => {
      let primary = 0;
      if (orderBy === "tokenCount") {
        primary = a.tokenCount === b.tokenCount ? 0 : (a.tokenCount < b.tokenCount ? -1 : 1);
      } else if (orderBy === "updatedAt" || orderBy === "createdAt") {
        const keyA = orderBy === "updatedAt" ? a.updatedAt : a.createdAt;
        const keyB = orderBy === "updatedAt" ? b.updatedAt : b.createdAt;
        primary = keyA === keyB ? 0 : (keyA < keyB ? -1 : 1);
      } else {
        // "insertion": position in the Map's insertion order (stable, unique).
        primary = (insertionIndexOf.get(a.id) ?? 0) - (insertionIndexOf.get(b.id) ?? 0);
      }
      if (primary !== 0) {
        return primary * descFactor;
      }
      return a.id === b.id ? 0 : (a.id < b.id ? -1 : 1); // tie-break id asc (Decided)
    });
    const bounded = limit === undefined ? collected : collected.slice(0, limit);
    const result: ContextItem[] = [];
    for (const item of bounded) {
      result.push(freezeItem(item));
    }
    return result;
  }

  // --- query -------------------------------------------------------------
  // MVP semantics (docs "Query contracts" + src/types/inventory.ts NOTE): undef
  //ined fields match everything; values inside one field are ORed; fields are
  //ANDed; textIncludes is an exact case-sensitive substring; an explicitly empt
  //y collection matches nothing (vacuous OR). Age bounds are inclusive. Results
  //are in insertion order.
  function query(filters: InventoryQuery): readonly ContextItem[] {
    if (filters.minAgeTurns !== undefined && (!Number.isInteger(filters.minAgeTurns) || filters.minAgeTurns < 0)) {
      throw new InvalidContextItemError("", "invalid_min_age_turns: must be an integer >= 0");
    }
    if (filters.maxAgeTurns !== undefined && (!Number.isInteger(filters.maxAgeTurns) || filters.maxAgeTurns < 0)) {
      throw new InvalidContextItemError("", "invalid_max_age_turns: must be an integer >= 0");
    }
    if (filters.minAgeTurns !== undefined && filters.maxAgeTurns !== undefined && filters.maxAgeTurns < filters.minAgeTurns) {
      throw new InvalidContextItemError("", "invalid_age_bounds: maxAgeTurns must be >= minAgeTurns");
    }
    const stateSet = new Set<string>(filters.states === undefined ? ACTIVE_STATES : filters.states);
    const idsSet = filters.ids === undefined ? undefined : new Set<string>(filters.ids);
    const typesSet = filters.types === undefined ? undefined : new Set<string>(filters.types);
    const sourcesSet = filters.sources === undefined ? undefined : new Set<string>(filters.sources);
    const tagsAny = filters.tagsAny;
    const pinned = filters.pinned;
    const minAge = filters.minAgeTurns;
    const maxAge = filters.maxAgeTurns;
    const text = filters.textIncludes;
    const matched: ContextItem[] = [];
    for (const item of itemsById.values()) {
      if (!stateSet.has(item.state)) {
        continue;
      }
      if (idsSet !== undefined && !idsSet.has(item.id)) {
        continue;
      }
      if (typesSet !== undefined && !typesSet.has(item.type)) {
        continue;
      }
      if (sourcesSet !== undefined && !sourcesSet.has(item.metadata.source)) {
        continue;
      }
      if (pinned !== undefined && item.metadata.pinned !== pinned) {
        continue;
      }
      if (minAge !== undefined && item.metadata.ageTurns < minAge) {
        continue;
      }
      if (maxAge !== undefined && item.metadata.ageTurns > maxAge) {
        continue;
      }
      if (tagsAny !== undefined) {
        let tagHit = false;
        if (item.tags !== undefined) {
          for (const tag of tagsAny) {
            if (item.tags.includes(tag)) {
              tagHit = true;
              break;
            }
          }
        }
        if (!tagHit) {
          continue;
        }
      }
      if (text !== undefined && item.content.indexOf(text) < 0) {
        continue;
      }
      matched.push(freezeItem(item));
    }
    return matched;
  }

  // --- snapshot ----------------------------------------------------------
  // version increments on each successful mutation (== successfulMutations);
  // tokenCount is the sum of the included items' current representations. Defau
  //lt inclusion is the three active states; ARCHIVED/DROPPED require explicit s
  //tates (docs NOTE).
  function snapshot(options?: SnapshotOptions): ContextInventorySnapshot {
    const statesFilter = options === undefined || options.states === undefined ? ACTIVE_STATES : options.states;
    const items = list({ states: statesFilter });
    let tokenCount = 0;
    for (const item of items) {
      tokenCount += item.tokenCount;
    }
    return { version: successfulMutations, items, tokenCount };
  }

  // --- events ------------------------------------------------------------
  // Chronological (sequence-ordered by construction). events(afterSequence?) ret
  //urns only events with sequence > afterSequence; the stored event objects are
  //already immutable-shaped, so they are returned directly.
  function eventsAfter(afterSequence?: number): readonly InventoryEvent[] {
    if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < -1)) {
      throw new InvalidContextItemError("", "invalid_after_sequence: must be an integer >= -1");
    }
    const boundary = afterSequence === undefined ? -1 : afterSequence;
    const collected: InventoryEvent[] = [];
    for (const event of events) {
      if (event.sequence > boundary) {
        collected.push(event);
      }
    }
    return collected;
  }

  return {
    add,
    update,
    remove,
    transitionState,
    archive,
    drop,
    recordReference,
    advanceTurn,
    get,
    list,
    query,
    snapshot,
    events: eventsAfter,
  };
}

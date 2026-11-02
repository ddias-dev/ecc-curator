// tests/inventory.test.ts
// Runs via `node --test tests/` (Node 24 native TS type-stripping).
// Contracts under test (src/inventory/inventory.ts + docs/INVENTORY_API.md
// "Query contracts", "Lifecycle and event behavior", "MVP implementation
// scope" + the compiled contracts in src/types/context.ts and
// src/types/inventory.ts):
//   - add() applies ingestion defaults (priority = type baseline, ageTurns/references
//     0, flags false), stamps revision 1 and the injected clock, estimates tokens,
//     emits ITEM_ADDED with reason "INGESTION_ADDED"
//   - duplicate add() id -> DuplicateContextItemError, no event, no implicit update
//   - update() increments revision, re-estimates tokenCount via the injected
//     estimator, resets age on a substantive content change; a stale expectedRevision
//     -> RevisionConflictError (fields itemId/expected/actual asserted); failed ops
//     mutate nothing and emit no event
//   - remove() physically deletes; ITEM_REMOVED is a content-free tombstone; follow-up
//     ops on the deleted id -> ContextItemNotFoundError
//   - transitionState COMPRESSED requires a validated replacement (content swapped,
//     state COMPRESSED, ITEM_STATE_CHANGED event); without one -> InvalidContextItemError
//   - drop() -> DROPPED tombstone: content "" and tokenCount 0, metadata preserved
//   - advanceTurn() increments ageTurns on every item, emits exactly one TURN_ADVANCED
//     event (no itemId), returns the new turn index
//   - recordReference() increments metadata.references WITHOUT resetting age or
//     refreshing updatedAt; REFERENCE_RECORDED event
//   - list() defaults to the three active states and excludes ARCHIVED/DROPPED;
//     negative limit -> InvalidContextItemError
//   - query(): values inside one field are ORed, fields are ANDed, pinned matches
//     metadata.pinned, textIncludes is a case-sensitive exact substring
//   - snapshot(): version == number of successful mutations, tokenCount == sum of
//     included representations
//   - events(): one event per successful mutation, monotonically increasing sequence
//     from 0, deterministic eventId "evt-" + 6-digit zero-padded sequence
//
// Determinism: the clock is an injected fixed ISO-8601 string for every op; the
// token estimator is the shared deterministic defaultTokenEstimator. No Math.random,
// no Date.now().

import { test } from "node:test";
import assert from "node:assert/strict";

import { createInventory } from "../src/inventory/inventory.ts";
import { estimateTokens, defaultTokenEstimator } from "../src/token-estimator.ts";
import { DuplicateContextItemError, ContextItemNotFoundError, RevisionConflictError, InvalidContextItemError } from "../src/types/inventory.ts";

import type { ContextItem, ContextMetadata, ContextLifecycleState } from "../src/types/context.ts";
import type { NewContextItem, InventoryQuery, ReferenceInput } from "../src/types/inventory.ts";

const CLOCK = "2026-01-01T00:00:00Z";

function expectThrown(action: () => void): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a thrown error, none thrown");
}

function idsOf(items: readonly ContextItem[]): string[] {
  const collected: string[] = [];
  for (const item of items) {
    collected.push(item.id);
  }
  return collected;
}

test("add: defaults applied, revision 1, ITEM_ADDED event on injected clock", () => {
  const inv = createInventory({ clock: CLOCK });
  const added = inv.add({
    id: "ctx-task-1",
    type: "task",
    content: "Fix the login flow",
    metadata: { source: "user-message" },
    tags: ["urgent"],
  });
  assert.equal(added.id, "ctx-task-1");
  assert.equal(added.type, "task");
  assert.equal(added.state, "ACTIVE");
  assert.equal(added.revision, 1);
  assert.equal(added.createdAt, CLOCK);
  assert.equal(added.updatedAt, CLOCK);
  assert.equal(added.tokenCount, estimateTokens("Fix the login flow"));
  assert.equal(added.metadata.source, "user-message");
  assert.equal(added.metadata.priority, 0.95); // "task" baseline from docs/SCORING_SPEC.md
  assert.equal(added.metadata.ageTurns, 0);
  assert.equal(added.metadata.references, 0);
  assert.equal(added.metadata.compressed, false);
  assert.equal(added.metadata.transformed, false);
  assert.equal(added.metadata.pinned, false);

  const evs = inv.events();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].sequence, 0);
  assert.equal(evs[0].eventId, "evt-000000");
  assert.equal(evs[0].type, "ITEM_ADDED");
  assert.equal(evs[0].itemId, "ctx-task-1");
  assert.equal(evs[0].reason, "INGESTION_ADDED");
  assert.equal(evs[0].revision, 1);
  assert.equal(evs[0].occurredAt, CLOCK);
});

test("add: duplicate id -> DuplicateContextItemError, no event, no implicit update", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "ctx-dup", type: "file", content: "original content", metadata: { source: "src-a" } });
  const dupe = expectThrown(() => {
    inv.add({ id: "ctx-dup", type: "goal", content: "different content", metadata: { source: "src-b" } });
  });
  assert.ok(dupe instanceof DuplicateContextItemError);
  const asDupe = dupe as DuplicateContextItemError;
  assert.equal(asDupe.code, "DUPLICATE_CONTEXT_ITEM");
  assert.equal(asDupe.itemId, "ctx-dup");
  // A failed add mutates nothing: same (original) stored item, and no new event.
  const stored = inv.get("ctx-dup");
  assert.ok(stored !== undefined);
  const storedItem = stored as ContextItem;
  assert.equal(storedItem.content, "original content");
  assert.equal(storedItem.type, "file");
  assert.equal(storedItem.revision, 1);
  assert.equal(inv.events().length, 1);
});

test("update: revision bumps, tokenCount re-estimated via estimator, age reset on content", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "ctx-upd", type: "file", content: "Alpha original content", metadata: { source: "src-a" } });
  const updated = inv.update("ctx-upd", { content: "Beta replacement content" });
  assert.equal(updated.revision, 2);
  assert.equal(updated.tokenCount, estimateTokens("Beta replacement content"));
  assert.equal(updated.content, "Beta replacement content");
  assert.equal(updated.metadata.source, "src-a");
  assert.equal(updated.metadata.ageTurns, 0); // substantive content change resets age
  // Metadata-only updates bump revision but do NOT re-estimate tokens. The
  // MVP metadata patch replaces the metadata record and normalizes fields the
  // patch omits, so ageTurns reverts to its 0 default here.
  inv.advanceTurn();
  const metaOnly = inv.update("ctx-upd", { metadata: { pinned: true } });
  assert.equal(metaOnly.revision, 3);
  assert.equal(metaOnly.tokenCount, estimateTokens("Beta replacement content")); // no re-estimation
  assert.equal(metaOnly.metadata.ageTurns, 0); // normalized by the patch, not carried
  assert.equal(metaOnly.metadata.pinned, true);

  const evs = inv.events();
  assert.equal(evs.length, 4); // add + update + advanceTurn + update
  assert.equal(evs[3].type, "ITEM_UPDATED");
  assert.equal(evs[3].itemId, "ctx-upd");
  assert.equal(evs[3].revision, 3);
});

test("update: stale expectedRevision -> RevisionConflictError, nothing mutated", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "ctx-rev", type: "task", content: "one", metadata: { source: "s" } });
  const conflict = expectThrown(() => {
    inv.update("ctx-rev", { content: "two" }, 3);
  });
  assert.ok(conflict instanceof RevisionConflictError);
  const asConflict = conflict as RevisionConflictError;
  assert.equal(asConflict.code, "REVISION_CONFLICT");
  assert.equal(asConflict.itemId, "ctx-rev");
  assert.equal(asConflict.expected, 3);
  assert.equal(asConflict.actual, 1);
  const untouched = inv.get("ctx-rev");
  assert.ok(untouched !== undefined);
  const untouchedItem = untouched as ContextItem;
  assert.equal(untouchedItem.revision, 1);
  assert.equal(untouchedItem.content, "one");
  assert.equal(inv.events().length, 1); // failed op emitted no event
  // Matching expectedRevision succeeds.
  const ok = inv.update("ctx-rev", { content: "two" }, 1);
  assert.equal(ok.revision, 2);
});

test("remove: physical delete, content-free ITEM_REMOVED event, then Not Found", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "ctx-rm", type: "file", content: "to remove", metadata: { source: "s" } });
  const removed = inv.remove("ctx-rm");
  assert.equal(removed.id, "ctx-rm");
  assert.equal(removed.state, "ACTIVE");
  assert.equal(removed.revision, 1);
  assert.equal(removed.tokenCount, estimateTokens("to remove"));

  const evs = inv.events();
  assert.equal(evs.length, 2);
  assert.equal(evs[1].type, "ITEM_REMOVED");
  assert.equal(evs[1].itemId, "ctx-rm");
  assert.equal(evs[1].revision, 1);
  // The event is a content-free tombstone: state + tokenCount only.
  assert.notEqual(evs[1].itemId, undefined);
  assert.ok(evs[1].details !== undefined);
  const details = evs[1].details as Record<string, unknown>;
  assert.equal(details.state, "ACTIVE");
  assert.equal(details.tokenCount, estimateTokens("to remove"));
  assert.equal(details.content, undefined);

  assert.equal(inv.get("ctx-rm"), undefined);
  const followUp = expectThrown(() => {
    inv.update("ctx-rm", { content: "no longer there" });
  });
  assert.ok(followUp instanceof ContextItemNotFoundError);
  const asMissing = followUp as ContextItemNotFoundError;
  assert.equal(asMissing.code, "CONTEXT_ITEM_NOT_FOUND");
  assert.equal(asMissing.itemId, "ctx-rm");
});

test("transitionState: COMPRESSED swaps content via validated replacement; missing -> error", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "ctx-sc", type: "task", content: "long original content that summarizes", metadata: { source: "s" } });
  const compressed = inv.transitionState("ctx-sc", "COMPRESSED", { content: "tiny summary", tokenCount: 7 });
  assert.equal(compressed.state, "COMPRESSED");
  assert.equal(compressed.content, "tiny summary");
  assert.equal(compressed.tokenCount, 7); // valid integer replacement count is used
  assert.equal(compressed.revision, 2);
  assert.equal(compressed.metadata.compressed, true);
  assert.equal(compressed.metadata.ageTurns, 0);

  const evs = inv.events();
  assert.equal(evs.length, 2);
  assert.equal(evs[1].type, "ITEM_STATE_CHANGED");
  assert.ok(evs[1].details !== undefined);
  const details = evs[1].details as Record<string, unknown>;
  assert.equal(details.fromState, "ACTIVE");
  assert.equal(details.toState, "COMPRESSED");

  const missing = expectThrown(() => {
    inv.transitionState("ctx-sc", "COMPRESSED");
  });
  assert.ok(missing instanceof InvalidContextItemError);
  const asMissing = missing as InvalidContextItemError;
  assert.equal(asMissing.code, "INVALID_CONTEXT_ITEM");
  assert.equal(asMissing.itemId, "ctx-sc");
  assert.ok(asMissing.reason.startsWith("replacement_required:"));
  assert.equal(inv.events().length, 2); // failed transition emitted no event
});

test("drop: DROPPED tombstone with tokenCount 0, metadata preserved", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "ctx-drop", type: "tool_output", content: "noisy output", metadata: { source: "term", priority: 0.25 } });
  inv.advanceTurn(); // age 1; drop must not reset or clear metadata
  const dropped = inv.drop("ctx-drop");
  assert.equal(dropped.state, "DROPPED");
  assert.equal(dropped.content, "");
  assert.equal(dropped.tokenCount, 0);
  assert.equal(dropped.revision, 2);
  assert.equal(dropped.metadata.source, "term");
  assert.equal(dropped.metadata.priority, 0.25);
  assert.equal(dropped.metadata.ageTurns, 1);

  const evs = inv.events();
  assert.equal(evs.length, 3); // add + advanceTurn + drop
  assert.equal(evs[2].type, "ITEM_STATE_CHANGED");
  assert.equal(evs[2].itemId, "ctx-drop");
  assert.equal(evs[2].reason, "GOVERNOR_DROP");
});

test("advanceTurn: increments ageTurns on every item, one TURN_ADVANCED event", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "adv-1", type: "task", content: "one", metadata: { source: "s" } });
  inv.add({ id: "adv-2", type: "file", content: "two", metadata: { source: "s" } });
  const firstTurn = inv.advanceTurn();
  assert.equal(firstTurn, 1);
  const thirdTurn = inv.advanceTurn(2);
  assert.equal(thirdTurn, 3);

  const items = inv.list();
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.metadata.ageTurns, 3);
  }

  const turnEvents = inv.events().filter((event) => event.type === "TURN_ADVANCED");
  assert.equal(turnEvents.length, 2); // one per advanceTurn call, never per item
  for (const event of turnEvents) {
    assert.equal(event.itemId, undefined); // inventory-level: no itemId
  }
  assert.ok(turnEvents[1].details !== undefined);
  const details = turnEvents[1].details as Record<string, unknown>;
  assert.equal(details.turns, 2);
  assert.equal(details.turnIndex, 3);
});

test("recordReference: references +1 without resetting age or refreshing updatedAt", () => {
  const inv = createInventory({ clock: "2026-01-02T00:00:00Z" });
  inv.add(
    { id: "ctx-ref", type: "file", content: "referenced content", metadata: { source: "s" } },
    { clock: "2026-01-01T00:00:00Z" },
  );
  inv.advanceTurn(); // age 1; references must not roll age back
  const rec = inv.recordReference("ctx-ref", { relationship: "used", sourceId: "ctx-other" });
  assert.equal(rec.metadata.references, 1);
  assert.equal(rec.metadata.ageTurns, 1);
  assert.equal(rec.updatedAt, "2026-01-01T00:00:00Z"); // not refreshed by references
  assert.equal(rec.revision, 2);

  const evs = inv.events();
  assert.equal(evs.length, 3);
  assert.equal(evs[2].type, "REFERENCE_RECORDED");
  assert.equal(evs[2].itemId, "ctx-ref");
  assert.equal(evs[2].reason, "used");
  assert.equal(evs[2].occurredAt, "2026-01-02T00:00:00Z");
  assert.ok(evs[2].details !== undefined);
  const details = evs[2].details as Record<string, unknown>;
  assert.equal(details.relationship, "used");
  assert.equal(details.references, 1);
  assert.equal(details.sourceId, "ctx-other");
});

test("list: default excludes ARCHIVED/DROPPED; explicit states include them", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "list-active", type: "task", content: "keep me", metadata: { source: "s" } });
  inv.add({ id: "list-arch", type: "file", content: "archive me", metadata: { source: "s" } });
  inv.add({ id: "list-drop", type: "file", content: "drop me", metadata: { source: "s" } });
  inv.archive("list-arch");
  inv.drop("list-drop");

  const active = inv.list();
  assert.deepEqual(idsOf(active), ["list-active"]);
  for (const item of active) {
    assert.ok(item.state === "ACTIVE" || item.state === "COMPRESSED" || item.state === "TRANSFORMED");
  }
  assert.deepEqual(idsOf(inv.list({ states: ["ARCHIVED"] })), ["list-arch"]);
  assert.deepEqual(idsOf(inv.list({ states: ["ARCHIVED", "DROPPED"] })), ["list-arch", "list-drop"]);
});

test("query: OR within a field, AND across fields, pinned, case-sensitive textIncludes", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "q-goal", type: "goal", content: "Alpha Beta content", metadata: { source: "alpha-src", pinned: true }, tags: ["urgent"] });
  inv.add({ id: "q-file", type: "file", content: "alpha lower only", metadata: { source: "beta-src", pinned: false }, tags: ["notes"] });
  inv.add({ id: "q-task", type: "task", content: "Alpha Gamma", metadata: { source: "alpha-src" }, tags: ["notes"] });

  // OR within one field: either type matches.
  assert.deepEqual(idsOf(inv.query({ types: ["file", "task"] })), ["q-file", "q-task"]);
  // AND across fields: type AND source must both match.
  assert.deepEqual(idsOf(inv.query({ types: ["goal"], sources: ["alpha-src"] })), ["q-goal"]);
  // pinned field matches metadata.pinned.
  assert.deepEqual(idsOf(inv.query({ pinned: true })), ["q-goal"]);
  assert.deepEqual(idsOf(inv.query({ types: ["file", "task"], pinned: true })), []);
  // tagsAny ORs values, ANDs with the type field.
  assert.deepEqual(idsOf(inv.query({ tagsAny: ["urgent", "notes"], types: ["task"] })), ["q-task"]);
  // textIncludes is an exact, case-sensitive substring: "Alpha" misses the
  // lowercase-only item; "alpha" misses the uppercase ones.
  assert.deepEqual(idsOf(inv.query({ textIncludes: "Alpha" })), ["q-goal", "q-task"]);
  assert.deepEqual(idsOf(inv.query({ textIncludes: "alpha" })), ["q-file"]);
});

test("list: negative limit -> InvalidContextItemError", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "lim-1", type: "task", content: "one", metadata: { source: "s" } });
  const bad = expectThrown(() => {
    inv.list({ limit: -1 });
  });
  assert.ok(bad instanceof InvalidContextItemError);
  const asBad = bad as InvalidContextItemError;
  assert.equal(asBad.code, "INVALID_CONTEXT_ITEM");
  assert.equal(asBad.itemId, ""); // list-level validation: no offending item id
  assert.ok(asBad.reason.startsWith("invalid_limit:"));
});

test("snapshot: version increments per successful mutation, tokenCount equals sum", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "s-a", type: "task", content: "one", metadata: { source: "s" } });
  inv.add({ id: "s-b", type: "file", content: "two three", metadata: { source: "s" } });
  const s1 = inv.snapshot();
  assert.equal(s1.version, 2); // two successful add() mutations
  assert.deepEqual(idsOf(s1.items), ["s-a", "s-b"]);
  assert.equal(s1.tokenCount, estimateTokens("one") + estimateTokens("two three"));

  inv.update("s-a", { content: "alpha one" }); // re-estimates: count changes
  const s2 = inv.snapshot();
  assert.equal(s2.version, 3);
  assert.equal(s2.tokenCount, estimateTokens("alpha one") + estimateTokens("two three"));

  inv.archive("s-b"); // mutation, but the item leaves default snapshot inclusion
  const s3 = inv.snapshot();
  assert.equal(s3.version, 4);
  assert.deepEqual(idsOf(s3.items), ["s-a"]);
  assert.equal(s3.tokenCount, estimateTokens("alpha one"));

  // Explicit inclusion brings the ARCHIVED tombstone back with its retained count.
  const withArchived = inv.snapshot({ states: ["ACTIVE", "ARCHIVED"] });
  assert.equal(withArchived.version, 4);
  assert.deepEqual(idsOf(withArchived.items), ["s-a", "s-b"]);
  assert.equal(withArchived.tokenCount, estimateTokens("alpha one") + estimateTokens("two three"));

  // snapshot() is a read: it does not bump version.
  const s4 = inv.snapshot();
  assert.equal(s4.version, 4);
});

test("events: one per successful mutation, monotonic sequence, deterministic evt- ids", () => {
  const inv = createInventory({ clock: CLOCK });
  inv.add({ id: "evt-a", type: "task", content: "one", metadata: { source: "s" } });
  inv.add({ id: "evt-b", type: "file", content: "two", metadata: { source: "s" } });
  inv.update("evt-a", { content: "one revised" });
  inv.archive("evt-b");
  inv.advanceTurn();
  inv.remove("evt-a");

  const evs = inv.events();
  assert.equal(evs.length, 6); // exactly one event per successful mutation
  const expectedTypes: readonly string[] = ["ITEM_ADDED", "ITEM_ADDED", "ITEM_UPDATED", "ITEM_STATE_CHANGED", "TURN_ADVANCED", "ITEM_REMOVED"];
  for (let i = 0; i < evs.length; i += 1) {
    assert.equal(evs[i].sequence, i); // monotonic from 0, no gaps
    assert.equal(evs[i].eventId, "evt-" + String(i).padStart(6, "0")); // deterministic padding
    assert.equal(evs[i].type, expectedTypes[i]);
    assert.equal(evs[i].occurredAt, CLOCK);
    if (i > 0) {
      assert.ok(evs[i].sequence > evs[i - 1].sequence);
    }
  }

  // events(afterSequence) returns the strict tail.
  const tail = inv.events(2);
  assert.equal(tail.length, 3);
  assert.equal(tail[0].sequence, 3);
  assert.equal(tail[0].eventId, "evt-000003");
});

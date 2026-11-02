import { test } from "node:test";
import assert from "node:assert/strict";

import { createDecisionRecord, fitWorkingSet, govern } from "../src/governor/govern.ts";
import { InvalidContextItemError } from "../src/types/inventory.ts";

import type { ContextItem } from "../src/types/context.ts";
import type {
  GovernorInput,
  GovernancePolicySet,
  ProviderProposalSource,
} from "../src/types/governance.ts";
import type { GovernorItemDecision } from "../src/governor/govern.ts";

const item: ContextItem = {
  id: "task-1",
  type: "task",
  content: "task context",
  tokenCount: 2,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  metadata: {
    priority: 0.5,
    ageTurns: 0,
    references: 0,
    source: "test",
    compressed: false,
    transformed: false,
    pinned: false,
  },
  state: "ACTIVE",
  revision: 1,
};

const decision: GovernorItemDecision = {
  itemId: item.id,
  action: "KEEP",
  reasonCode: "THRESHOLD_KEEP",
  score: 0.8,
  diagnostics: [],
};

function makePolicies(providerEscalationEnabled: boolean): GovernancePolicySet {
  return {
    allowedActionsByType: new Map([
      ["task", new Set(["KEEP", "DROP"] as const)],
    ]),
    providerEscalationEnabled,
    fallbackByDecisionKind: new Map(),
    thresholds: { keepAtOrAbove: 0.65, retainAtOrAbove: 0.35 },
  };
}

function makeProposal(overrides: Partial<ProviderProposalSource> = {}): ProviderProposalSource {
  return {
    decisionKind: "KEEP",
    itemId: item.id,
    proposal: "DROP",
    ...overrides,
  };
}

function makeBudgetItem(
  id: string,
  tokenCount: number,
  score: number,
  pinned = false,
) {
  const contextItem: ContextItem = {
    ...item,
    id,
    tokenCount,
    metadata: { ...item.metadata, pinned },
  };
  return {
    item: contextItem,
    decision: {
      ...decision,
      itemId: id,
      score,
      reasonCode: "THRESHOLD_KEEP",
    } satisfies GovernorItemDecision,
  };
}

function makeGovernorInput(
  items: readonly ContextItem[],
  scores: ReadonlyMap<string, number>,
): GovernorInput {
  return {
    inventory: {
      version: 1,
      items,
      tokenCount: items.reduce((sum, entry) => sum + entry.tokenCount, 0),
    },
    policies: makePolicies(false),
    rules: [],
    budget: {
      availableInputTokens: 20,
      committedTokens: 0,
      outputReserveTokens: 0,
      safetyMarginTokens: 0,
    },
    scores,
    enabledDecisionKinds: new Set(["KEEP", "DROP"]),
  };
}

test("decision records preserve deterministic outcomes and freeze the record", () => {
  const record = createDecisionRecord(item, decision, makePolicies(false));

  assert.deepEqual(record, {
    itemId: item.id,
    action: "KEEP",
    reasonCode: "THRESHOLD_KEEP",
    score: 0.8,
  });
  assert.equal(Object.isFrozen(record), true);
});

test("decision records embed a winning rule ID in the reason code", () => {
  const record = createDecisionRecord(
    item,
    { ...decision, winningRuleId: "keep-task-rule" },
    makePolicies(false),
  );

  assert.equal(record.reasonCode, "THRESHOLD_KEEP:ruleId=keep-task-rule");
});

test("matching allowed provider proposals are recorded without changing the action", () => {
  const record = createDecisionRecord(
    item,
    decision,
    makePolicies(true),
    makeProposal(),
  );

  assert.equal(record.action, "KEEP");
  assert.equal(record.providerProposal, "DROP");
});

test("provider proposals are omitted when escalation, item, kind, or policy does not match", () => {
  const cases: readonly [GovernancePolicySet, ProviderProposalSource][] = [
    [makePolicies(false), makeProposal()],
    [makePolicies(true), makeProposal({ itemId: "other-item" })],
    [makePolicies(true), makeProposal({ decisionKind: "DROP" })],
    [makePolicies(true), makeProposal({ proposal: "TRANSFORM" })],
  ];

  for (const [policies, proposal] of cases) {
    const record = createDecisionRecord(item, decision, policies, proposal);
    assert.equal("providerProposal" in record, false);
  }
});

test("decision records reject an item and decision ID mismatch", () => {
  assert.throws(
    () => createDecisionRecord(item, { ...decision, itemId: "other-item" }, makePolicies(false)),
    (error: unknown) =>
      error instanceof InvalidContextItemError &&
      error.message.includes("decision_item_mismatch"),
  );
});

test("working-set fitting allocates by score but preserves result input order", () => {
  const lowerScore = makeBudgetItem("lower", 4, 0.7);
  const higherScore = makeBudgetItem("higher", 4, 0.9);
  const result = fitWorkingSet([lowerScore, higherScore], {
    availableInputTokens: 4,
    committedTokens: 0,
    outputReserveTokens: 0,
    safetyMarginTokens: 0,
  });

  assert.deepEqual(result.overflowItemIds, ["lower"]);
  assert.deepEqual(result.decisions.map(({ itemId, action }) => [itemId, action]), [
    ["lower", "DROP"],
    ["higher", "KEEP"],
  ]);
  assert.equal(result.decisions[0]?.reasonCode, "BUDGET_OVERFLOW:THRESHOLD_KEEP");
  assert.deepEqual(result.budgetConflicts, []);
});

test("working-set fitting retains pinned items and reports pinned budget conflicts", () => {
  const pinned = makeBudgetItem("pinned", 5, 0.2, true);
  const ordinary = makeBudgetItem("ordinary", 1, 1);
  const invalidPinnedAction = {
    ...pinned,
    decision: { ...pinned.decision, action: "DROP" as const },
  };
  const result = fitWorkingSet([ordinary, pinned], {
    availableInputTokens: 4,
    committedTokens: 0,
    outputReserveTokens: 0,
    safetyMarginTokens: 0,
  });

  assert.equal(result.decisions.find(({ itemId }) => itemId === "pinned")?.action, "KEEP");
  assert.deepEqual(result.overflowItemIds, ["ordinary"]);
  assert.deepEqual(result.budgetConflicts, [{
    code: "PINNED_ITEMS_EXCEED_WORKING_BUDGET",
    availableInputTokens: 4,
    fixedReservationTokens: 0,
    pinnedTokens: 5,
    excessTokens: 1,
  }]);

  const pinResult = fitWorkingSet([invalidPinnedAction], {
    availableInputTokens: 5,
    committedTokens: 0,
    outputReserveTokens: 0,
    safetyMarginTokens: 0,
  });
  assert.equal(pinResult.decisions[0]?.action, "KEEP");
  assert.equal(pinResult.decisions[0]?.reasonCode, "HARD_CONSTRAINT_PINNED");
});

test("working-set fitting reports fixed-reservation overflow and drops items that cannot fit", () => {
  const candidate = makeBudgetItem("candidate", 1, 1);
  const result = fitWorkingSet([candidate], {
    availableInputTokens: 5,
    committedTokens: 4,
    outputReserveTokens: 1,
    safetyMarginTokens: 1,
  });

  assert.equal(result.workingBudget, 0);
  assert.deepEqual(result.overflowItemIds, ["candidate"]);
  assert.equal(result.budgetConflicts[0]?.code, "FIXED_RESERVATIONS_EXCEED_BUDGET");
  assert.equal(result.budgetConflicts[0]?.excessTokens, 1);
});

test("govern composes active-item decisions, record shaping, and budget fitting", () => {
  const activeKept = { ...item, id: "kept" };
  const activeDropped = { ...item, id: "dropped" };
  const inactive = { ...item, id: "archived", state: "ARCHIVED" as const };
  const input = makeGovernorInput(
    [activeKept, inactive, activeDropped],
    new Map([
      ["kept", 0.8],
      ["dropped", 0.2],
    ]),
  );
  const result = govern(input);

  assert.deepEqual(result.decisions.map(({ itemId, action }) => [itemId, action]), [
    ["kept", "KEEP"],
    ["dropped", "DROP"],
  ]);
  assert.deepEqual(result.unresolvedItemIds, []);
  assert.deepEqual(result.overflowItemIds, []);
  assert.equal(result.workingBudget, 20);
});

test("govern rejects duplicate snapshot IDs and missing active-item scores", () => {
  const duplicate = makeGovernorInput(
    [{ ...item, id: "duplicate" }, { ...item, id: "duplicate" }],
    new Map([["duplicate", 0.8]]),
  );
  assert.throws(
    () => govern(duplicate),
    (error: unknown) =>
      error instanceof InvalidContextItemError &&
      error.reason.startsWith("duplicate_item_id"),
  );

  const missingScore = makeGovernorInput([{ ...item, id: "unscored" }], new Map());
  assert.throws(
    () => govern(missingScore),
    (error: unknown) =>
      error instanceof InvalidContextItemError &&
      error.reason.startsWith("missing_score"),
  );
});

test("govern returns explicit budget overflow after deterministic scoring", () => {
  const lowerRanked = { ...item, id: "lower-ranked", tokenCount: 2 };
  const higherRanked = { ...item, id: "higher-ranked", tokenCount: 2 };
  const input = makeGovernorInput(
    [lowerRanked, higherRanked],
    new Map([
      ["lower-ranked", 0.8],
      ["higher-ranked", 0.9],
    ]),
  );
  const result = govern({
    ...input,
    budget: {
      ...input.budget,
      availableInputTokens: 2,
    },
  });

  assert.deepEqual(result.overflowItemIds, ["lower-ranked"]);
  assert.deepEqual(result.decisions.map(({ itemId, action }) => [itemId, action]), [
    ["lower-ranked", "DROP"],
    ["higher-ranked", "KEEP"],
  ]);
  assert.equal(result.decisions[0]?.reasonCode, "BUDGET_OVERFLOW:THRESHOLD_KEEP");
});

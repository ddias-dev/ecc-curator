import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assemble,
  createAssemblyReport,
  compareCandidates,
  countCandidateTokens,
  countFixedSegments,
  deriveInputLimit,
  deriveAllocationCaps,
  fixedPromptOverflowResult,
  fitSerializedBudget,
  InvalidAssemblyBudgetError,
  InvalidTokenEstimateError,
  pinnedContextOverflowResult,
  selectCandidates,
  serializeSelection,
} from "../src/assembler/assemble.ts";

import type {
  ApprovedContextItem,
  AssemblyBudget,
  AssemblyItemRecord,
  AssemblyReport,
  AssemblyResult,
  AssemblyRequest,
  PromptSegment,
  PromptSegmentRole,
  PromptPackage,
  PromptSerialization,
  PromptTokenEstimator,
} from "../src/types/assembler.ts";
import type { ContextItem } from "../src/types/context.ts";

const roles: Readonly<Record<PromptSegmentRole, true>> = {
  system: true,
  developer: true,
  user: true,
  context: true,
};

const item: ContextItem = {
  id: "task-1",
  type: "task",
  content: "task context",
  tokenCount: 12,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  metadata: {
    priority: 0.8,
    ageTurns: 0,
    references: 1,
    source: "test",
    compressed: false,
    transformed: false,
    pinned: false,
  },
  state: "ACTIVE",
  revision: 1,
};

test("PromptSegmentRole includes the four documented segment roles", () => {
  assert.deepEqual(Object.keys(roles), ["system", "developer", "user", "context"]);
});

test("PromptSegment accepts the documented fixed segment shape", () => {
  const segment: PromptSegment = {
    id: "system",
    role: "system",
    content: "system instructions",
    fixed: true,
    order: 0,
  };

  assert.deepEqual(segment, {
    id: "system",
    role: "system",
    content: "system instructions",
    fixed: true,
    order: 0,
  });
});

test("ApprovedContextItem accepts a governor-approved candidate shape", () => {
  const candidate: ApprovedContextItem = {
    item,
    action: "KEEP",
    score: 0.8,
    policyPriority: 1,
    category: "work",
    tokenCount: 12,
  };

  assert.equal(candidate.item, item);
  assert.equal(candidate.action, "KEEP");
  assert.equal(candidate.tokenCount, item.tokenCount);
});

test("AssemblyBudget accepts the documented token limits", () => {
  const budget: AssemblyBudget = {
    contextWindowTokens: 32_000,
    outputReserveTokens: 2_000,
    safetyMarginTokens: 500,
    maxPromptTokens: 20_000,
  };

  assert.equal(budget.contextWindowTokens, 32_000);
  assert.equal(budget.maxPromptTokens, 20_000);
});

test("PromptTokenEstimator accepts the documented counting methods", () => {
  const estimator: PromptTokenEstimator = {
    id: "test-estimator",
    version: "1",
    exact: true,
    countSerialized: (text) => text.length,
    countSegment: (segment) => segment.content.length,
    countContextItem: (contextItem) => contextItem.tokenCount,
  };

  assert.equal(estimator.countSerialized("prompt"), 6);
  assert.equal(estimator.countSegment({
    id: "system",
    role: "system",
    content: "fixed",
    fixed: true,
    order: 0,
  }), 5);
  assert.equal(estimator.countContextItem(item), 12);
});

test("PromptSerialization accepts deterministic segment and context inputs", () => {
  const serialization: PromptSerialization = {
    id: "test-serialization",
    version: "1",
    serialize: (segments, contextItems) =>
      [...segments.map(({ content }) => content), ...contextItems.map(({ content }) => content)]
        .join("\n"),
  };

  assert.equal(serialization.serialize([{
    id: "system",
    role: "system",
    content: "fixed",
    fixed: true,
    order: 0,
  }], [item]), "fixed\ntask context");
});

test("AssemblyRequest composes fixed segments, candidates, budget, and adapters", () => {
  const request: AssemblyRequest = {
    fixedSegments: [{
      id: "system",
      role: "system",
      content: "system instructions",
      fixed: true,
      order: 0,
    }],
    candidates: [{
      item,
      action: "KEEP",
      score: 0.8,
      policyPriority: 1,
      category: "work",
      tokenCount: 12,
    }],
    budget: {
      contextWindowTokens: 32_000,
      outputReserveTokens: 2_000,
      safetyMarginTokens: 500,
    },
    estimator: {
      id: "test-estimator",
      version: "1",
      exact: true,
      countSerialized: (text) => text.length,
      countSegment: (segment) => segment.content.length,
      countContextItem: (contextItem) => contextItem.tokenCount,
    },
    serialization: {
      id: "test-serialization",
      version: "1",
      serialize: (segments, contextItems) =>
        [...segments.map(({ content }) => content), ...contextItems.map(({ content }) => content)]
          .join("\n"),
    },
  };

  assert.equal(request.fixedSegments.length, 1);
  assert.equal(request.candidates.length, 1);
  assert.equal(request.overflowPolicy, undefined);
});

test("AssemblyItemRecord accepts documented inclusion and exclusion metadata", () => {
  const record: AssemblyItemRecord = {
    itemId: item.id,
    category: "work",
    tokenCount: 12,
    score: 0.8,
    reasonCode: "INCLUDED_BY_RANK",
  };

  assert.equal(record.itemId, item.id);
  assert.equal(record.reasonCode, "INCLUDED_BY_RANK");
});

test("AssemblyReport accepts token accounting, allocations, and optional overflow", () => {
  const report: AssemblyReport = {
    included: [],
    excluded: [],
    tokenCounts: {
      fixedSegments: 10,
      contextItems: 20,
      serializedPackage: 35,
    },
    allocationUse: { work: 0.5 },
    overflow: {
      requiredTokens: 35,
      availableTokens: 30,
      pinnedItemIds: [],
    },
  };

  assert.equal(report.tokenCounts.serializedPackage, 35);
  assert.deepEqual(report.overflow?.pinnedItemIds, []);
});

test("PromptPackage represents a serialized versioned prompt with budget reporting", () => {
  const promptPackage: PromptPackage = {
    schemaVersion: "1",
    segments: [],
    contextItems: [item],
    serializedInput: "task context",
    tokenCount: 12,
    budget: {
      contextWindowTokens: 32_000,
      outputReserveTokens: 2_000,
      safetyMarginTokens: 500,
      inputLimitTokens: 29_500,
      remainingTokens: 29_488,
    },
    report: {
      included: [],
      excluded: [],
      tokenCounts: {
        fixedSegments: 0,
        contextItems: 12,
        serializedPackage: 12,
      },
      allocationUse: {},
    },
  };

  assert.equal(promptPackage.schemaVersion, "1");
  assert.equal(promptPackage.contextItems[0], item);
});

test("AssemblyResult distinguishes successful packages from typed failures", () => {
  const report: AssemblyReport = {
    included: [],
    excluded: [],
    tokenCounts: {
      fixedSegments: 10,
      contextItems: 0,
      serializedPackage: 10,
    },
    allocationUse: {},
  };
  const success: AssemblyResult = {
    ok: true,
    package: {
      schemaVersion: "1",
      segments: [],
      contextItems: [],
      serializedInput: "fixed prompt",
      tokenCount: 10,
      budget: {
        contextWindowTokens: 100,
        outputReserveTokens: 10,
        safetyMarginTokens: 5,
        inputLimitTokens: 85,
        remainingTokens: 75,
      },
      report,
    },
  };
  const failure: AssemblyResult = {
    ok: false,
    error: "FixedPromptOverflow",
    report,
  };

  assert.equal(success.ok, true);
  assert.equal(failure.ok, false);
});

test("deriveInputLimit reserves output and safety tokens before applying max prompt", () => {
  assert.equal(deriveInputLimit({
    contextWindowTokens: 10_000,
    outputReserveTokens: 1_000,
    safetyMarginTokens: 500,
    maxPromptTokens: 7_000,
  }), 7_000);
  assert.equal(deriveInputLimit({
    contextWindowTokens: 10_000,
    outputReserveTokens: 1_000,
    safetyMarginTokens: 500,
  }), 8_500);
});

test("deriveInputLimit rejects invalid budgets and negative remaining input", () => {
  for (const budget of [
    { contextWindowTokens: -1, outputReserveTokens: 0, safetyMarginTokens: 0 },
    { contextWindowTokens: 10, outputReserveTokens: 1.5, safetyMarginTokens: 0 },
    { contextWindowTokens: 10, outputReserveTokens: 0, safetyMarginTokens: 0, maxPromptTokens: Number.NaN },
    { contextWindowTokens: 10, outputReserveTokens: 8, safetyMarginTokens: 3 },
  ]) {
    assert.throws(
      () => deriveInputLimit(budget),
      (error: unknown) =>
        error instanceof InvalidAssemblyBudgetError &&
        error.reason === "invalid_budget",
    );
  }
});

test("countFixedSegments sums serialization-aware estimates", () => {
  const fixedSegments = [
    { id: "system", role: "system" as const, content: "system", fixed: true, order: 0 },
    { id: "developer", role: "developer" as const, content: "developer", fixed: true, order: 1 },
  ];
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 0,
    countSegment: (segment) => segment.content.length,
    countContextItem: (contextItem) => contextItem.tokenCount,
  };

  assert.equal(countFixedSegments(fixedSegments, estimator), 15);
});

test("countFixedSegments rejects non-fixed, duplicate, and invalidly estimated segments", () => {
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 0,
    countSegment: () => -1,
    countContextItem: (contextItem) => contextItem.tokenCount,
  };
  const segment: PromptSegment = {
    id: "system",
    role: "system",
    content: "system",
    fixed: true,
    order: 0,
  };

  assert.throws(() => countFixedSegments([{ ...segment, fixed: false }], estimator), InvalidTokenEstimateError);
  assert.throws(() => countFixedSegments([segment, segment], estimator), InvalidTokenEstimateError);
  assert.throws(() => countFixedSegments([segment], estimator), InvalidTokenEstimateError);
});

test("countCandidateTokens uses serialization-aware item estimates", () => {
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 0,
    countSegment: () => 0,
    countContextItem: (contextItem) => contextItem.content.length,
  };
  const candidate: ApprovedContextItem = {
    item,
    action: "KEEP",
    score: 0.8,
    policyPriority: 1,
    category: "work",
    tokenCount: 12,
  };

  assert.equal(countCandidateTokens(candidate, estimator), item.content.length);
});

test("countCandidateTokens surfaces invalid estimates", () => {
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 0,
    countSegment: () => 0,
    countContextItem: () => Number.POSITIVE_INFINITY,
  };
  const candidate: ApprovedContextItem = {
    item,
    action: "KEEP",
    score: 0.8,
    policyPriority: 1,
    category: "work",
    tokenCount: 12,
  };

  assert.throws(
    () => countCandidateTokens(candidate, estimator),
    (error: unknown) =>
      error instanceof InvalidTokenEstimateError &&
      error.reason === "invalid_token_estimate",
  );
});

test("compareCandidates applies all eight documented ordering keys", () => {
  const makeCandidate = (
    id: string,
    options: {
      pinned?: boolean;
      score?: number;
      policyPriority?: number;
      type?: ContextItem["type"];
      ageTurns?: number;
      references?: number;
      tokenCount?: number;
    } = {},
  ): ApprovedContextItem => ({
    item: {
      ...item,
      id,
      type: options.type ?? "task",
      tokenCount: options.tokenCount ?? 10,
      metadata: {
        ...item.metadata,
        pinned: options.pinned ?? false,
        ageTurns: options.ageTurns ?? 1,
        references: options.references ?? 1,
      },
    },
    action: "KEEP",
    score: options.score ?? 0.5,
    policyPriority: options.policyPriority ?? 1,
    category: "work",
    tokenCount: options.tokenCount ?? 10,
  });

  const precedes = (first: ApprovedContextItem, second: ApprovedContextItem): void =>
    assert.ok(compareCandidates(first, second) < 0);

  precedes(makeCandidate("pin", { pinned: true }), makeCandidate("high-score", { score: 1 }));
  precedes(makeCandidate("high-score", { score: 0.9 }), makeCandidate("low-score", { score: 0.8 }));
  precedes(makeCandidate("policy", { policyPriority: 1 }), makeCandidate("policy-lower", { policyPriority: 2 }));
  precedes(makeCandidate("goal", { type: "goal" }), makeCandidate("file", { type: "file" }));
  precedes(makeCandidate("younger", { ageTurns: 1 }), makeCandidate("older", { ageTurns: 2 }));
  precedes(makeCandidate("referenced", { references: 2 }), makeCandidate("unreferenced", { references: 1 }));
  precedes(makeCandidate("smaller", { tokenCount: 5 }), makeCandidate("larger", { tokenCount: 6 }));
  precedes(makeCandidate("alpha"), makeCandidate("zeta"));
});

test("deriveAllocationCaps converts valid fractions into soft token caps", () => {
  assert.deepEqual(deriveAllocationCaps({ work: 0.5, memory: 0.25 }, 101), {
    work: 50,
    memory: 25,
  });
  assert.deepEqual(deriveAllocationCaps(undefined, 101), {});
});

test("deriveAllocationCaps rejects invalid fractions and budgets", () => {
  for (const [allocations, tokens] of [
    [{ work: -0.1 }, 100],
    [{ work: 1.1 }, 100],
    [{ work: 0.6, memory: 0.5 }, 100],
    [{ "": 0.5 }, 100],
    [{ work: 0.5 }, -1],
  ] as const) {
    assert.throws(
      () => deriveAllocationCaps(allocations, tokens),
      InvalidAssemblyBudgetError,
    );
  }
});

test("selectCandidates preserves pins and excludes lowest-ranked items on total overflow", () => {
  const candidates: ApprovedContextItem[] = [
    { item: { ...item, id: "pinned", tokenCount: 250, metadata: { ...item.metadata, pinned: true } }, action: "KEEP", score: 0.1, policyPriority: 1, category: "goal", tokenCount: 250 },
    { item: { ...item, id: "kept", tokenCount: 500 }, action: "KEEP", score: 0.9, policyPriority: 1, category: "work", tokenCount: 500 },
    { item: { ...item, id: "excluded", tokenCount: 400 }, action: "KEEP", score: 0.8, policyPriority: 1, category: "work", tokenCount: 400 },
  ];
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 0,
    countSegment: () => 0,
    countContextItem: (contextItem) => contextItem.tokenCount,
  };

  const selected = selectCandidates(candidates, 1_000, estimator);
  assert.deepEqual(selected.included.map(({ candidate }) => candidate.item.id), ["pinned", "kept"]);
  assert.deepEqual(selected.excluded.map(({ candidate }) => candidate.item.id), ["excluded"]);
  assert.equal(selected.includedTokens, 750);
  assert.equal(selected.pinnedOverflow, false);
});

test("selectCandidates applies category caps then redistributes unused category capacity", () => {
  const makeCandidate = (id: string, category: string): ApprovedContextItem => ({
    item: { ...item, id, tokenCount: 40 },
    action: "KEEP",
    score: id === "work-1" ? 0.9 : 0.8,
    policyPriority: 1,
    category,
    tokenCount: 40,
  });
  const candidates = [
    makeCandidate("work-1", "work"),
    makeCandidate("work-2", "work"),
    makeCandidate("memory-1", "memory"),
  ];
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 0,
    countSegment: () => 0,
    countContextItem: () => 40,
  };

  const selected = selectCandidates(candidates, 100, estimator, { work: 0.5, memory: 0.5 });
  assert.deepEqual(selected.included.map(({ candidate }) => candidate.item.id), [
    "work-1",
    "memory-1",
  ]);
  assert.deepEqual(selected.excluded.map(({ candidate }) => candidate.item.id), ["work-2"]);
});

test("selectCandidates rejects aggregate token counts beyond safe integer precision", () => {
  const makeLargePinned = (id: string): ApprovedContextItem => ({
    item: {
      ...item,
      id,
      tokenCount: Number.MAX_SAFE_INTEGER,
      metadata: { ...item.metadata, pinned: true },
    },
    action: "KEEP",
    score: 0.8,
    policyPriority: 1,
    category: "goal",
    tokenCount: Number.MAX_SAFE_INTEGER,
  });
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 0,
    countSegment: () => 0,
    countContextItem: () => Number.MAX_SAFE_INTEGER,
  };

  assert.throws(
    () => selectCandidates([makeLargePinned("pin-a"), makeLargePinned("pin-b")], Number.MAX_SAFE_INTEGER, estimator),
    InvalidTokenEstimateError,
  );
});

test("createAssemblyReport records selected and overflowed candidates with token accounting", () => {
  const candidate: ApprovedContextItem = {
    item,
    action: "KEEP",
    score: 0.8,
    policyPriority: 1,
    category: "work",
    tokenCount: 12,
  };
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 35,
    countSegment: () => 10,
    countContextItem: () => 12,
  };
  const selection = selectCandidates([candidate], 20, estimator);
  const report = createAssemblyReport(selection, 10, 35, {
    requiredTokens: 35,
    availableTokens: 30,
    pinnedItemIds: [],
  });

  assert.deepEqual(report.included, [{
    itemId: item.id,
    category: "work",
    tokenCount: 12,
    score: 0.8,
    reasonCode: "ASSEMBLY_INCLUDED",
  }]);
  assert.deepEqual(report.tokenCounts, {
    fixedSegments: 10,
    contextItems: 12,
    serializedPackage: 35,
  });
  assert.deepEqual(report.allocationUse, { work: 12 });
  assert.deepEqual(report.overflow?.pinnedItemIds, []);
});

test("fixedPromptOverflowResult returns a structured non-success result", () => {
  const result = fixedPromptOverflowResult(120, 100);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "FixedPromptOverflow");
    assert.equal(result.report.tokenCounts.fixedSegments, 120);
    assert.deepEqual(result.report.overflow, {
      requiredTokens: 120,
      availableTokens: 100,
      pinnedItemIds: [],
    });
  }
});

test("pinnedContextOverflowResult retains pins and reports the conflict", () => {
  const pinnedCandidate: ApprovedContextItem = {
    item: { ...item, id: "pinned", tokenCount: 80, metadata: { ...item.metadata, pinned: true } },
    action: "KEEP",
    score: 0.4,
    policyPriority: 1,
    category: "goal",
    tokenCount: 80,
  };
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => 0,
    countSegment: () => 0,
    countContextItem: (contextItem) => contextItem.tokenCount,
  };
  const selection = selectCandidates([pinnedCandidate], 50, estimator);
  const result = pinnedContextOverflowResult(selection, 20, 50);

  assert.equal(selection.included[0]?.candidate.item.id, "pinned");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "PinnedContextOverflow");
    assert.deepEqual(result.report.overflow?.pinnedItemIds, ["pinned"]);
    assert.equal(result.report.overflow?.requiredTokens, 100);
    assert.equal(result.report.overflow?.availableTokens, 50);
    assert.equal(result.report.included[0]?.reasonCode, "ASSEMBLY_PINNED_OVERFLOW");
  }
});

test("serializeSelection orders fixed segments and recounts the full serialized prompt", () => {
  const fixedSegments = [
    { id: "z", role: "developer" as const, content: "z", fixed: true, order: 0 },
    { id: "a", role: "system" as const, content: "a", fixed: true, order: 0 },
    { id: "last", role: "user" as const, content: "last", fixed: true, order: 1 },
  ];
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: (text) => text.length,
    countSegment: () => 1,
    countContextItem: () => 1,
  };
  const selection = selectCandidates([], 100, estimator);
  const serialization: PromptSerialization = {
    id: "test",
    version: "1",
    serialize: (segments) => segments.map(({ id }) => id).join(","),
  };
  const serialized = serializeSelection(fixedSegments, selection, serialization, estimator);

  assert.deepEqual(serialized.segments.map(({ id }) => id), ["a", "z", "last"]);
  assert.equal(serialized.serializedInput, "a,z,last");
  assert.equal(serialized.tokenCount, 8);
});

test("serializeSelection surfaces invalid full-package estimates", () => {
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: () => Number.NaN,
    countSegment: () => 0,
    countContextItem: () => 0,
  };
  const serialization: PromptSerialization = {
    id: "test",
    version: "1",
    serialize: () => "prompt",
  };

  assert.throws(
    () => serializeSelection([], selectCandidates([], 10, estimator), serialization, estimator),
    InvalidTokenEstimateError,
  );
});

test("fitSerializedBudget removes lowest-ranked items and reserializes until the prompt fits", () => {
  const candidates: ApprovedContextItem[] = [
    { item: { ...item, id: "high", content: "high" }, action: "KEEP", score: 0.9, policyPriority: 1, category: "work", tokenCount: 4 },
    { item: { ...item, id: "low", content: "low" }, action: "KEEP", score: 0.8, policyPriority: 1, category: "work", tokenCount: 3 },
  ];
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: (text) => text.length,
    countSegment: () => 0,
    countContextItem: (contextItem) => contextItem.content.length,
  };
  const serialization: PromptSerialization = {
    id: "test",
    version: "1",
    serialize: (_segments, contextItems) => contextItems.map(({ content }) => content).join(" "),
  };
  const selection = selectCandidates(candidates, 100, estimator);
  const fit = fitSerializedBudget([], selection, serialization, estimator, 0, 4);

  assert.equal(fit.failure, undefined);
  assert.deepEqual(fit.selection.included.map(({ candidate }) => candidate.item.id), ["high"]);
  assert.deepEqual(fit.selection.excluded.map(({ candidate }) => candidate.item.id), ["low"]);
  assert.equal(fit.serialized.serializedInput, "high");
});

test("fitSerializedBudget honors error policy and does not remove candidates", () => {
  const candidate: ApprovedContextItem = {
    item: { ...item, id: "candidate", content: "long prompt item" },
    action: "KEEP",
    score: 0.8,
    policyPriority: 1,
    category: "work",
    tokenCount: 12,
  };
  const estimator: PromptTokenEstimator = {
    id: "test",
    version: "1",
    exact: true,
    countSerialized: (text) => text.length,
    countSegment: () => 0,
    countContextItem: () => 12,
  };
  const serialization: PromptSerialization = {
    id: "test",
    version: "1",
    serialize: (_segments, contextItems) => contextItems.map(({ content }) => content).join(" "),
  };
  const selection = selectCandidates([candidate], 100, estimator);
  const fit = fitSerializedBudget([], selection, serialization, estimator, 0, 3, "error");

  assert.deepEqual(fit.selection.included.map(({ candidate: included }) => included.item.id), ["candidate"]);
  assert.equal(fit.failure?.ok, false);
  if (fit.failure?.ok === false) {
    assert.equal(fit.failure.error, "UnresolvableOverflow");
  }
});

test("assemble builds a deterministic package and reports candidates excluded by budget", () => {
  const candidates: ApprovedContextItem[] = [
    {
      item: { ...item, id: "pinned-goal", type: "goal", tokenCount: 250, content: "p".repeat(250), metadata: { ...item.metadata, pinned: true } },
      action: "KEEP",
      score: 0.1,
      policyPriority: 1,
      category: "goal",
      tokenCount: 250,
    },
    {
      item: { ...item, id: "current-task", tokenCount: 500, content: "k".repeat(500) },
      action: "KEEP",
      score: 0.9,
      policyPriority: 1,
      category: "task",
      tokenCount: 500,
    },
    {
      item: { ...item, id: "old-file", tokenCount: 400, content: "x".repeat(400) },
      action: "KEEP",
      score: 0.8,
      policyPriority: 1,
      category: "file",
      tokenCount: 400,
    },
  ];
  const request: AssemblyRequest = {
    fixedSegments: [{
      id: "system",
      role: "system",
      content: "",
      fixed: true,
      order: 0,
    }],
    candidates,
    budget: {
      contextWindowTokens: 1_000,
      outputReserveTokens: 0,
      safetyMarginTokens: 0,
    },
    estimator: {
      id: "test",
      version: "1",
      exact: true,
      countSerialized: (text) => text.length,
      countSegment: (segment) => segment.content.length,
      countContextItem: (contextItem) => contextItem.content.length,
    },
    serialization: {
      id: "test",
      version: "1",
      serialize: (segments, contextItems) =>
        [...segments.map(({ content }) => content), ...contextItems.map(({ content }) => content)]
          .join(""),
    },
  };
  const result = assemble(request);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.package.contextItems.map(({ id }) => id), ["pinned-goal", "current-task"]);
    assert.equal(result.package.tokenCount, 750);
    assert.equal(result.package.budget.remainingTokens, 250);
    assert.deepEqual(result.package.report.excluded.map(({ itemId, reasonCode }) => [
      itemId,
      reasonCode,
    ]), [["old-file", "ASSEMBLY_BUDGET_OVERFLOW"]]);
    assert.equal(JSON.stringify(assemble(request)), JSON.stringify(result));
  }
});

test("assemble returns explicit InvalidBudget, FixedPromptOverflow, and PinnedContextOverflow results", () => {
  const base: AssemblyRequest = {
    fixedSegments: [],
    candidates: [],
    budget: { contextWindowTokens: 10, outputReserveTokens: 0, safetyMarginTokens: 0 },
    estimator: {
      id: "test",
      version: "1",
      exact: true,
      countSerialized: (text) => text.length,
      countSegment: (segment) => segment.content.length,
      countContextItem: (contextItem) => contextItem.tokenCount,
    },
    serialization: {
      id: "test",
      version: "1",
      serialize: (segments, contextItems) =>
        [...segments.map(({ content }) => content), ...contextItems.map(({ content }) => content)]
          .join(""),
    },
  };

  const invalidBudget = assemble({
    ...base,
    budget: { ...base.budget, contextWindowTokens: -1 },
  });
  assert.equal(invalidBudget.ok, false);
  if (!invalidBudget.ok) assert.equal(invalidBudget.error, "InvalidBudget");

  const invalidAllocations = assemble({
    ...base,
    allocations: { work: 1.1 },
  });
  assert.equal(invalidAllocations.ok, false);
  if (!invalidAllocations.ok) assert.equal(invalidAllocations.error, "InvalidBudget");

  const fixedOverflow = assemble({
    ...base,
    fixedSegments: [{
      id: "system",
      role: "system",
      content: "too long prompt",
      fixed: true,
      order: 0,
    }],
  });
  assert.equal(fixedOverflow.ok, false);
  if (!fixedOverflow.ok) assert.equal(fixedOverflow.error, "FixedPromptOverflow");

  const pinnedOverflow = assemble({
    ...base,
    budget: { ...base.budget, contextWindowTokens: 5 },
    candidates: [{
      item: {
        ...item,
        id: "pinned",
        tokenCount: 8,
        metadata: { ...item.metadata, pinned: true },
      },
      action: "KEEP",
      score: 0.8,
      policyPriority: 1,
      category: "goal",
      tokenCount: 8,
    }],
  });
  assert.equal(pinnedOverflow.ok, false);
  if (!pinnedOverflow.ok) assert.equal(pinnedOverflow.error, "PinnedContextOverflow");
});

test("assemble maps invalid estimates and final serialization overflow to explicit results", () => {
  const itemCandidate: ApprovedContextItem = {
    item: { ...item, id: "candidate", content: "candidate" },
    action: "KEEP",
    score: 0.8,
    policyPriority: 1,
    category: "work",
    tokenCount: 9,
  };
  const base: AssemblyRequest = {
    fixedSegments: [{
      id: "system",
      role: "system",
      content: "f".repeat(90),
      fixed: true,
      order: 0,
    }],
    candidates: [itemCandidate],
    budget: { contextWindowTokens: 100, outputReserveTokens: 0, safetyMarginTokens: 0 },
    estimator: {
      id: "test",
      version: "1",
      exact: true,
      countSerialized: (text) => text.length,
      countSegment: (segment) => segment.content.length,
      countContextItem: (contextItem) => contextItem.content.length,
    },
    serialization: {
      id: "test",
      version: "1",
      serialize: (segments, contextItems) =>
        [...segments.map(({ content }) => content), ...contextItems.map(({ content }) => content), "!!"]
          .join(""),
    },
  };
  const defaultPolicy = assemble(base);

  assert.equal(defaultPolicy.ok, true);
  if (defaultPolicy.ok) {
    assert.deepEqual(defaultPolicy.package.report.excluded.map(({ itemId }) => itemId), ["candidate"]);
    assert.equal(defaultPolicy.package.tokenCount, 92);
  }

  const errorPolicy = assemble({ ...base, overflowPolicy: "error" });
  assert.equal(errorPolicy.ok, false);
  if (!errorPolicy.ok) assert.equal(errorPolicy.error, "UnresolvableOverflow");

  const invalidEstimate = assemble({
    ...base,
    candidates: [],
    estimator: { ...base.estimator, countSegment: () => Number.POSITIVE_INFINITY },
  });
  assert.equal(invalidEstimate.ok, false);
  if (!invalidEstimate.ok) assert.equal(invalidEstimate.error, "InvalidTokenEstimate");
});

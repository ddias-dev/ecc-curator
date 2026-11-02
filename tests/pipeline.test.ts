import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assembleGoverned,
  ingestContext,
  runPipeline,
  scoreAndGovern,
  toAssemblyCandidates,
} from "../src/pipeline/run.ts";
import { EVALUATION_SCENARIOS } from "../src/eval/scenarios.ts";
import {
  calculateEvaluationMetrics,
  InvalidEvaluationMeasurementsError,
  measurePipelineResult,
} from "../src/eval/metrics.ts";

import type { BudgetState, GovernancePolicySet } from "../src/types/governance.ts";
import type { GovernanceDecisionRecord } from "../src/types/governance.ts";
import type { NewContextItem } from "../src/types/inventory.ts";

const input: NewContextItem = {
  id: "goal-1",
  type: "goal",
  content: "Build the MVP",
  metadata: { source: "user" },
};

const budget: BudgetState = {
  availableInputTokens: 1_000,
  committedTokens: 100,
  outputReserveTokens: 100,
  safetyMarginTokens: 50,
};

const policies: GovernancePolicySet = {
  allowedActionsByType: new Map([["goal", new Set(["KEEP", "DROP"] as const)]]),
  providerEscalationEnabled: false,
  fallbackByDecisionKind: new Map(),
  thresholds: { keepAtOrAbove: 0.65, retainAtOrAbove: 0.35 },
};

test("ingestContext builds a snapshot using the injected inventory estimator", () => {
  const snapshot = ingestContext([input], {
    clock: "2026-01-01T00:00:00Z",
    estimator: { estimate: (text) => text.length },
  });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.tokenCount, input.content.length);
  assert.equal(snapshot.items[0]?.id, input.id);
  assert.equal(snapshot.items[0]?.tokenCount, input.content.length);
});

test("ingestContext surfaces invalid item errors instead of returning a partial snapshot", () => {
  assert.throws(() => ingestContext([input], {
    estimator: { estimate: (_text: string) => -1 },
  }));
});

test("scoreAndGovern scores ingested active items and returns deterministic decisions", () => {
  const snapshot = ingestContext([input], {
    clock: "2026-01-01T00:00:00Z",
    estimator: { estimate: (text) => text.length },
  });
  const result = scoreAndGovern(snapshot, {
    budget,
    policies,
    rules: [],
    enabledDecisionKinds: new Set(["KEEP", "DROP"]),
  });

  assert.equal(result.scoring.scores.get(input.id), result.governance.decisions[0]?.score);
  assert.equal(result.governance.decisions[0]?.itemId, input.id);
  assert.equal(result.governance.decisions[0]?.action, "KEEP");
});

test("toAssemblyCandidates includes only kept items and carries deterministic ranking fields", () => {
  const snapshot = ingestContext([input], {
    clock: "2026-01-01T00:00:00Z",
    estimator: { estimate: (text) => text.length },
  });
  const decisions: GovernanceDecisionRecord[] = [
    { itemId: input.id, action: "KEEP", reasonCode: "TEST_KEEP", score: 0.9 },
    { itemId: input.id, action: "DROP", reasonCode: "TEST_DROP", score: 0.1 },
  ];

  const candidates = toAssemblyCandidates(snapshot.items, decisions);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.item.id, input.id);
  assert.equal(candidates[0]?.action, "KEEP");
  assert.equal(candidates[0]?.score, 0.9);
  assert.equal(candidates[0]?.category, input.type);
  assert.equal(candidates[0]?.policyPriority, 1 - snapshot.items[0]!.metadata.priority);
  assert.equal(candidates[0]?.tokenCount, snapshot.items[0]?.tokenCount);
});

test("assembleGoverned packages kept items through the existing assembler", () => {
  const snapshot = ingestContext([input], {
    clock: "2026-01-01T00:00:00Z",
    estimator: { estimate: (text) => text.length },
  });
  const decisions: GovernanceDecisionRecord[] = [
    { itemId: input.id, action: "KEEP", reasonCode: "TEST_KEEP", score: 0.9 },
  ];

  const result = assembleGoverned(snapshot.items, decisions, {
    fixedSegments: [],
    budget: {
      contextWindowTokens: 1_000,
      outputReserveTokens: 100,
      safetyMarginTokens: 50,
    },
    estimator: {
      id: "characters",
      version: "1",
      exact: true,
      countSerialized: (text) => text.length,
      countSegment: (segment) => segment.content.length,
      countContextItem: (item) => item.content.length,
    },
    serialization: {
      id: "json",
      version: "1",
      serialize: (segments, contextItems) => JSON.stringify({ segments, contextItems }),
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.package.contextItems.map((item) => item.id), [input.id]);
});

test("runPipeline deterministically ingests, scores, governs, and assembles context", () => {
  const result = runPipeline([input], {
    ingestionOptions: {
      clock: "2026-01-01T00:00:00Z",
      estimator: { estimate: (text) => text.length },
    },
    governance: {
      budget,
      policies,
      rules: [],
      enabledDecisionKinds: new Set(["KEEP", "DROP"]),
    },
    assembly: {
      fixedSegments: [],
      budget: {
        contextWindowTokens: 1_000,
        outputReserveTokens: 100,
        safetyMarginTokens: 50,
      },
      estimator: {
        id: "characters",
        version: "1",
        exact: true,
        countSerialized: (text) => text.length,
        countSegment: (segment) => segment.content.length,
        countContextItem: (item) => item.content.length,
      },
      serialization: {
        id: "json",
        version: "1",
        serialize: (segments, contextItems) => JSON.stringify({ segments, contextItems }),
      },
    },
  });

  assert.equal(result.inventory.items[0]?.id, input.id);
  assert.equal(result.scoring.scores.has(input.id), true);
  assert.equal(result.governance.decisions[0]?.action, "KEEP");
  assert.equal(result.assembly.ok, true);
  if (result.assembly.ok) {
    assert.deepEqual(result.assembly.package.contextItems.map((item) => item.id), [input.id]);
  }
});

test("evaluation scenarios produce their declared kept-item outcomes", () => {
  for (const scenario of EVALUATION_SCENARIOS) {
    const result = runPipeline(scenario.items, scenario.pipeline);
    assert.equal(result.assembly.ok, true, scenario.id);
    if (result.assembly.ok) {
      assert.deepEqual(
        result.assembly.package.contextItems.map((item) => item.id),
        scenario.expectedKeptItemIds,
        scenario.id,
      );
    }
  }
});

test("evaluation metrics report numeric token, retention, and task-outcome rates", () => {
  const metrics = calculateEvaluationMetrics({
    rawTokens: 100,
    curatedTokens: 40,
    inputItemCount: 4,
    retainedItemCount: 2,
    outcomes: [
      { succeeded: true, passedTests: 3, totalTests: 4 },
      { succeeded: false, passedTests: 1, totalTests: 2 },
    ],
  });

  assert.deepEqual(metrics, {
    tokenSavings: 60,
    tokenReductionRate: 0.6,
    retentionRate: 0.5,
    taskSuccessRate: 0.5,
    testPassRate: 4 / 6,
  });
});

test("measurePipelineResult derives efficiency and retention from actual pipeline output", () => {
  const scenario = EVALUATION_SCENARIOS[1]!;
  const pipeline = {
    ...scenario.pipeline,
    ingestionOptions: {
      ...scenario.pipeline.ingestionOptions,
      estimator: { estimate: (text: string) => text.length * 2 },
    },
  };
  const result = runPipeline(scenario.items, pipeline);

  const metrics = measurePipelineResult(result, [
    { succeeded: true, passedTests: 2, totalTests: 2 },
  ], pipeline.assembly.estimator);

  assert.equal(metrics.tokenSavings, "An obsolete command result".length);
  assert.equal(
    metrics.tokenReductionRate,
    metrics.tokenSavings / scenario.items.reduce((total, item) => total + item.content.length, 0),
  );
  assert.equal(metrics.retentionRate, 0.5);
  assert.equal(metrics.taskSuccessRate, 1);
  assert.equal(metrics.testPassRate, 1);
});

test("evaluation metrics reject undefined denominators and inconsistent outcome counts", () => {
  const validCounts = {
    rawTokens: 10,
    curatedTokens: 5,
    inputItemCount: 2,
    retainedItemCount: 1,
  };

  assert.throws(() => calculateEvaluationMetrics({
    ...validCounts,
    rawTokens: 0,
    outcomes: [{ succeeded: true, passedTests: 1, totalTests: 1 }],
  }), InvalidEvaluationMeasurementsError);
  assert.throws(() => calculateEvaluationMetrics({
    ...validCounts,
    outcomes: [{ succeeded: true, passedTests: 2, totalTests: 1 }],
  }), InvalidEvaluationMeasurementsError);
});

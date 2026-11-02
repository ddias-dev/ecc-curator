import type { PipelineRunInput } from "../pipeline/run.ts";
import type { NewContextItem } from "../types/inventory.ts";

export interface EvaluationScenario {
  id: string;
  items: readonly NewContextItem[];
  pipeline: PipelineRunInput;
  expectedKeptItemIds: readonly string[];
}

const budget = {
  availableInputTokens: 1_000,
  committedTokens: 100,
  outputReserveTokens: 100,
  safetyMarginTokens: 50,
};

const estimator = {
  id: "characters",
  version: "1",
  exact: true,
  countSerialized: (text: string) => text.length,
  countSegment: (segment: { content: string }) => segment.content.length,
  countContextItem: (item: { content: string }) => item.content.length,
};

const serialization = {
  id: "json",
  version: "1",
  serialize: (
    fixedSegments: readonly unknown[],
    contextItems: readonly unknown[],
  ) => JSON.stringify({ fixedSegments, contextItems }),
};

const governance = (rules: PipelineRunInput["governance"]["rules"]) => ({
  budget,
  policies: {
    allowedActionsByType: new Map([
      ["goal", new Set(["KEEP", "DROP"] as const)],
      ["tool_output", new Set(["KEEP", "DROP"] as const)],
    ]),
    providerEscalationEnabled: false,
    fallbackByDecisionKind: new Map(),
    thresholds: { keepAtOrAbove: 0.65, retainAtOrAbove: 0.35 },
  },
  rules,
  enabledDecisionKinds: new Set(["KEEP", "DROP"] as const),
});

const assembly: PipelineRunInput["assembly"] = {
  fixedSegments: [],
  budget: {
    contextWindowTokens: 1_000,
    outputReserveTokens: 100,
    safetyMarginTokens: 50,
  },
  estimator,
  serialization,
};

const goal: NewContextItem = {
  id: "goal-implement-mvp",
  type: "goal",
  content: "Implement the deterministic MVP",
  metadata: { source: "user", priority: 1, pinned: true },
};

export const EVALUATION_SCENARIOS: readonly EvaluationScenario[] = [
  {
    id: "retain-high-signal-goal",
    items: [goal],
    pipeline: {
      ingestionOptions: { clock: "2026-01-01T00:00:00Z", estimator: { estimate: (text) => text.length } },
      governance: governance([]),
      assembly,
    },
    expectedKeptItemIds: [goal.id],
  },
  {
    id: "drop-stale-tool-output",
    items: [
      goal,
      {
        id: "stale-tool-output",
        type: "tool_output",
        content: "An obsolete command result",
        metadata: { source: "tool" },
      },
    ],
    pipeline: {
      ingestionOptions: { clock: "2026-01-01T00:00:00Z", estimator: { estimate: (text) => text.length } },
      governance: governance([{
        ruleId: "drop-stale-output",
        priority: 1,
        scope: "item",
        itemId: "stale-tool-output",
        action: "DROP",
      }]),
      assembly,
    },
    expectedKeptItemIds: [goal.id],
  },
];

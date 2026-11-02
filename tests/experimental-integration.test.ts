import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectExperimentalContext,
  fitInjectionPayload,
  runExperimentalAdapter,
} from "../experimental/adapter.ts";
import {
  compareEvaluationWorkload,
  saveEvaluationComparison,
} from "../evaluation/harness.ts";

import type { ExperimentalContextInput, ExperimentalIntegrationConfig } from "../experimental/adapter.ts";
import type { EvaluationWorkload } from "../evaluation/harness.ts";

const fixedSegments = [{
  id: "task",
  role: "user" as const,
  content: "Fix the reported issue",
  fixed: true,
  order: 0,
}];

const contextItems: readonly ExperimentalContextInput[] = [
  {
    id: "goal-1",
    type: "goal",
    content: "Complete the requested code change",
    source: "user",
    pinned: true,
  },
  {
    id: "tool-1",
    type: "tool_output",
    content: "An old and irrelevant command output",
    source: "terminal",
  },
];

const config: ExperimentalIntegrationConfig = {
  ecc_curator: {
    enabled: true,
    contextWindowTokens: 2_000,
    outputReserveTokens: 100,
    safetyMarginTokens: 50,
    rules: [{
      ruleId: "drop-old-tool-output",
      priority: 1,
      scope: "item",
      itemId: "tool-1",
      action: "DROP",
    }],
  },
};

test("disabled adapter sends the baseline prompt directly without collecting context", async () => {
  let receivedPrompt = "";
  const result = await runExperimentalAdapter(
    { ecc_curator: { enabled: false, maxItems: -1 } },
    {
      baselinePrompt: "host-built baseline prompt",
      fixedSegments,
      contextItems,
      execute: (prompt) => {
        receivedPrompt = prompt;
        return "done";
      },
    },
  );

  assert.equal(result.mode, "baseline");
  assert.equal(result.prompt, "host-built baseline prompt");
  assert.equal(receivedPrompt, "host-built baseline prompt");
  assert.equal(result.output, "done");
});

test("context collection applies type and character bounds with explicit drop reasons", () => {
  const result = collectExperimentalContext([
    { id: "first", type: "file", content: "012345678901234" },
    { id: "second", type: "plan", content: "abcdef" },
    { id: "third", type: "task", content: "not enough room" },
  ], {
    maxItems: 3,
    maxCharactersPerItem: 10,
    maxTotalCharacters: 12,
  });

  assert.equal(result.inputItemCount, 3);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((item) => item.content.length <= 10));
  assert.equal(result.collectedCharacters, 12);
  assert.deepEqual(result.truncatedItemIds, ["first", "second"]);
  assert.deepEqual(result.droppedItems, [{ id: "third", reason: "max_total_characters" }]);
});

test("context collection excludes types outside the experimental allowlist", () => {
  const unsupported = {
    id: "memory-1",
    type: "memory",
    content: "Not part of this experiment",
  } as unknown as ExperimentalContextInput;
  const result = collectExperimentalContext([unsupported]);

  assert.equal(result.items.length, 0);
  assert.deepEqual(result.droppedItems, [{ id: "memory-1", reason: "unsupported_type" }]);
});

test("context collection enforces the maximum item count", () => {
  const result = collectExperimentalContext([
    { id: "one", type: "task", content: "one" },
    { id: "two", type: "task", content: "two" },
  ], {
    maxItems: 1,
    maxCharactersPerItem: 10,
    maxTotalCharacters: 20,
  });

  assert.deepEqual(result.items.map((item) => item.id), ["one"]);
  assert.deepEqual(result.droppedItems, [{ id: "two", reason: "max_items" }]);
});

test("enabled adapter runs the deterministic pipeline and sends its assembled prompt", async () => {
  let receivedPrompt = "";
  const result = await runExperimentalAdapter(config, {
    baselinePrompt: "unmodified host prompt",
    fixedSegments,
    contextItems,
    execute: (prompt) => {
      receivedPrompt = prompt;
      return "agent output";
    },
  });

  assert.equal(result.mode, "governed");
  if (result.mode !== "governed") {
    return;
  }
  assert.equal(receivedPrompt, result.pipeline.assembly.ok
    ? result.pipeline.assembly.package.serializedInput
    : "");
  assert.equal(result.output, "agent output");
  assert.equal(result.itemsKept, 1);
  assert.equal(result.itemsDropped, 1);
  assert.deepEqual(result.collection.items.map((item) => item.id), ["goal-1", "tool-1"]);
  assert.equal(result.pipeline.governance.decisions.find((decision) => decision.itemId === "tool-1")?.action, "DROP");
  assert.ok(result.promptTokens > 0);
  assert.ok(result.contextTokens > 0);
});

test("comparison runs baseline then governed on one workload and records requested metrics", async () => {
  const workload: EvaluationWorkload = {
    id: "issue-42",
    baselinePrompt: "Fix the reported issue with all supplied context",
    fixedSegments,
    contextItems,
  };
  const invocations: { mode: string; workloadId: string; prompt: string }[] = [];

  const comparison = await compareEvaluationWorkload(workload, config, async (prompt, mode, workloadId) => {
    invocations.push({ mode, workloadId, prompt });
    return {
      taskCompleted: mode === "baseline",
      testsPassed: mode === "baseline" ? 3 : 2,
      testsTotal: 3,
      retries: mode === "baseline" ? 0 : 1,
      errors: 0,
    };
  });

  assert.deepEqual(invocations.map(({ mode }) => mode), ["baseline", "governed"]);
  assert.ok(invocations.every(({ workloadId }) => workloadId === workload.id));
  assert.equal(comparison.runs[0].itemsKept, 2);
  assert.equal(comparison.runs[0].itemsDropped, 0);
  assert.equal(comparison.runs[1].itemsKept, 1);
  assert.equal(comparison.runs[1].itemsDropped, 1);
  assert.equal(comparison.runs[0].taskCompleted, true);
  assert.equal(comparison.runs[1].taskCompleted, false);
  assert.equal(comparison.runs[0].testPassRate, 1);
  assert.equal(comparison.runs[1].testPassRate, 2 / 3);
  assert.equal(comparison.runs[1].retries, 1);
  assert.equal(comparison.runs[1].errors, 0);
  for (const run of comparison.runs) {
    if (
      run.promptTokens === null ||
      run.promptUtilisation === null ||
      run.contextUtilisation === null
    ) {
      throw new Error("successful run should have prompt and utilization measurements");
    }
    assert.ok(run.promptTokens > 0);
    assert.ok(run.sessionDurationMs >= 0);
    assert.ok(run.promptUtilisation >= 0);
    assert.ok(run.contextUtilisation >= 0);
  }
});

test("agent exceptions are recorded as failed runs and do not stop the paired evaluation", async () => {
  const comparison = await compareEvaluationWorkload({
    id: "agent-error",
    baselinePrompt: "same task",
    fixedSegments,
    contextItems,
  }, config, async (_prompt, mode) => {
    if (mode === "baseline") {
      throw new Error("runtime unavailable");
    }
    return { taskCompleted: true, testsPassed: 1, testsTotal: 1, retries: 0, errors: 0 };
  });

  assert.equal(comparison.runs[0].taskCompleted, false);
  assert.equal(comparison.runs[0].errors, 1);
  assert.equal(comparison.runs[1].taskCompleted, true);
  assert.equal(comparison.runs[1].errors, 0);
});

test("curator failures are recorded without fabricating prompt or context measurements", async () => {
  const comparison = await compareEvaluationWorkload({
    id: "curator-error",
    baselinePrompt: "same task",
    fixedSegments,
    contextItems: [
      { id: "duplicate", type: "task", content: "first" },
      { id: "duplicate", type: "task", content: "second" },
    ],
  }, config, async () => ({
    taskCompleted: true,
    testsPassed: 1,
    testsTotal: 1,
    retries: 0,
    errors: 0,
  }));

  assert.equal(comparison.runs[1].taskCompleted, false);
  assert.equal(comparison.runs[1].errors, 1);
  assert.equal(comparison.runs[1].errorStage, "curator");
  assert.equal(comparison.runs[1].promptTokens, null);
  assert.equal(comparison.runs[1].contextTokens, null);
  assert.equal(comparison.runs[1].itemsKept, null);
});

test("injection payload fitting keeps every item when the rendered payload is within its bound", () => {
  const fit = fitInjectionPayload(
    [
      { content: "AAA", pinned: true },
      { content: "BBB", pinned: false },
    ],
    20,
    (indexes, contents) => contents.join(""),
  );

  assert.equal(fit.fits, true);
  assert.deepEqual([...fit.keptIndexes], [0, 1]);
  assert.deepEqual([...fit.contents], ["AAA", "BBB"]);
  assert.equal(fit.droppedCount, 0);
  assert.equal(fit.truncatedCount, 0);
});

test("injection payload fitting drops lowest-ranked non-pinned items before touching pinned content", () => {
  const fit = fitInjectionPayload(
    [
      { content: "AAAA", pinned: true },
      { content: "BBBB", pinned: false },
      { content: "CCCC", pinned: false },
    ],
    8,
    (indexes, contents) => contents.join(""),
  );

  assert.equal(fit.fits, true);
  assert.deepEqual([...fit.keptIndexes], [0, 1]);
  assert.deepEqual([...fit.contents], ["AAAA", "BBBB"]);
  assert.equal(fit.droppedCount, 1);
  assert.equal(fit.truncatedCount, 0);
});

test("injection payload fitting truncates pinned content when only pinned items remain", () => {
  const fit = fitInjectionPayload(
    [
      { content: "AAAAAA", pinned: true },
      { content: "BBBBBB", pinned: true },
    ],
    8,
    (indexes, contents) => contents.join(""),
  );

  assert.equal(fit.fits, true);
  assert.deepEqual([...fit.keptIndexes], [0, 1]);
  assert.deepEqual([...fit.contents], ["AAAAAA", "BB"]);
  assert.equal(fit.truncatedCount, 1);
});

test("injection payload fitting remeasures non-contiguous retained indexes with framing", () => {
  const render = (_indexes: readonly number[], contents: readonly string[]) =>
    `HDR:${contents.join("|")}`;
  const fit = fitInjectionPayload(
    [
      { content: "AAA", pinned: false },
      { content: "PIN", pinned: true },
      { content: "ZZZ", pinned: false },
    ],
    6,
    render,
  );

  assert.equal(fit.fits, true);
  assert.deepEqual([...fit.keptIndexes], [1]);
  assert.deepEqual([...fit.contents], ["PI"]);
  assert.ok(render(fit.keptIndexes, fit.contents).length <= 6);
  assert.equal(fit.droppedCount, 2);
  assert.equal(fit.truncatedCount, 1);
});

test("injection payload fitting reports no fit when framing alone exceeds the bound", () => {
  const fit = fitInjectionPayload(
    [{ content: "AB", pinned: true }],
    5,
    (indexes, contents) => "HEADER:" + contents.join(""),
  );

  assert.equal(fit.fits, false);
  assert.equal(fit.keptIndexes.length, 0);
  assert.equal(fit.droppedCount, 1);
});

test("injection payload fitting rejects a negative character bound", async () => {
  await assert.rejects(
    async () => fitInjectionPayload([], -1, (_indexes, _contents) => ""),
    RangeError,
  );
});

test("evaluation results can be persisted as JSON without storing prompts", async () => {
  const workload: EvaluationWorkload = {
    id: "persist-check",
    baselinePrompt: "do not store this prompt",
    fixedSegments,
    contextItems,
  };
  const comparison = await compareEvaluationWorkload(workload, config, async () => ({
    taskCompleted: true,
    testsPassed: 1,
    testsTotal: 1,
    retries: 0,
    errors: 0,
  }));
  const directory = await mkdtemp(join(tmpdir(), "ecc-evaluation-"));

  try {
    const savedPath = await saveEvaluationComparison(comparison, "run-001", directory);
    const saved = await readFile(savedPath, "utf8");
    assert.match(saved, /"workloadId": "persist-check"/);
    assert.match(saved, /"promptTokens":/);
    assert.doesNotMatch(saved, /do not store this prompt/);
    await assert.rejects(saveEvaluationComparison(comparison, "../escape", directory), RangeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

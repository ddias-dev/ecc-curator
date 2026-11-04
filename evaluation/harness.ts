import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { estimateTokens } from "../src/token-estimator.ts";
import { runExperimentalAdapter } from "../experimental/adapter.ts";

import type {
  ExperimentalContextInput,
  ExperimentalIntegrationConfig,
} from "../experimental/adapter.ts";
import type { PromptSegment } from "../src/types/assembler.ts";

export type EvaluationMode = "baseline" | "governed";

export interface EvaluationTaskOutcome {
  taskCompleted: boolean;
  testsPassed: number;
  testsTotal: number;
  retries: number;
  errors: number;
}

export interface EvaluationWorkload {
  id: string;
  baselinePrompt: string;
  fixedSegments: readonly PromptSegment[];
  contextItems: readonly ExperimentalContextInput[];
}

export interface EvaluationRunMetrics {
  mode: EvaluationMode;
  promptTokens: number | null;
  contextTokens: number | null;
  itemsKept: number | null;
  itemsDropped: number | null;
  taskCompleted: boolean;
  testsPassed: number;
  testsTotal: number;
  testPassRate: number | null;
  retries: number;
  errors: number;
  errorStage: "agent" | "curator" | null;
  sessionDurationMs: number;
  promptUtilisation: number | null;
  contextUtilisation: number | null;
}

export interface EvaluationComparison {
  schemaVersion: "1";
  workloadId: string;
  contextWindowTokens: number;
  // Execution order the comparison actually used (fairness runners record it;
  // absent means the historical baseline-first, governed-second default).
  executionOrder?: readonly EvaluationMode[];
  runs: readonly [EvaluationRunMetrics, EvaluationRunMetrics];
}

interface MeasuredExecution {
  outcome: EvaluationTaskOutcome;
  sessionDurationMs: number;
  errorStage: "agent" | null;
}

export class InvalidEvaluationOutcomeError extends Error {
  constructor(message: string) {
    super(`Invalid evaluation outcome: ${message}`);
    this.name = "InvalidEvaluationOutcomeError";
  }
}

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidEvaluationOutcomeError(`${label} must be a non-negative safe integer`);
  }
}

function validateOutcome(outcome: EvaluationTaskOutcome): void {
  if (typeof outcome.taskCompleted !== "boolean") {
    throw new InvalidEvaluationOutcomeError("taskCompleted must be boolean");
  }
  requireCount(outcome.testsPassed, "testsPassed");
  requireCount(outcome.testsTotal, "testsTotal");
  requireCount(outcome.retries, "retries");
  requireCount(outcome.errors, "errors");
  if (outcome.testsPassed > outcome.testsTotal) {
    throw new InvalidEvaluationOutcomeError("testsPassed cannot exceed testsTotal");
  }
}

async function measureExecution(
  execute: (prompt: string, mode: EvaluationMode, workloadId: string) => Promise<EvaluationTaskOutcome>,
  prompt: string,
  mode: EvaluationMode,
  workloadId: string,
): Promise<MeasuredExecution> {
  const startedAt = performance.now();
  let outcome: EvaluationTaskOutcome;
  try {
    outcome = await execute(prompt, mode, workloadId);
  } catch {
    return {
      outcome: {
        taskCompleted: false,
        testsPassed: 0,
        testsTotal: 0,
        retries: 0,
        errors: 1,
      },
      sessionDurationMs: Math.max(0, performance.now() - startedAt),
      errorStage: "agent",
    };
  }
  validateOutcome(outcome);
  return {
    outcome,
    sessionDurationMs: Math.max(0, performance.now() - startedAt),
    errorStage: outcome.errors === 0 ? null : "agent",
  };
}

function toMetrics(
  mode: EvaluationMode,
  measured: MeasuredExecution,
  promptTokens: number,
  contextTokens: number,
  itemsKept: number,
  itemsDropped: number,
  contextWindowTokens: number,
): EvaluationRunMetrics {
  const { outcome } = measured;
  return {
    mode,
    promptTokens,
    contextTokens,
    itemsKept,
    itemsDropped,
    taskCompleted: outcome.taskCompleted,
    testsPassed: outcome.testsPassed,
    testsTotal: outcome.testsTotal,
    testPassRate: outcome.testsTotal === 0 ? null : outcome.testsPassed / outcome.testsTotal,
    retries: outcome.retries,
    errors: outcome.errors,
    errorStage: measured.errorStage,
    sessionDurationMs: measured.sessionDurationMs,
    promptUtilisation: promptTokens / contextWindowTokens,
    contextUtilisation: contextTokens / contextWindowTokens,
  };
}

export async function compareEvaluationWorkload(
  workload: EvaluationWorkload,
  config: ExperimentalIntegrationConfig,
  execute: (
    prompt: string,
    mode: EvaluationMode,
    workloadId: string,
  ) => Promise<EvaluationTaskOutcome>,
  // Evaluation-fairness knob: the execution ORDER of the two modes.
  // Default remains the historical "baseline first, governed second";
  // repeated-comparison runners pass alternating orders per repetition and
  // record the order actually used (evaluation/results must state it).
  order: EvaluationMode[] = ["baseline", "governed"],
): Promise<EvaluationComparison> {
  const contextWindowTokens = config.ecc_curator.contextWindowTokens ?? 32_768;
  requireCount(contextWindowTokens, "contextWindowTokens");
  if (contextWindowTokens === 0) {
    throw new InvalidEvaluationOutcomeError("contextWindowTokens must be greater than zero");
  }

  const runBaseline = async (): Promise<EvaluationRunMetrics> => {
    const baselineMeasured: { value?: MeasuredExecution } = {};
    const baselineStartedAt = performance.now();
    const baseline = await runExperimentalAdapter(
      { ecc_curator: { ...config.ecc_curator, enabled: false } },
      {
        baselinePrompt: workload.baselinePrompt,
        fixedSegments: workload.fixedSegments,
        contextItems: workload.contextItems,
        execute: async (prompt) => {
          const value = await measureExecution(execute, prompt, "baseline", workload.id);
          baselineMeasured.value = value;
          return value;
        },
      },
    );
    const baselineExecution = baselineMeasured.value;
    if (baseline.mode !== "baseline" || baselineExecution === undefined) {
      throw new Error("Baseline agent execution did not produce evaluation measurements");
    }
    const measuredBaseline: MeasuredExecution = {
      ...baselineExecution,
      sessionDurationMs: Math.max(0, performance.now() - baselineStartedAt),
    };
    const baselineContextTokens = workload.contextItems.reduce(
      (total, item) => total + estimateTokens(item.content),
      0,
    );
    return toMetrics(
      "baseline",
      measuredBaseline,
      estimateTokens(baseline.prompt),
      baselineContextTokens,
      workload.contextItems.length,
      0,
      contextWindowTokens,
    );
  };

  const runGoverned = async (): Promise<EvaluationRunMetrics> => {
    const governedMeasured: { value?: MeasuredExecution } = {};
    const governedStartedAt = performance.now();
    try {
      const governed = await runExperimentalAdapter(
        { ecc_curator: { ...config.ecc_curator, enabled: true } },
        {
          baselinePrompt: workload.baselinePrompt,
          fixedSegments: workload.fixedSegments,
          contextItems: workload.contextItems,
          execute: async (prompt) => {
            const value = await measureExecution(execute, prompt, "governed", workload.id);
            governedMeasured.value = value;
            return value;
          },
        },
      );
      if (governed.mode !== "governed" || governedMeasured.value === undefined) {
        throw new Error("ECC Curator execution did not produce governed evaluation measurements");
      }
      const governedExecution: MeasuredExecution = {
        ...governedMeasured.value,
        sessionDurationMs: Math.max(0, performance.now() - governedStartedAt),
      };
      return toMetrics(
        "governed",
        governedExecution,
        governed.promptTokens,
        governed.contextTokens,
        governed.itemsKept,
        governed.itemsDropped,
        contextWindowTokens,
      );
    } catch (error) {
      if (error instanceof InvalidEvaluationOutcomeError) {
        throw error;
      }
      return {
        mode: "governed",
        promptTokens: null,
        contextTokens: null,
        itemsKept: null,
        itemsDropped: null,
        taskCompleted: false,
        testsPassed: 0,
        testsTotal: 0,
        testPassRate: null,
        retries: 0,
        errors: 1,
        errorStage: "curator",
        sessionDurationMs: Math.max(0, performance.now() - governedStartedAt),
        promptUtilisation: null,
        contextUtilisation: null,
      };
    }
  };

  const normalizedOrder: EvaluationMode[] =
    order.length === 2 && order[0] === "governed" && order[1] === "baseline"
      ? ["governed", "baseline"]
      : ["baseline", "governed"];
  const metricsByMode: Record<EvaluationMode, EvaluationRunMetrics> = {};
  for (const mode of normalizedOrder) {
    metricsByMode[mode] = mode === "baseline" ? await runBaseline() : await runGoverned();
  }
  return {
    schemaVersion: "1",
    workloadId: workload.id,
    contextWindowTokens,
    executionOrder: normalizedOrder,
    runs: [metricsByMode.baseline, metricsByMode.governed],
  };
}

export async function saveEvaluationComparison(
  comparison: EvaluationComparison,
  resultId: string,
  outputDirectory = "evaluation",
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(resultId)) {
    throw new RangeError("resultId may contain only letters, numbers, dots, underscores, and hyphens");
  }
  const directory = resolve(outputDirectory);
  const filePath = join(directory, `${resultId}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(comparison, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return filePath;
}

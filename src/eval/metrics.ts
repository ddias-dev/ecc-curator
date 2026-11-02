import type { PipelineRunResult } from "../pipeline/run.ts";
import type { PromptTokenEstimator } from "../types/assembler.ts";

export interface EvaluationTaskOutcome {
  succeeded: boolean;
  passedTests: number;
  totalTests: number;
}

export interface EvaluationMeasurements {
  rawTokens: number;
  curatedTokens: number;
  inputItemCount: number;
  retainedItemCount: number;
  outcomes: readonly EvaluationTaskOutcome[];
}

export interface EvaluationMetrics {
  tokenSavings: number;
  tokenReductionRate: number;
  retentionRate: number;
  taskSuccessRate: number;
  testPassRate: number;
}

export class InvalidEvaluationMeasurementsError extends Error {
  constructor(message: string) {
    super(`Invalid evaluation measurements: ${message}`);
    this.name = "InvalidEvaluationMeasurementsError";
  }
}

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidEvaluationMeasurementsError(`${label} must be a non-negative safe integer`);
  }
}

function countContextTokens(
  items: readonly PipelineRunResult["inventory"]["items"][number][],
  estimator: Pick<PromptTokenEstimator, "countContextItem">,
): number {
  return items.reduce((total, item) => {
    const itemTokens = estimator.countContextItem(item);
    requireCount(itemTokens, `token estimate for item ${item.id}`);
    const nextTotal = total + itemTokens;
    requireCount(nextTotal, "context token total");
    return nextTotal;
  }, 0);
}

export function calculateEvaluationMetrics(
  measurements: EvaluationMeasurements,
): EvaluationMetrics {
  const {
    rawTokens,
    curatedTokens,
    inputItemCount,
    retainedItemCount,
    outcomes,
  } = measurements;

  requireCount(rawTokens, "rawTokens");
  requireCount(curatedTokens, "curatedTokens");
  requireCount(inputItemCount, "inputItemCount");
  requireCount(retainedItemCount, "retainedItemCount");
  if (rawTokens === 0 || inputItemCount === 0 || outcomes.length === 0) {
    throw new InvalidEvaluationMeasurementsError(
      "token, item, and task outcome denominators must be greater than zero",
    );
  }
  if (retainedItemCount > inputItemCount) {
    throw new InvalidEvaluationMeasurementsError("retainedItemCount cannot exceed inputItemCount");
  }

  let successfulTasks = 0;
  let passedTests = 0;
  let totalTests = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (typeof outcome.succeeded !== "boolean") {
      throw new InvalidEvaluationMeasurementsError(`outcomes[${index}].succeeded must be boolean`);
    }
    requireCount(outcome.passedTests, `outcomes[${index}].passedTests`);
    requireCount(outcome.totalTests, `outcomes[${index}].totalTests`);
    if (outcome.totalTests === 0 || outcome.passedTests > outcome.totalTests) {
      throw new InvalidEvaluationMeasurementsError(
        `outcomes[${index}] must have a positive test count and passedTests cannot exceed totalTests`,
      );
    }
    successfulTasks += Number(outcome.succeeded);
    passedTests += outcome.passedTests;
    totalTests += outcome.totalTests;
    requireCount(successfulTasks, "successful task total");
    requireCount(passedTests, "passed test total");
    requireCount(totalTests, "total test count");
  }

  const tokenSavings = rawTokens - curatedTokens;
  return {
    tokenSavings,
    tokenReductionRate: tokenSavings / rawTokens,
    retentionRate: retainedItemCount / inputItemCount,
    taskSuccessRate: successfulTasks / outcomes.length,
    testPassRate: passedTests / totalTests,
  };
}

export function measurePipelineResult(
  result: Pick<PipelineRunResult, "inventory" | "assembly">,
  outcomes: readonly EvaluationTaskOutcome[],
  estimator: Pick<PromptTokenEstimator, "countContextItem">,
): EvaluationMetrics {
  if (!result.assembly.ok) {
    throw new InvalidEvaluationMeasurementsError(
      `cannot measure an unsuccessful assembly (${result.assembly.error})`,
    );
  }

  return calculateEvaluationMetrics({
    rawTokens: countContextTokens(result.inventory.items, estimator),
    curatedTokens: countContextTokens(result.assembly.package.contextItems, estimator),
    inputItemCount: result.inventory.items.length,
    retainedItemCount: result.assembly.package.contextItems.length,
    outcomes,
  });
}

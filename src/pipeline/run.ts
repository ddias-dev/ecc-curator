import { createInventory } from "../inventory/inventory.ts";
import { assemble } from "../assembler/assemble.ts";
import { deriveWorkingBudget, govern } from "../governor/govern.ts";
import { scoreItems } from "../scoring/score.ts";

import type { ApprovedContextItem, AssemblyRequest, AssemblyResult } from "../types/assembler.ts";
import type { BudgetState, GovernancePolicySet, GovernanceRule } from "../types/governance.ts";
import type { GovernanceDecision, ContextItem } from "../types/context.ts";
import type { GovernanceDecisionRecord } from "../types/governance.ts";
import type { ScoringConfig } from "../types/scoring.ts";
import type { ScoredContextBatch } from "../scoring/score.ts";
import type { InventoryInitOptions } from "../inventory/inventory.ts";
import type { ContextInventorySnapshot } from "../types/inventory.ts";
import type { NewContextItem } from "../types/inventory.ts";

export interface GovernanceStageInput {
  budget: BudgetState;
  policies: GovernancePolicySet;
  rules: readonly GovernanceRule[];
  enabledDecisionKinds: ReadonlySet<GovernanceDecision>;
  scoringConfig?: ScoringConfig;
}

export interface GovernanceStageResult {
  scoring: ScoredContextBatch;
  governance: ReturnType<typeof govern>;
}

export interface PipelineRunInput {
  ingestionOptions?: InventoryInitOptions;
  governance: GovernanceStageInput;
  assembly: Omit<AssemblyRequest, "candidates">;
}

export interface PipelineRunResult extends GovernanceStageResult {
  inventory: ContextInventorySnapshot;
  assembly: AssemblyResult;
}

export function ingestContext(
  items: readonly NewContextItem[],
  options?: InventoryInitOptions,
): ContextInventorySnapshot {
  const inventory = createInventory(options);
  for (const item of items) {
    inventory.add(item);
  }
  return inventory.snapshot();
}

export function scoreAndGovern(
  inventory: ContextInventorySnapshot,
  input: GovernanceStageInput,
): GovernanceStageResult {
  const workingBudget = deriveWorkingBudget(input.budget);
  const scoring = scoreItems(inventory.items, workingBudget, input.scoringConfig);
  const governance = govern({
    inventory,
    policies: input.policies,
    rules: input.rules,
    budget: input.budget,
    scores: scoring.scores,
    enabledDecisionKinds: input.enabledDecisionKinds,
  });
  return { scoring, governance };
}

export function toAssemblyCandidates(
  items: readonly ContextItem[],
  decisions: readonly GovernanceDecisionRecord[],
): ApprovedContextItem[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return decisions.flatMap((decision) => {
    if (decision.action !== "KEEP") {
      return [];
    }

    const item = itemsById.get(decision.itemId);
    if (item === undefined) {
      throw new Error(`Governance decision references missing inventory item: ${decision.itemId}`);
    }

    return [{
      item,
      action: "KEEP",
      score: decision.score,
      policyPriority: 1 - item.metadata.priority,
      category: item.type,
      tokenCount: item.tokenCount,
    }];
  });
}

export function assembleGoverned(
  items: readonly ContextItem[],
  decisions: readonly GovernanceDecisionRecord[],
  request: Omit<AssemblyRequest, "candidates">,
): AssemblyResult {
  return assemble({
    ...request,
    candidates: toAssemblyCandidates(items, decisions),
  });
}

export function runPipeline(
  items: readonly NewContextItem[],
  input: PipelineRunInput,
): PipelineRunResult {
  const inventory = ingestContext(items, input.ingestionOptions);
  const { scoring, governance } = scoreAndGovern(inventory, input.governance);
  const assembly = assembleGoverned(inventory.items, governance.decisions, input.assembly);
  return { inventory, scoring, governance, assembly };
}

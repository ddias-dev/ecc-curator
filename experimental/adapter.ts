import { estimateTokens, defaultTokenEstimator } from "../src/token-estimator.ts";
import { runPipeline } from "../src/pipeline/run.ts";

import type { GovernancePolicySet, GovernanceRule } from "../src/types/governance.ts";
import type { PromptSegment, PromptTokenEstimator, PromptSerialization } from "../src/types/assembler.ts";
import type { ContextType } from "../src/types/context.ts";
import type { NewContextItem } from "../src/types/inventory.ts";
import type { PipelineRunResult } from "../src/pipeline/run.ts";

export const EXPERIMENTAL_CONTEXT_TYPES = [
  "goal",
  "task",
  "file",
  "diff",
  "terminal_output",
  "tool_output",
  "test_result",
  "plan",
] as const satisfies readonly ContextType[];

export type ExperimentalContextType = typeof EXPERIMENTAL_CONTEXT_TYPES[number];

export interface ExperimentalContextInput {
  id: string;
  type: ExperimentalContextType;
  content: string;
  source?: string;
  priority?: number;
  pinned?: boolean;
}

export interface ExperimentalIntegrationConfig {
  ecc_curator: {
    enabled: boolean;
    maxItems?: number;
    maxCharactersPerItem?: number;
    maxTotalCharacters?: number;
    contextWindowTokens?: number;
    outputReserveTokens?: number;
    safetyMarginTokens?: number;
    maxPromptTokens?: number;
    rules?: readonly GovernanceRule[];
  };
}

export interface ContextCollectionLimits {
  maxItems: number;
  maxCharactersPerItem: number;
  maxTotalCharacters: number;
}

export interface ContextCollectionResult {
  items: readonly NewContextItem[];
  inputItemCount: number;
  droppedItems: readonly { id: string; reason: "unsupported_type" | "max_items" | "max_total_characters" }[];
  truncatedItemIds: readonly string[];
  collectedCharacters: number;
}

export interface InjectionPayloadFit {
  fits: boolean;
  keptIndexes: readonly number[];
  contents: readonly string[];
  droppedCount: number;
  truncatedCount: number;
}

interface InjectionPayloadCandidate {
  content: string;
  pinned: boolean;
}

export function fitInjectionPayload(
  items: readonly InjectionPayloadCandidate[],
  maximumCharacters: number,
  render: (keptIndexes: readonly number[], contents: readonly string[]) => string,
): InjectionPayloadFit {
  requireLimit(maximumCharacters, "maximumCharacters");

  const pinnedByIndex = items.map((item) => item.pinned === true);
  let contents = items.map((item) => item.content);
  let keptIndexes = items.map((_item, index) => index);
  const truncatedIndexes = new Set<number>();

  const measure = (indexes: readonly number[], candidateContents: readonly string[]) =>
    render(indexes, indexes.map((index) => candidateContents[index])).length;

  let payloadCharacters = measure(keptIndexes, contents);

  while (payloadCharacters > maximumCharacters) {
    const removablePosition = keptIndexes.findLastIndex((index) => !pinnedByIndex[index]);
    if (removablePosition < 0) {
      break;
    }
    keptIndexes = keptIndexes.filter((_, position) => position !== removablePosition);
    payloadCharacters = measure(keptIndexes, contents);
  }

  if (payloadCharacters > maximumCharacters) {
    while (payloadCharacters > maximumCharacters) {
      const shrinkablePosition = keptIndexes.findLastIndex((index) => contents[index].length > 0);
      if (shrinkablePosition < 0) {
        return {
          fits: false,
          keptIndexes: [],
          contents: [],
          droppedCount: items.length,
          truncatedCount: 0,
        };
      }
      const shrinkableIndex = keptIndexes[shrinkablePosition];
      const excess = payloadCharacters - maximumCharacters;
      contents = contents.map((content, index) =>
        index === shrinkableIndex
          ? content.slice(0, Math.max(0, content.length - Math.max(1, excess)))
          : content,
      );
      truncatedIndexes.add(shrinkableIndex);
      payloadCharacters = measure(keptIndexes, contents);
    }
  }

  const finalContents = keptIndexes.map((index) => contents[index]);
  return {
    fits: true,
    keptIndexes,
    contents: finalContents,
    droppedCount: items.length - keptIndexes.length,
    truncatedCount: truncatedIndexes.size,
  };
}

interface ExperimentalTurnRequest<T> {
  baselinePrompt: string;
  fixedSegments: readonly PromptSegment[];
  contextItems: readonly ExperimentalContextInput[];
  execute: (prompt: string) => T | Promise<T>;
}

export interface BaselineTurnResult<T> {
  mode: "baseline";
  prompt: string;
  output: T;
}

export interface GovernedTurnResult<T> {
  mode: "governed";
  prompt: string;
  output: T;
  pipeline: PipelineRunResult;
  collection: ContextCollectionResult;
  promptTokens: number;
  contextTokens: number;
  itemsKept: number;
  itemsDropped: number;
}

export type ExperimentalTurnResult<T> = BaselineTurnResult<T> | GovernedTurnResult<T>;

export const DEFAULT_CONTEXT_COLLECTION_LIMITS: ContextCollectionLimits = {
  maxItems: 64,
  maxCharactersPerItem: 10_000,
  maxTotalCharacters: 40_000,
};

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
const DEFAULT_OUTPUT_RESERVE_TOKENS = 2_048;
const DEFAULT_SAFETY_MARGIN_TOKENS = 512;
const TRUNCATION_MARKER = "\n[truncated by experimental ECC context limit]";
const EXPERIMENTAL_TYPE_SET: ReadonlySet<string> = new Set(EXPERIMENTAL_CONTEXT_TYPES);

function requireLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function truncateContent(content: string, maximumCharacters: number): string {
  if (content.length <= maximumCharacters) {
    return content;
  }
  if (maximumCharacters <= TRUNCATION_MARKER.length) {
    return content.slice(0, maximumCharacters);
  }
  return content.slice(0, maximumCharacters - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

export function collectExperimentalContext(
  inputs: readonly ExperimentalContextInput[],
  limits: ContextCollectionLimits = DEFAULT_CONTEXT_COLLECTION_LIMITS,
): ContextCollectionResult {
  requireLimit(limits.maxItems, "maxItems");
  requireLimit(limits.maxCharactersPerItem, "maxCharactersPerItem");
  requireLimit(limits.maxTotalCharacters, "maxTotalCharacters");

  const items: NewContextItem[] = [];
  const droppedItems: { id: string; reason: "unsupported_type" | "max_items" | "max_total_characters" }[] = [];
  const truncatedItemIds: string[] = [];
  let collectedCharacters = 0;

  for (const input of inputs) {
    if (!EXPERIMENTAL_TYPE_SET.has(input.type)) {
      droppedItems.push({ id: input.id, reason: "unsupported_type" });
      continue;
    }
    if (items.length >= limits.maxItems) {
      droppedItems.push({ id: input.id, reason: "max_items" });
      continue;
    }

    let content = input.content;
    let itemWasTruncated = false;
    if (content.length > limits.maxCharactersPerItem) {
      content = truncateContent(content, limits.maxCharactersPerItem);
      itemWasTruncated = true;
    }

    const remainingCharacters = limits.maxTotalCharacters - collectedCharacters;
    if (content.length > remainingCharacters) {
      if (remainingCharacters === 0) {
        droppedItems.push({ id: input.id, reason: "max_total_characters" });
        continue;
      }
      content = truncateContent(content, remainingCharacters);
      itemWasTruncated = true;
    }

    items.push({
      id: input.id,
      type: input.type,
      content,
      metadata: {
        source: input.source ?? "experimental-agent-runtime",
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      },
    });
    collectedCharacters += content.length;
    if (itemWasTruncated) {
      truncatedItemIds.push(input.id);
    }
  }

  return {
    items,
    inputItemCount: inputs.length,
    droppedItems,
    truncatedItemIds: [...new Set(truncatedItemIds)],
    collectedCharacters,
  };
}

function createPromptEstimator(): PromptTokenEstimator {
  return {
    id: "ecc-default-conservative",
    version: "1",
    exact: false,
    countSerialized: estimateTokens,
    countSegment: (segment) => estimateTokens(segment.content),
    countContextItem: (item) => estimateTokens(item.content),
  };
}

const promptSerialization: PromptSerialization = {
  id: "ecc-experimental-json",
  version: "1",
  serialize: (fixedSegments, contextItems) => JSON.stringify({ fixedSegments, contextItems }),
};

function createPolicies(): GovernancePolicySet {
  return {
    allowedActionsByType: new Map(
      EXPERIMENTAL_CONTEXT_TYPES.map((type) => [type, new Set(["KEEP", "DROP"] as const)]),
    ),
    providerEscalationEnabled: false,
    fallbackByDecisionKind: new Map(),
    thresholds: { keepAtOrAbove: 0.65, retainAtOrAbove: 0.35 },
  };
}

function requireAssemblyPrompt(result: PipelineRunResult): string {
  if (!result.assembly.ok) {
    throw new Error(`ECC Curator prompt assembly failed: ${result.assembly.error}`);
  }
  return result.assembly.package.serializedInput;
}

export async function runExperimentalAdapter<T>(
  config: ExperimentalIntegrationConfig,
  request: ExperimentalTurnRequest<T>,
): Promise<ExperimentalTurnResult<T>> {
  if (!config.ecc_curator.enabled) {
    return {
      mode: "baseline",
      prompt: request.baselinePrompt,
      output: await request.execute(request.baselinePrompt),
    };
  }

  const settings = config.ecc_curator;
  const collection = collectExperimentalContext(request.contextItems, {
    maxItems: settings.maxItems ?? DEFAULT_CONTEXT_COLLECTION_LIMITS.maxItems,
    maxCharactersPerItem:
      settings.maxCharactersPerItem ?? DEFAULT_CONTEXT_COLLECTION_LIMITS.maxCharactersPerItem,
    maxTotalCharacters:
      settings.maxTotalCharacters ?? DEFAULT_CONTEXT_COLLECTION_LIMITS.maxTotalCharacters,
  });
  const promptEstimator = createPromptEstimator();
  const contextWindowTokens = settings.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const outputReserveTokens = settings.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const safetyMarginTokens = settings.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  const committedTokens = request.fixedSegments.reduce(
    (total, segment) => total + promptEstimator.countSegment(segment),
    0,
  );

  const pipeline = runPipeline(collection.items, {
    ingestionOptions: { estimator: defaultTokenEstimator },
    governance: {
      budget: {
        availableInputTokens: contextWindowTokens,
        committedTokens,
        outputReserveTokens,
        safetyMarginTokens,
      },
      policies: createPolicies(),
      rules: settings.rules ?? [],
      enabledDecisionKinds: new Set(["KEEP", "DROP"]),
    },
    assembly: {
      fixedSegments: request.fixedSegments,
      budget: {
        contextWindowTokens,
        outputReserveTokens,
        safetyMarginTokens,
        ...(settings.maxPromptTokens === undefined ? {} : { maxPromptTokens: settings.maxPromptTokens }),
      },
      estimator: promptEstimator,
      serialization: promptSerialization,
    },
  });

  const prompt = requireAssemblyPrompt(pipeline);
  const output = await request.execute(prompt);
  const retainedItems = pipeline.assembly.ok ? pipeline.assembly.package.contextItems : [];

  return {
    mode: "governed",
    prompt,
    output,
    pipeline,
    collection,
    promptTokens: promptEstimator.countSerialized(prompt),
    contextTokens: retainedItems.reduce(
      (total, item) => total + promptEstimator.countContextItem(item),
      0,
    ),
    itemsKept: retainedItems.length,
    itemsDropped: request.contextItems.length - retainedItems.length,
  };
}

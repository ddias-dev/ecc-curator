// Prompt-segment roles defined by docs/PROMPT_ASSEMBLER.md.
import type { ContextItem } from "./context.ts";

export type PromptSegmentRole = "system" | "developer" | "user" | "context";

export interface PromptSegment {
  id: string;
  role: PromptSegmentRole;
  content: string;
  fixed: boolean;
  order: number;
}

export interface ApprovedContextItem {
  item: ContextItem;
  action: "KEEP" | "COMPRESS" | "TRANSFORM";
  score: number;
  policyPriority: number;
  category: string;
  tokenCount: number;
}

export interface AssemblyBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  maxPromptTokens?: number;
}

export interface PromptTokenEstimator {
  readonly id: string;
  readonly version: string;
  readonly exact: boolean;
  countSerialized(text: string): number;
  countSegment(segment: PromptSegment): number;
  countContextItem(item: ContextItem): number;
}

export interface PromptSerialization {
  readonly id: string;
  readonly version: string;
  serialize(
    fixedSegments: readonly PromptSegment[],
    contextItems: readonly ContextItem[],
  ): string;
}

export interface AssemblyRequest {
  fixedSegments: readonly PromptSegment[];
  candidates: readonly ApprovedContextItem[];
  budget: AssemblyBudget;
  allocations?: Readonly<Record<string, number>>;
  overflowPolicy?: "exclude-lowest-ranked" | "error";
  estimator: PromptTokenEstimator;
  serialization: PromptSerialization;
}

export interface AssemblyItemRecord {
  itemId: string;
  category: string;
  tokenCount: number;
  score: number;
  reasonCode: string;
}

export interface AssemblyReport {
  included: readonly AssemblyItemRecord[];
  excluded: readonly AssemblyItemRecord[];
  tokenCounts: {
    fixedSegments: number;
    contextItems: number;
    serializedPackage: number;
  };
  allocationUse: Readonly<Record<string, number>>;
  overflow?: {
    requiredTokens: number;
    availableTokens: number;
    pinnedItemIds: readonly string[];
  };
}

export interface PromptPackage {
  schemaVersion: "1";
  segments: readonly PromptSegment[];
  contextItems: readonly ContextItem[];
  serializedInput: string;
  tokenCount: number;
  budget: {
    contextWindowTokens: number;
    outputReserveTokens: number;
    safetyMarginTokens: number;
    inputLimitTokens: number;
    remainingTokens: number;
  };
  report: AssemblyReport;
}

export type AssemblyResult =
  | { ok: true; package: PromptPackage }
  | {
      ok: false;
      error:
        | "FixedPromptOverflow"
        | "PinnedContextOverflow"
        | "UnresolvableOverflow"
        | "InvalidBudget"
        | "InvalidTokenEstimate";
      report: AssemblyReport;
    };

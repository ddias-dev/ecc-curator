// ECC Curator — governance contracts.
// Source of truth: docs/GOVERNOR_ALGORITHM.md (with docs/DECISIONS.md,
// docs/DECISION_INTELLIGENCE.md, docs/INVENTORY_API.md).
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums.
// The Governor owns final decisions; providers only return proposals.

import type { ContextType, GovernanceDecision } from "./context.ts";
import type { ContextInventorySnapshot } from "./inventory.ts";

// Alias of the base GovernanceDecision contract values
// ("KEEP" | "DROP" | "COMPRESS" | "TRANSFORM" from ../types/context.ts).
export type DecisionKind = GovernanceDecision;

// Explicit budget accounting handed to the Governor. Fixed prompt content and
// model output are reserved before context items are allocated
// (docs/GOVERNOR_ALGORITHM.md, "Budget-pressure behavior").
export interface BudgetState {
  availableInputTokens: number; // integer >= 0; available input-token budget
  committedTokens: number; // integer >= 0; already committed prompt tokens
  outputReserveTokens: number; // integer >= 0; reserved for model output
  safetyMarginTokens: number; // integer >= 0; conservative headroom
}

// Deterministic rule: explicit predicate + action. Precedence is item-scope,
// then context_type-scope, then global-scope; within the same level, lower
// numeric priority wins, then stable ruleId ascending. A rule's action must be
// allowed by policy.
export interface GovernanceRule {
  ruleId: string;
  priority: number; // integer; lower numeric priority wins within a scope level
  scope: "item" | "context_type" | "global";
  itemId?: string; // required when scope === "item"
  contextType?: ContextType; // required when scope === "context_type"
  action: GovernanceDecision;
}

// Policy set: allowed actions per context type, provider permissions,
// ambiguity window, decision-kind fallbacks, and thresholds.
// Requires 0 <= retainAtOrAbove <= keepAtOrAbove <= 1; reproducibility
// defaults are keepAtOrAbove = 0.65 and retainAtOrAbove = 0.35.
export interface GovernancePolicySet {
  allowedActionsByType: ReadonlyMap<string, ReadonlySet<GovernanceDecision>>;
  providerEscalationEnabled: boolean; // provider use is optional, disabled by default
  ambiguityRange?: {
    min: number; // heuristic score lower bound (inclusive)
    max: number; // heuristic score upper bound (inclusive)
  };
  fallbackByDecisionKind: ReadonlyMap<string, GovernanceDecision>;
  thresholds: {
    keepAtOrAbove: number; // normalized [0, 1]
    retainAtOrAbove: number; // normalized [0, 1]
  };
}

// The Governor's full input surface: a consistent snapshot, rules, policies,
// current budget, heuristic scores in [0, 1], an optional provider source,
// and the enabled decision kinds.
export interface GovernorInput {
  inventory: ContextInventorySnapshot;
  policies: GovernancePolicySet;
  rules: readonly GovernanceRule[];
  budget: BudgetState;
  scores: ReadonlyMap<string, number>; // itemId -> finite normalized score
  decisionProvider?: ProviderProposalSource;
  enabledDecisionKinds: ReadonlySet<DecisionKind>;
}

// Minimal provider-neutral proposal shape. Providers are optional; the
// Governor validates proposals against policy and retains final decision
// authority. A proposal is advisory, never the final action by itself.
export interface ProviderProposalSource {
  decisionKind?: DecisionKind;
  itemId?: string; // must match the request ID to be valid
  proposal?: GovernanceDecision; // must be an allowed outcome for the item
  rationale?: string; // provenance/audit text only; never trusted input
}

// Governor output: one decision record per eligible active item, items left
// unresolved (explicitly surfaced, never silently skipped), and the resulting
// budget state after provisional reservations.
export interface GovernanceResult {
  decisions: readonly GovernanceDecisionRecord[];
  unresolvedItemIds: readonly string[];
  budget: BudgetState;
}

// One final governance decision for one item, with an explicit reason code
// and any validated provider proposal recorded as advisory provenance.
export interface GovernanceDecisionRecord {
  itemId: string;
  action: GovernanceDecision;
  reasonCode: string; // explicit reason for audit/evaluation (e.g. "RULE_TTL_EXPIRED")
  score: number; // the heuristic score consulted, finite and in [0, 1]
  providerProposal?: GovernanceDecision; // advisory only; Governor retains authority
}

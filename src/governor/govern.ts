// ECC Curator — deterministic Governor decision pipeline (Sprint 4).
// Source of truth: docs/GOVERNOR_ALGORITHM.md ("Responsibilities",
// "Evaluation order", "Budget-pressure behavior", "Provisional thresholds",
// reference pseudocode) plus the frozen contracts in ../types/governance.ts,
// ../types/context.ts and ../types/inventory.ts (imported, never rewritten).
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums;
// relative imports carry explicit .ts extensions; interface/type imports use
// `import type`, runtime values (typed error classes) are plain imports.
//
// MVP decision (recorded in IMPLEMENTATION_PLAN.md / PROGRESS.md): the
// Governor emits KEEP/DROP only; COMPRESS/TRANSFORM are contract values that
// stay out of the MVP execution path (middle threshold band -> KEEP), and
// provider escalation is disabled-by-default advisory recording only — no
// provider vocabulary is invoked at runtime.
//
// Budget-pressure accounting (docs/GOVERNOR_ALGORITHM.md, "Budget-pressure
// behavior" step 1): fixed prompt content (committedTokens), model output
// reserve (outputReserveTokens) and the conservative safety margin
// (safetyMarginTokens) are reserved from availableInputTokens BEFORE any
// context item is allocated. The remainder is the working budget; every
// later budget decision — band classification, per-type caps, fitting — is
// computed against it.

import type {
  BudgetState,
  GovernanceDecisionRecord,
  GovernorInput,
  GovernancePolicySet,
  GovernanceRule,
  ProviderProposalSource,
} from "../types/governance.ts";
import type { ContextItem, ContextMetadata, GovernanceDecision } from "../types/context.ts";
import { InvalidContextItemError } from "../types/inventory.ts";
import { resolve } from "../rules/rule-engine.ts";
import type { RuleDiagnostic, RuleDiagnosticCode, RuleReasonCode } from "../rules/rule-engine.ts";

// ---------------------------------------------------------------------------
// Budget band vocabulary (MVP-local).
// docs/GOVERNOR_ALGORITHM.md describes budget pressure behavior but never
// names bands; the band names/edges below are the documented MVP decision
// (PROGRESS.md micro-task 1): ratio is the fraction of the working budget
// already under pressure (reserved or provisionally allocated tokens
// divided by workingBudget), classified as:
//   GREEN   ratio < 0.6
//   YELLOW  0.6 <= ratio < 0.8
//   ORANGE  0.8 <= ratio <= 0.9   (exactly 0.9 is still ORANGE)
//   RED     ratio > 0.9
// Ratios above 1 are legitimate ("over budget") and classify as RED.
// ---------------------------------------------------------------------------

export type BudgetBand = "GREEN" | "YELLOW" | "ORANGE" | "RED";

// Inclusive lower edge where budget pressure leaves the comfortable band.
const BAND_GREEN_UPPER_EXCLUSIVE = 0.6;
// Inclusive lower edge of the "tight" band.
const BAND_YELLOW_UPPER_EXCLUSIVE = 0.8;
// Inclusive upper edge of the "tight-or-critical" band; beyond it is RED.
const BAND_ORANGE_UPPER_INCLUSIVE = 0.9;

export function classifyBudgetBand(ratio: number): BudgetBand {
  if (!(ratio >= 0)) {
    // NaN and negatives are input errors, never silently clamped into GREEN.
    throw new InvalidContextItemError(
      "",
      "invalid_budget_ratio: budget pressure ratio must be a finite number >= 0",
    );
  }
  if (ratio < BAND_GREEN_UPPER_EXCLUSIVE) {
    return "GREEN";
  }
  if (ratio < BAND_YELLOW_UPPER_EXCLUSIVE) {
    return "YELLOW";
  }
  if (ratio <= BAND_ORANGE_UPPER_INCLUSIVE) {
    return "ORANGE";
  }
  return "RED";
}

// ---------------------------------------------------------------------------
// Working-budget derivation and BudgetState validation.
// All four BudgetState fields must be finite integers >= 0 (the contract
// comment pins the range); violations throw InvalidContextItemError with an
// explicit reason, matching the scoring engine's governor-adjacent precedent
// (src/scoring/score.ts throws itemId "" for batch-level budget problems).
// ---------------------------------------------------------------------------

const isFiniteInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);

export function validateBudgetState(budget: BudgetState): void {
  // Explicit field checks — BudgetState has no index signature, so the field
  // names are written out rather than looped over (keeps the strict contract
  // honest: a renamed field is a compile error, never a silent skip).
  const fields: readonly (readonly [string, number])[] = [
    ["availableInputTokens", budget.availableInputTokens],
    ["committedTokens", budget.committedTokens],
    ["outputReserveTokens", budget.outputReserveTokens],
    ["safetyMarginTokens", budget.safetyMarginTokens],
  ];
  for (const [name, value] of fields) {
    if (!isFiniteInteger(value) || value < 0) {
      throw new InvalidContextItemError(
        "",
        `invalid_budget_state: ${name} must be a finite integer >= 0 (got ${value})`,
      );
    }
  }
}

// workingBudget = availableInputTokens - committedTokens - outputReserveTokens
//                 - safetyMarginTokens
// Must end strictly positive: a zero/negative remainder means the fixed
// reservations consume (or exceed) the whole window, and cost is never
// treated as free (mirrors score.ts "invalid_working_budget"). The caller
// distinguishes "fixed reservations alone exceed the window" (a
// BudgetConflict-level condition, checked later against pinned items first
// per docs step 2) from "no room for context" — both surface explicitly,
// never as an empty-but-successful plan.
export function deriveWorkingBudget(budget: BudgetState): number {
  validateBudgetState(budget);
  const workingBudget =
    budget.availableInputTokens -
    budget.committedTokens -
    budget.outputReserveTokens -
    budget.safetyMarginTokens;
  if (workingBudget <= 0) {
    throw new InvalidContextItemError(
      "",
      "invalid_working_budget: fixed reservations leave no working budget for context items",
    );
  }
  return workingBudget;
}

// ---------------------------------------------------------------------------
// Micro-task 2 — per-item KEEP/DROP decision (docs/GOVERNOR_ALGORITHM.md
// "Evaluation order": hard constraints → rules → heuristic thresholds).
// Documented deviation from the pseudocode: the score is validated for EVERY
// item, not only inside the threshold branch — GovernanceDecisionRecord.score
// is a REQUIRED finite [0,1] number on every record, so an item that reaches
// a rule decision with a missing/invalid score would produce an invalid
// record rather than skip validation. Validation-first is the strict superset.
//
// Pinned first (Hard constraints before rule/threshold evaluation):
// metadata.pinned === true forces KEEP with HARD_CONSTRAINT_PINNED and
// short-circuits rules and thresholds alike.
//
// Rule step: delegate entirely to the Sprint 3b engine's resolve(). A
// "decided" resolution acts only when its action is MVP-executable
// (KEEP/DROP) AND enabled in GovernorInput.enabledDecisionKinds; a
// COMPRESS/TRANSFORM action or a disabled kind yields an explicit
// Governor-local diagnostic and falls through to thresholds ("the Governor
// keeps final decision authority"). "blocked" resolutions carry the rule
// engine's diagnostics forward and likewise fall through — rules are never
// re-consulted after a blocked resolution.
// ---------------------------------------------------------------------------

// Governor-local diagnostic codes — deliberately NOT added to the rule
// engine's frozen RuleDiagnosticCode union (that contract is compiled and
// unchanged); these describe Governor gating decisions about a resolution.
export type GovernorDiagnosticCode =
  | "RULE_ACTION_DISABLED" // decided action not in enabledDecisionKinds
  | "RULE_ACTION_UNSUPPORTED_IN_MVP"; // COMPRESS/TRANSFORM: contract value only

const governorDiagnostic = (
  code: GovernorDiagnosticCode,
  itemId: string,
  ruleId: string,
  detail?: string,
): { code: GovernorDiagnosticCode; itemId: string; ruleId: string; detail?: string } => ({
  code,
  itemId,
  ruleId,
  detail,
});

// Diagnostic carrier for one item's decision audit trail: structurally
// compatible with the rule engine's RuleDiagnostic (forwarded verbatim) and
// with Governor-local diagnostics; the union code type keeps both honest.
export interface DecisionDiagnostic {
  code: RuleDiagnosticCode | GovernorDiagnosticCode;
  itemId: string;
  ruleId: string; // "" when no rule is implicated
  detail?: string;
}

// Per-item KEEP/DROP outcome before decision-record shaping (micro-task 3
// turns this into GovernanceDecisionRecord and embeds winningRuleId in the
// reasonCode string, since the frozen record contract has no ruleId field).
export interface GovernorItemDecision {
  itemId: string;
  action: GovernanceDecision; // MVP path: KEEP or DROP only
  reasonCode: RuleReasonCode | "HARD_CONSTRAINT_PINNED" | "THRESHOLD_KEEP" | "MIDDLE_BAND_KEEP" | "THRESHOLD_DROP";
  winningRuleId?: string; // present exactly when the rule step acted
  score: number; // validated finite [0,1] score consulted
  diagnostics: readonly DecisionDiagnostic[]; // rule + governor diagnostics
}

export interface BudgetConflict {
  code: "FIXED_RESERVATIONS_EXCEED_BUDGET" | "PINNED_ITEMS_EXCEED_WORKING_BUDGET";
  availableInputTokens: number;
  fixedReservationTokens: number;
  pinnedTokens: number;
  excessTokens: number;
}

export interface GovernorBudgetResult {
  decisions: readonly GovernanceDecisionRecord[];
  unresolvedItemIds: readonly string[];
  overflowItemIds: readonly string[];
  budget: BudgetState;
  workingBudget: number;
  budgetConflicts: readonly BudgetConflict[];
}

export interface GovernorBudgetInputItem {
  item: ContextItem;
  decision: GovernanceDecisionRecord;
}

// Normalized score lookup: required, finite, in [0,1]; every violation is an
// item-level InvalidContextItemError with an explicit reason code (missing
// scores are never treated as 0 — "cost is never free" spirit).
export function requireFiniteScore(
  itemId: string,
  scores: ReadonlyMap<string, number>,
): number {
  if (!scores.has(itemId)) {
    throw new InvalidContextItemError(
      itemId,
      "missing_score: every governed item needs a heuristic score before governing",
    );
  }
  const score = scores.get(itemId);
  if (
    typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1
  ) {
    throw new InvalidContextItemError(
      itemId,
      `invalid_score_range: score must be a finite number in [0,1] (got ${score})`,
    );
  }
  return score;
}

// Policy thresholds validated once before any decision is taken
// (GovernancePolicySet.thresholds is required by the frozen contract; the
// documented reproducibility defaults 0.65 / 0.35 stand in ONLY for a
// missing runtime field, never for an invalid present one).
const DEFAULT_KEEP_AT_OR_ABOVE = 0.65;
const DEFAULT_RETAIN_AT_OR_ABOVE = 0.35;

export interface PolicyThresholds {
  keepAtOrAbove: number;
  retainAtOrAbove: number;
}

export function resolvePolicyThresholds(policies: GovernancePolicySet): PolicyThresholds {
  const declared = policies.thresholds;
  const keepAtOrAbove =
    declared.keepAtOrAbove === undefined ? DEFAULT_KEEP_AT_OR_ABOVE : declared.keepAtOrAbove;
  const retainAtOrAbove =
    declared.retainAtOrAbove === undefined
      ? DEFAULT_RETAIN_AT_OR_ABOVE
      : declared.retainAtOrAbove;
  if (
    typeof keepAtOrAbove !== "number" || !Number.isFinite(keepAtOrAbove) ||
    keepAtOrAbove < 0 || keepAtOrAbove > 1
  ) {
    throw new InvalidContextItemError(
      "",
      `invalid_policy_threshold: keepAtOrAbove must be a finite number in [0,1] (got ${keepAtOrAbove})`,
    );
  }
  if (
    typeof retainAtOrAbove !== "number" || !Number.isFinite(retainAtOrAbove) ||
    retainAtOrAbove < 0 || retainAtOrAbove > 1 || retainAtOrAbove > keepAtOrAbove
  ) {
    throw new InvalidContextItemError(
      "",
      `invalid_policy_threshold: retainAtOrAbove must be a finite number in [0, keepAtOrAbove] (got ${retainAtOrAbove})`,
    );
  }
  return { keepAtOrAbove, retainAtOrAbove };
}

const isMvpExecutableAction = (action: GovernanceDecision): boolean =>
  action === "KEEP" || action === "DROP";

// decide(itemId, item, rules, policies, scores, enabledDecisionKinds,
// thresholds) — total, pure, deterministic; throws only score-validation
// errors (rule/policy problems are diagnostics, not throws).
export function decideItem(
  item: ContextItem,
  rules: readonly GovernanceRule[],
  policies: GovernancePolicySet,
  scores: ReadonlyMap<string, number>,
  enabledDecisionKinds: ReadonlySet<GovernanceDecision>, // == ReadonlySet<DecisionKind> (contract alias)
  thresholds: PolicyThresholds,
): GovernorItemDecision {
  const itemId = item.id;
  const score = requireFiniteScore(itemId, scores);
  const diagnostics: DecisionDiagnostic[] = [];

  // Hard constraint: pinned items are kept before rules/thresholds consider
  // anything else (docs "Evaluation order", step 1).
  const metadata: ContextMetadata = item.metadata;
  if (metadata.pinned === true) {
    return {
      itemId,
      action: "KEEP",
      reasonCode: "HARD_CONSTRAINT_PINNED",
      score,
      diagnostics,
    };
  }

  const resolution = resolve(itemId, rules, policies, item.type);
  for (const diagnostic of resolution.diagnostics) {
    diagnostics.push(diagnostic); // rule-engine diagnostics forwarded verbatim
  }

  if (resolution.status === "decided" && resolution.winningRule !== undefined) {
    const action = resolution.winningRule.action;
    if (isMvpExecutableAction(action)) {
      if (enabledDecisionKinds.has(action)) {
        return {
          itemId,
          action,
          reasonCode: resolution.reasonCode, // scope-match code; micro-task 3 embeds ruleId
          winningRuleId: resolution.winningRule.ruleId,
          score,
          diagnostics,
        };
      }
      diagnostics.push(
        governorDiagnostic(
          "RULE_ACTION_DISABLED",
          itemId,
          resolution.winningRule.ruleId,
          `decision kind ${action} not enabled`,
        ),
      );
      // fall through to thresholds — disabled kinds never act
    } else {
      diagnostics.push(
        governorDiagnostic(
          "RULE_ACTION_UNSUPPORTED_IN_MVP",
          itemId,
          resolution.winningRule.ruleId,
          `action ${action} is a contract value, not executed in MVP`,
        ),
      );
      // fall through to thresholds
    }
  }
  // "blocked" and "no_match" resolutions never act; blocked diagnostics are
  // already forwarded above ("Governor does not re-consult rules").

  // Heuristic thresholds: at-or-above keep band, middle band -> KEEP (MVP
  // substitute for COMPRESS), below retain band -> DROP. Boundary semantics
  // are inclusive at both cut points ("at or above").
  if (score >= thresholds.keepAtOrAbove) {
    return {
      itemId,
      action: "KEEP",
      reasonCode: "THRESHOLD_KEEP",
      score,
      diagnostics,
    };
  }
  if (score >= thresholds.retainAtOrAbove) {
    return {
      itemId,
      action: "KEEP",
      reasonCode: "MIDDLE_BAND_KEEP",
      score,
      diagnostics,
    };
  }
  return {
    itemId,
    action: "DROP",
    reasonCode: "THRESHOLD_DROP",
    score,
    diagnostics,
  };
}

// Shape one deterministic item outcome into the frozen output contract.
// Provider output is recorded only as policy-approved advisory provenance.
export function createDecisionRecord(
  item: ContextItem,
  decision: GovernorItemDecision,
  policies: GovernancePolicySet,
  providerProposal?: ProviderProposalSource,
): GovernanceDecisionRecord {
  if (decision.itemId !== item.id) {
    throw new InvalidContextItemError(
      item.id,
      `decision_item_mismatch: expected ${item.id} but got ${decision.itemId}`,
    );
  }

  const proposal = providerProposal?.proposal;
  const allowedActions = policies.allowedActionsByType.get(item.type);
  const recordProposal =
    policies.providerEscalationEnabled &&
    providerProposal?.itemId === item.id &&
    providerProposal.decisionKind === decision.action &&
    proposal !== undefined &&
    allowedActions?.has(proposal) === true
      ? proposal
      : undefined;

  const reasonCode = decision.winningRuleId === undefined
    ? decision.reasonCode
    : `${decision.reasonCode}:ruleId=${decision.winningRuleId}`;

  return Object.freeze({
    itemId: item.id,
    action: decision.action,
    reasonCode,
    score: decision.score,
    ...(recordProposal === undefined ? {} : { providerProposal: recordProposal }),
  });
}

const compareAllocationPriority = (
  left: GovernorBudgetInputItem,
  right: GovernorBudgetInputItem,
): number =>
  right.decision.score - left.decision.score ||
  right.item.metadata.priority - left.item.metadata.priority ||
  left.item.metadata.ageTurns - right.item.metadata.ageTurns ||
  right.item.metadata.references - left.item.metadata.references ||
  (left.item.id < right.item.id ? -1 : left.item.id > right.item.id ? 1 : 0);

function validateBudgetItems(items: readonly GovernorBudgetInputItem[]): void {
  const seenIds = new Set<string>();
  for (const { item, decision } of items) {
    if (item.id !== decision.itemId) {
      throw new InvalidContextItemError(
        item.id,
        `decision_item_mismatch: expected ${item.id} but got ${decision.itemId}`,
      );
    }
    if (seenIds.has(item.id)) {
      throw new InvalidContextItemError(item.id, "duplicate_item_id: budget items must be unique");
    }
    seenIds.add(item.id);
    if (!Number.isSafeInteger(item.tokenCount) || item.tokenCount < 0) {
      throw new InvalidContextItemError(
        item.id,
        `invalid_token_count: expected a non-negative safe integer (got ${item.tokenCount})`,
      );
    }
  }
}

// Allocate already-decided items against the working budget. Pins are never
// dropped; overflow is explicit and deterministic, and cannot alter ranking
// inputs or the frozen GovernanceResult contract.
export function fitWorkingSet(
  items: readonly GovernorBudgetInputItem[],
  budget: BudgetState,
): GovernorBudgetResult {
  validateBudgetState(budget);
  validateBudgetItems(items);

  const fixedReservationTokens =
    budget.committedTokens + budget.outputReserveTokens + budget.safetyMarginTokens;
  const rawWorkingBudget = budget.availableInputTokens - fixedReservationTokens;
  const workingBudget = Math.max(0, rawWorkingBudget);

  const pinnedItems = items.filter(({ item }) => item.metadata.pinned);
  const pinnedTokens = pinnedItems.reduce((sum, { item }) => sum + item.tokenCount, 0);
  const budgetConflicts: BudgetConflict[] = [];

  if (rawWorkingBudget < 0) {
    budgetConflicts.push({
      code: "FIXED_RESERVATIONS_EXCEED_BUDGET",
      availableInputTokens: budget.availableInputTokens,
      fixedReservationTokens,
      pinnedTokens,
      excessTokens: -rawWorkingBudget,
    });
  }
  if (pinnedTokens > workingBudget) {
    budgetConflicts.push({
      code: "PINNED_ITEMS_EXCEED_WORKING_BUDGET",
      availableInputTokens: budget.availableInputTokens,
      fixedReservationTokens,
      pinnedTokens,
      excessTokens: pinnedTokens - workingBudget,
    });
  }

  const pinnedIds = new Set(pinnedItems.map(({ item }) => item.id));
  const keptItems = items.filter(({ decision }) => decision.action === "KEEP");
  let allocatedTokens = pinnedTokens;
  const overflowItemIds: string[] = [];
  for (const { item } of keptItems.filter(({ item }) => !pinnedIds.has(item.id)).sort(compareAllocationPriority)) {
    if (allocatedTokens + item.tokenCount <= workingBudget) {
      allocatedTokens += item.tokenCount;
      continue;
    }
    overflowItemIds.push(item.id);
  }
  const overflowIds = new Set(overflowItemIds);
  const decisions = items.map(({ item, decision }) => {
    if (overflowIds.has(item.id)) {
      return Object.freeze({
        ...decision,
        action: "DROP" as const,
        reasonCode: `BUDGET_OVERFLOW:${decision.reasonCode}`,
      });
    }

    if (pinnedIds.has(item.id) && decision.action !== "KEEP") {
      return Object.freeze({
        ...decision,
        action: "KEEP" as const,
        reasonCode: "HARD_CONSTRAINT_PINNED",
      });
    }
    return Object.freeze({ ...decision });
  });

  return Object.freeze({
    decisions: Object.freeze(decisions),
    unresolvedItemIds: Object.freeze([]),
    overflowItemIds: Object.freeze(overflowItemIds),
    budget: Object.freeze({ ...budget }),
    workingBudget,
    budgetConflicts: Object.freeze(budgetConflicts.map((conflict) => Object.freeze(conflict))),
  });
}

function validateInventorySnapshot(
  inventory: GovernorInput["inventory"],
): void {
  if (!Number.isSafeInteger(inventory.version) || inventory.version < 0) {
    throw new InvalidContextItemError(
      "",
      `invalid_inventory_version: expected a non-negative safe integer (got ${inventory.version})`,
    );
  }
  if (!Number.isSafeInteger(inventory.tokenCount) || inventory.tokenCount < 0) {
    throw new InvalidContextItemError(
      "",
      `invalid_inventory_token_count: expected a non-negative safe integer (got ${inventory.tokenCount})`,
    );
  }

  const seenIds = new Set<string>();
  let tokenCount = 0;
  for (const item of inventory.items) {
    if (seenIds.has(item.id)) {
      throw new InvalidContextItemError(item.id, "duplicate_item_id: inventory IDs must be unique");
    }
    seenIds.add(item.id);
    if (!Number.isSafeInteger(item.tokenCount) || item.tokenCount < 0) {
      throw new InvalidContextItemError(
        item.id,
        `invalid_token_count: expected a non-negative safe integer (got ${item.tokenCount})`,
      );
    }
    tokenCount += item.tokenCount;
    if (!Number.isSafeInteger(tokenCount)) {
      throw new InvalidContextItemError("", "invalid_inventory_token_count: item total exceeds safe integer range");
    }
  }
  if (tokenCount !== inventory.tokenCount) {
    throw new InvalidContextItemError(
      "",
      `inventory_token_count_mismatch: snapshot reports ${inventory.tokenCount}, items total ${tokenCount}`,
    );
  }
}

// Compose deterministic per-item evaluation with record shaping and the
// budget allocator. Providers are never called; a supplied proposal can only
// be copied into a matching record as advisory provenance.
export function govern(input: GovernorInput): GovernorBudgetResult {
  validateInventorySnapshot(input.inventory);
  validateBudgetState(input.budget);
  const thresholds = resolvePolicyThresholds(input.policies);
  const activeItems = input.inventory.items.filter((item) => item.state === "ACTIVE");
  const budgetItems = activeItems.map((item) => {
    const itemDecision = decideItem(
      item,
      input.rules,
      input.policies,
      input.scores,
      input.enabledDecisionKinds,
      thresholds,
    );
    return {
      item,
      decision: createDecisionRecord(
        item,
        itemDecision,
        input.policies,
        input.decisionProvider,
      ),
    };
  });
  return fitWorkingSet(budgetItems, input.budget);
}

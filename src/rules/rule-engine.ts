// ECC Curator — deterministic governance-rule evaluator (Sprint 3b).
// Source of truth: docs/GOVERNOR_ALGORITHM.md ("Resolve matching explicit rules"
// and the pseudocode step "rule = resolveRule(item, rules, policy)") together
// with the GovernanceRule / GovernancePolicySet contracts in
// ../types/governance.ts and the ContextType / GovernanceDecision contracts in
// ../types/context.ts. This module implements ONLY the rule-resolution step:
// the Governor retains final decision authority (budget fitting, scoring
// baselines, provider escalation all stay upstream).
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums.
// Pure and deterministic: no Math.random, no Date.now(), no clock — TTL-style
// rules are expected to be pre-filtered by callers that hold an injected
// ISO-8601 timestamp; this evaluator never inspects wall-clock state.

import type { ContextType, GovernanceDecision } from "../types/context.ts";
import type { GovernanceRule, GovernancePolicySet } from "../types/governance.ts";

// ---------------------------------------------------------------------------
// Explicit, auditable codes. Reason codes are suitable for use as
// GovernanceDecisionRecord.reasonCode; diagnostic codes mark policy and
// input-shape problems instead of silently overriding anything.
// ---------------------------------------------------------------------------

export type RuleReasonCode =
  | "RULE_NO_MATCH"
  | "RULE_ITEM_SCOPE_MATCH"
  | "RULE_CONTEXT_TYPE_SCOPE_MATCH"
  | "RULE_GLOBAL_SCOPE_MATCH"
  | "RULE_ACTION_DISALLOWED_BY_POLICY"
  | "RULE_ACTION_POLICY_UNKNOWN";

export type RuleDiagnosticCode =
  | "RULE_PRIORITY_INVALID" // priority missing, non-finite or not an integer
  | "RULE_SCOPE_INVALID" // scope not one of "item" | "context_type" | "global"
  | "RULE_ITEM_ID_MISSING" // scope "item" without a non-empty itemId
  | "RULE_CONTEXT_TYPE_MISSING" // scope "context_type" without a contextType
  | "RULE_ACTION_INVALID" // action not a GovernanceDecision contract value
  | "RULE_DUPLICATE_ID" // same ruleId used by more than one input rule
  | "RULE_ACTION_DISALLOWED_BY_POLICY" // winning rule's action rejected by policy
  | "RULE_ACTION_POLICY_UNKNOWN" // context type not registered in policy; action
    // cannot be validated (explicit gap surfaced, never assumed allowed)
  | "RULE_CONTEXT_TYPE_UNKNOWN"; // no contextType supplied, so context_type-scope
  // rules could not match and policy actions could not be validated

// Deterministic scope precedence (docs/GOVERNOR_ALGORITHM.md, step 3):
// item-scope rules beat context_type-scope rules beat global-scope rules.
const RULE_SCOPE_RANK: Readonly<Record<string, number>> = {
  item: 0,
  context_type: 1,
  global: 2,
};

const VALID_SCOPES: readonly string[] = ["item", "context_type", "global"];
const VALID_ACTIONS: readonly GovernanceDecision[] = ["KEEP", "DROP", "COMPRESS", "TRANSFORM"];

// ---------------------------------------------------------------------------
// Local contracts (the frozen ../types/*.ts files must not be edited, so the
// resolution-shaped types live here next to the evaluator).
// ---------------------------------------------------------------------------

export interface RuleResolutionItem {
  itemId: string;
  contextType?: ContextType; // required in practice for context_type-scope
  // matching and for policy action validation; when omitted both are surfaced
  // as explicit diagnostics (RULE_CONTEXT_TYPE_UNKNOWN) rather than guessed.
}

export interface RuleDiagnostic {
  code: RuleDiagnosticCode;
  itemId: string; // "" when the diagnostic is about a rule definition, not an item
  ruleId: string; // "" when no specific rule is implicated
  detail?: string; // short audit note; never trusted input
}

// One item's rule-resolution outcome. Exactly one of three shapes:
//  - "decided":   winningRule present, policy-approved; reasonCode names the
//                 scope level that won.
//  - "blocked":   winningRule present but its action is disallowed (or
//                 unverifiable) under policy; a typed diagnostic is attached
//                 and the Governor must surface it, not act on the rule.
//  - "no_match":  no eligible rule decided the item; heuristics/thresholds
//                 (elsewhere in the Governor) apply.
export interface RuleResolution {
  itemId: string;
  status: "decided" | "blocked" | "no_match";
  reasonCode: RuleReasonCode;
  winningRule?: GovernanceRule; // present for "decided" and "blocked"
  matchedRuleIds: readonly string[]; // ALL matching rule ids, precedence order
  diagnostics: readonly RuleDiagnostic[];
}

// Internal sort key: lower tuple-compare wins. Total order:
// scope rank ascending, then numeric priority ascending, then ruleId ascending
// (default UTF-16 code-unit string comparison — deterministic), then original
// input index (stable guard for fully tied ruleIds).
interface ResolutionScore {
  scopeRank: number;
  priority: number;
  ruleId: string;
  inputIndex: number;
}

function isBetterScore(candidate: ResolutionScore, incumbent: ResolutionScore): boolean {
  if (candidate.scopeRank !== incumbent.scopeRank) {
    return candidate.scopeRank < incumbent.scopeRank;
  }
  if (candidate.priority !== incumbent.priority) {
    return candidate.priority < incumbent.priority;
  }
  if (candidate.ruleId !== incumbent.ruleId) {
    return candidate.ruleId < incumbent.ruleId;
  }
  return candidate.inputIndex < incumbent.inputIndex;
}

// Stable ascending itemId comparator for batch ordering (matches the
// "stableSort(..., by = itemIdAscending)" convention in the algorithm doc).
function compareItems(a: RuleResolutionItem, b: RuleResolutionItem): number {
  if (a.itemId !== b.itemId) {
    return a.itemId < b.itemId ? -1 : 1;
  }
  return 0;
}

// True only when the context type is explicitly registered in
// GovernancePolicySet.allowedActionsByType (missing keys never imply "all
// actions allowed").
function policyAllowsAction(
  policies: GovernancePolicySet,
  contextType: ContextType,
  action: GovernanceDecision,
): boolean {
  const allowed = policies.allowedActionsByType.get(contextType);
  return allowed !== undefined && allowed.has(action);
}

function ruleDiagnostic(
  code: RuleDiagnosticCode,
  itemId: string,
  ruleId: string,
  detail?: string,
): RuleDiagnostic {
  return { code, itemId, ruleId, detail };
}

// Validates one rule definition; returns a diagnostic when the rule is
// malformed (malformed rules are excluded from matching and reported, never
// silently ignored).
function validateRule(rule: GovernanceRule): RuleDiagnostic | undefined {
  if (!VALID_SCOPES.includes(rule.scope)) {
    return ruleDiagnostic("RULE_SCOPE_INVALID", "", rule.ruleId, `scope=${rule.scope}`);
  }
  if (!Number.isFinite(rule.priority) || !Number.isInteger(rule.priority)) {
    return ruleDiagnostic("RULE_PRIORITY_INVALID", "", rule.ruleId, `priority=${rule.priority}`);
  }
  if (rule.scope === "item" && !rule.itemId) {
    return ruleDiagnostic("RULE_ITEM_ID_MISSING", "", rule.ruleId);
  }
  if (rule.scope === "context_type" && !rule.contextType) {
    return ruleDiagnostic("RULE_CONTEXT_TYPE_MISSING", "", rule.ruleId);
  }
  if (!VALID_ACTIONS.includes(rule.action)) {
    return ruleDiagnostic("RULE_ACTION_INVALID", "", rule.ruleId, `action=${rule.action}`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Core single-item resolution: find the highest-precedence matching rule,
// then policy-validate its action. Precedence: item-scope > context_type >
// global; within one level lower numeric priority wins, then ruleId ascending,
// then stable input order for complete ties.
// ---------------------------------------------------------------------------

function findBestMatch(
  itemId: string,
  contextType: ContextType | undefined,
  rules: readonly GovernanceRule[],
  diagnostics: RuleDiagnostic[],
): { rule: GovernanceRule; score: ResolutionScore } | undefined {
  let best: { rule: GovernanceRule; score: ResolutionScore } | undefined;
  const seenRuleIds = new Set<string>();

  for (let inputIndex = 0; inputIndex < rules.length; inputIndex = inputIndex + 1) {
    const rule = rules[inputIndex];

    if (seenRuleIds.has(rule.ruleId)) {
      diagnostics.push(ruleDiagnostic("RULE_DUPLICATE_ID", itemId, rule.ruleId));
    } else {
      seenRuleIds.add(rule.ruleId);
    }

    const invalid = validateRule(rule);
    if (invalid) {
      diagnostics.push(invalid);
      continue; // malformed rules never match; the diagnostic is explicit
    }

    let matches: boolean;
    if (rule.scope === "item") {
      matches = rule.itemId === itemId;
    } else if (rule.scope === "context_type") {
      matches = contextType !== undefined && rule.contextType === contextType;
    } else {
      matches = true; // global scope always applies
    }
    if (!matches) {
      continue;
    }

    const score: ResolutionScore = {
      scopeRank: RULE_SCOPE_RANK[rule.scope],
      priority: rule.priority,
      ruleId: rule.ruleId,
      inputIndex,
    };
    if (best === undefined || isBetterScore(score, best.score)) {
      best = { rule, score };
    }
  }

  return best;
}

function matchReasonForScope(scope: string): RuleReasonCode {
  if (scope === "item") {
    return "RULE_ITEM_SCOPE_MATCH";
  }
  if (scope === "context_type") {
    return "RULE_CONTEXT_TYPE_SCOPE_MATCH";
  }
  return "RULE_GLOBAL_SCOPE_MATCH";
}

// ---------------------------------------------------------------------------
// Public API — pure, total functions.
// ---------------------------------------------------------------------------

// resolve(itemId, rules, policies[, contextType]) — the Governor's step-3
// shape. contextType is needed to evaluate context_type-scope matches and to
// look the winning action up in policies.allowedActionsByType; when omitted,
// context_type rules cannot match and the action policy check reports the
// unknown-type gap instead of assuming it is allowed.
export function resolve(
  itemId: string,
  rules: readonly GovernanceRule[],
  policies: GovernancePolicySet,
  contextType?: ContextType,
): RuleResolution {
  const diagnostics: RuleDiagnostic[] = [];
  const best = findBestMatch(itemId, contextType, rules, diagnostics);

  if (best === undefined) {
    return {
      itemId,
      status: "no_match",
      reasonCode: "RULE_NO_MATCH",
      matchedRuleIds: [],
      diagnostics,
    };
  }

  // Collect every matching rule id in precedence order for audit records
  // (governance diagnostics reference rules by id; a duplicate id appears
  // once per matching rule).
  const matched: ResolutionScore[] = [];
  for (let inputIndex = 0; inputIndex < rules.length; inputIndex = inputIndex + 1) {
    const rule = rules[inputIndex];
    if (validateRule(rule)) {
      continue;
    }
    let matches: boolean;
    if (rule.scope === "item") {
      matches = rule.itemId === itemId;
    } else if (rule.scope === "context_type") {
      matches = contextType !== undefined && rule.contextType === contextType;
    } else {
      matches = true;
    }
    if (matches) {
      matched.push({
        scopeRank: RULE_SCOPE_RANK[rule.scope],
        priority: rule.priority,
        ruleId: rule.ruleId,
        inputIndex,
      });
    }
  }
  matched.sort((a, b) => {
    if (a.scopeRank !== b.scopeRank) {
      return a.scopeRank - b.scopeRank;
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    if (a.ruleId !== b.ruleId) {
      return a.ruleId < b.ruleId ? -1 : 1;
    }
    return a.inputIndex - b.inputIndex;
  });
  const matchedRuleIds: string[] = matched.map((entry) => entry.ruleId);

  const winningRule = best.rule;

  // Policy validation of the winning action. A disallowed action is a typed
  // diagnostic (status "blocked"), NOT a silent fallback to the next rule and
  // not an implicit action override.
  if (contextType === undefined) {
    diagnostics.push(ruleDiagnostic("RULE_CONTEXT_TYPE_UNKNOWN", itemId, winningRule.ruleId));
    return {
      itemId,
      status: "blocked",
      reasonCode: "RULE_ACTION_POLICY_UNKNOWN",
      winningRule,
      matchedRuleIds,
      diagnostics,
    };
  }

  if (!policyAllowsAction(policies, contextType, winningRule.action)) {
    diagnostics.push(
      ruleDiagnostic("RULE_ACTION_DISALLOWED_BY_POLICY", itemId, winningRule.ruleId, `${contextType} does not allow ${winningRule.action}`),
    );
    return {
      itemId,
      status: "blocked",
      reasonCode: "RULE_ACTION_DISALLOWED_BY_POLICY",
      winningRule,
      matchedRuleIds,
      diagnostics,
    };
  }

  return {
    itemId,
    status: "decided",
    reasonCode: matchReasonForScope(winningRule.scope),
    winningRule,
    matchedRuleIds,
    diagnostics,
  };
}

// Batch form: one resolution per item, output ordered by itemId ascending
// (stable on ties), each resolution identical to standalone resolve().
export function resolveAll(
  items: readonly RuleResolutionItem[],
  rules: readonly GovernanceRule[],
  policies: GovernancePolicySet,
): readonly RuleResolution[] {
  const ordered: RuleResolutionItem[] = items.slice();
  ordered.sort(compareItems);
  const results: RuleResolution[] = [];
  for (const item of ordered) {
    results.push(resolve(item.itemId, rules, policies, item.contextType));
  }
  return results;
}

// Standalone rule-set validation (input-shape diagnostics without resolving an
// item): duplicate ids and malformed definitions are surfaced explicitly.
export function collectRuleDiagnostics(
  rules: readonly GovernanceRule[],
): readonly RuleDiagnostic[] {
  const diagnostics: RuleDiagnostic[] = [];
  const seenRuleIds = new Set<string>();
  for (const rule of rules) {
    if (seenRuleIds.has(rule.ruleId)) {
      diagnostics.push(ruleDiagnostic("RULE_DUPLICATE_ID", "", rule.ruleId));
    } else {
      seenRuleIds.add(rule.ruleId);
    }
    const invalid = validateRule(rule);
    if (invalid) {
      diagnostics.push(invalid);
    }
  }
  return diagnostics;
}

// tests/rules.test.ts
// Runs via `node --test tests/` (Node 24 native TS type-stripping).
// Contracts under test (src/rules/rule-engine.ts + docs/GOVERNOR_ALGORITHM.md
// step 3 "Resolve matching explicit rules": "Resolve conflicts with the
// configured stable precedence: item-specific rule, context-type rule, global
// rule; within the same level, lower numeric priority wins, then stable
// ruleId ascending. A rule's action must be allowed by policy." + the
// GovernanceRule / GovernancePolicySet contracts in src/types/governance.ts):
//   - scope precedence wins over numeric priority: item-scope beats context_type
//     beats global even when the global rule has a numerically lower priority
//   - within one scope level, lower numeric priority wins
//   - equal priority at one level ties break by ruleId ascending, not input order
//   - a policy-disallowed winning action -> status "blocked" with a typed
//     RULE_ACTION_DISALLOWED_BY_POLICY diagnostic: no silent override, no
//     fallback to the next rule
//   - no applicable rule -> explicit status "no_match" / RULE_NO_MATCH (heuristics
//     live elsewhere in the Governor)
//   - empty rule set -> deterministic no_match, no diagnostics
//   - same inputs twice -> deep-equal outputs (resolve and resolveAll alike;
//     resolveAll orders by itemId ascending, stable on ties)
//
// Determinism: no clock anywhere in this evaluator; rules and policies are plain
// literals. No Math.random, no Date.now().

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolve, resolveAll } from "../src/rules/rule-engine.ts";

import type { ContextType, GovernanceDecision } from "../src/types/context.ts";
import type { GovernanceRule, GovernancePolicySet } from "../src/types/governance.ts";
import type { RuleResolution, RuleDiagnostic, RuleResolutionItem } from "../src/rules/rule-engine.ts";

const ALL_ACTIONS: readonly GovernanceDecision[] = ["KEEP", "DROP", "COMPRESS", "TRANSFORM"];

function makePolicies(allowed: Record<string, readonly GovernanceDecision[]>): GovernancePolicySet {
  const map = new Map<string, ReadonlySet<GovernanceDecision>>();
  for (const contextType in allowed) {
    map.set(contextType, new Set(allowed[contextType]));
  }
  return {
    allowedActionsByType: map,
    providerEscalationEnabled: false,
    fallbackByDecisionKind: new Map<string, GovernanceDecision>(),
    thresholds: { keepAtOrAbove: 0.65, retainAtOrAbove: 0.35 },
  };
}

function globalRule(ruleId: string, priority: number, action: GovernanceDecision): GovernanceRule {
  return { ruleId, priority, scope: "global", action };
}

function contextRule(ruleId: string, priority: number, contextType: ContextType, action: GovernanceDecision): GovernanceRule {
  return { ruleId, priority, scope: "context_type", contextType, action };
}

function itemRule(ruleId: string, priority: number, itemId: string, action: GovernanceDecision): GovernanceRule {
  return { ruleId, priority, scope: "item", itemId, action };
}

function idsOfResolutions(results: readonly RuleResolution[]): string[] {
  const collected: string[] = [];
  for (const resolution of results) {
    collected.push(resolution.itemId);
  }
  return collected;
}

test("resolve: item beats context_type beats global even with numerically lower global priority", () => {
  const rules: readonly GovernanceRule[] = [
    itemRule("r-item", 90, "ctx-login", "DROP"),      // worst priority in the set
    contextRule("r-ctx", 50, "file", "COMPRESS"),
    globalRule("r-global", 1, "KEEP"),                // best numeric priority
  ];
  const policies = makePolicies({ file: ALL_ACTIONS, memory: ALL_ACTIONS });

  // Scope precedence dominates: the item rule wins despite priority 90 vs 1.
  const byItem = resolve("ctx-login", rules, policies, "file");
  assert.equal(byItem.status, "decided");
  assert.equal(byItem.reasonCode, "RULE_ITEM_SCOPE_MATCH");
  const itemWinner = byItem.winningRule as GovernanceRule;
  assert.equal(itemWinner.ruleId, "r-item");
  assert.equal(itemWinner.priority, 90); // NOT the lowest-numbered rule
  assert.equal(itemWinner.action, "DROP");
  assert.deepEqual([...byItem.matchedRuleIds], ["r-item", "r-ctx", "r-global"]); // precedence order

  // Same rules, an item only covered by the context-type rule.
  const byType = resolve("ctx-other", rules, policies, "file");
  assert.equal(byType.status, "decided");
  assert.equal(byType.reasonCode, "RULE_CONTEXT_TYPE_SCOPE_MATCH");
  const typeWinner = byType.winningRule as GovernanceRule;
  assert.equal(typeWinner.ruleId, "r-ctx");
  assert.deepEqual([...byType.matchedRuleIds], ["r-ctx", "r-global"]);

  // An unregistered context type falls through to the global rule.
  const byGlobal = resolve("ctx-notes", rules, policies, "memory");
  assert.equal(byGlobal.status, "decided");
  assert.equal(byGlobal.reasonCode, "RULE_GLOBAL_SCOPE_MATCH");
  const globalWinner = byGlobal.winningRule as GovernanceRule;
  assert.equal(globalWinner.ruleId, "r-global");
  assert.deepEqual([...byGlobal.matchedRuleIds], ["r-global"]);
});

test("resolve: within one scope level, lower numeric priority wins regardless of input order", () => {
  const inputOrderA: readonly GovernanceRule[] = [
    globalRule("g-high", 10, "KEEP"),
    globalRule("g-low", 3, "DROP"),
  ];
  const inputOrderB: readonly GovernanceRule[] = [inputOrderA[1], inputOrderA[0]];
  const policies = makePolicies({ file: ALL_ACTIONS });

  for (const rules of [inputOrderA, inputOrderB]) {
    const result = resolve("ctx-any", rules, policies, "file");
    assert.equal(result.status, "decided");
    assert.equal(result.reasonCode, "RULE_GLOBAL_SCOPE_MATCH");
    const winner = result.winningRule as GovernanceRule;
    assert.equal(winner.ruleId, "g-low"); // priority 3 beats priority 10
    assert.equal(winner.priority, 3);
    assert.deepEqual([...result.matchedRuleIds], ["g-low", "g-high"]); // sorted by precedence, not input
  }
});

test("resolve: equal priority at one level ties break by ruleId ascending, not input order", () => {
  const rules: readonly GovernanceRule[] = [
    globalRule("z-rule", 5, "DROP"), // listed first, but loses the tie
    globalRule("a-rule", 5, "KEEP"),
  ];
  const policies = makePolicies({ file: ALL_ACTIONS });
  const result = resolve("ctx-tie", rules, policies, "file");
  assert.equal(result.status, "decided");
  assert.equal(result.reasonCode, "RULE_GLOBAL_SCOPE_MATCH");
  const winner = result.winningRule as GovernanceRule;
  assert.equal(winner.ruleId, "a-rule"); // "a-rule" < "z-rule" at equal priority
  assert.deepEqual([...result.matchedRuleIds], ["a-rule", "z-rule"]);
});

test("resolve: policy-disallowed winning action -> blocked diagnostic, no fallback override", () => {
  const rules: readonly GovernanceRule[] = [
    itemRule("r-item", 0, "ctx-priv", "DROP"), // wins precedence, but policy forbids DROP for file
    globalRule("r-global", 1, "KEEP"),         // would be allowed; must NOT be silently substituted
  ];
  const policies = makePolicies({ file: ["KEEP"] });

  const result = resolve("ctx-priv", rules, policies, "file");
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "RULE_ACTION_DISALLOWED_BY_POLICY");
  // The winning rule is still the precedence winner — no silent fallback to r-global.
  const winner = result.winningRule as GovernanceRule;
  assert.equal(winner.ruleId, "r-item");
  assert.equal(winner.action, "DROP");
  assert.deepEqual([...result.matchedRuleIds], ["r-item", "r-global"]);

  const diags: readonly RuleDiagnostic[] = result.diagnostics;
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, "RULE_ACTION_DISALLOWED_BY_POLICY");
  assert.equal(diags[0].itemId, "ctx-priv");
  assert.equal(diags[0].ruleId, "r-item");
  assert.equal(diags[0].detail, "file does not allow DROP");
});

test("resolve: no applicable rule -> explicit no_match / RULE_NO_MATCH, empty matches", () => {
  const rules: readonly GovernanceRule[] = [
    itemRule("r-other", 1, "ctx-target", "DROP"),       // different item
    contextRule("r-memory", 1, "memory", "COMPRESS"),   // different context type
  ];
  const policies = makePolicies({ file: ALL_ACTIONS });

  const result = resolve("ctx-absent", rules, policies, "file");
  assert.equal(result.status, "no_match");
  assert.equal(result.reasonCode, "RULE_NO_MATCH");
  assert.equal(result.winningRule, undefined);
  assert.deepEqual([...result.matchedRuleIds], []);
  assert.deepEqual([...result.diagnostics], []);
});

test("resolve: empty rule set -> deterministic no_match with nothing surfaced", () => {
  const policies = makePolicies({ file: ALL_ACTIONS });
  const result = resolve("ctx-any", [], policies, "file");
  assert.equal(result.status, "no_match");
  assert.equal(result.reasonCode, "RULE_NO_MATCH");
  assert.equal(result.winningRule, undefined);
  assert.deepEqual([...result.matchedRuleIds], []);
  assert.deepEqual([...result.diagnostics], []);

  const batch = resolveAll([], [], policies);
  assert.deepEqual([...batch], []);
});

test("determinism: identical inputs twice -> deep-equal resolutions, stable batch order", () => {
  const rules: readonly GovernanceRule[] = [
    itemRule("r-item", 90, "ctx-login", "DROP"),
    contextRule("r-ctx", 50, "file", "COMPRESS"),
    globalRule("r-global", 1, "KEEP"),
    globalRule("g-high", 10, "KEEP"),
    globalRule("a-rule", 5, "KEEP"),
  ];
  const policies = makePolicies({ file: ALL_ACTIONS, memory: ALL_ACTIONS });

  const first = resolve("ctx-login", rules, policies, "file");
  const second = resolve("ctx-login", rules, policies, "file");
  assert.deepEqual(first, second);

  const items: readonly RuleResolutionItem[] = [
    { itemId: "ctx-login", contextType: "file" },
    { itemId: "ctx-other", contextType: "file" },
  ];
  const batch1 = resolveAll(items, rules, policies);
  const batch2 = resolveAll(items, rules, policies);
  assert.deepEqual(batch1, batch2);
  assert.deepEqual(idsOfResolutions(batch1), ["ctx-login", "ctx-other"]);
  // Each batch entry is identical to the standalone resolve for that item.
  assert.deepEqual(batch1[0], resolve("ctx-login", rules, policies, "file"));
  assert.deepEqual(batch1[1], resolve("ctx-other", rules, policies, "file"));
});

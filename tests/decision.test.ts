import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildContextRetentionRequest,
  evaluateContextRetentionRequest,
  resolveContextRetention,
} from "../src/governor/provider.ts";
import { DecisionProviderUnavailableError } from "../src/types/decision.ts";
import { InvalidContextItemError } from "../src/types/inventory.ts";
import { createDecisionRecord, decideItem, resolvePolicyThresholds } from "../src/governor/govern.ts";

import type {
  ContextRetentionRequest,
  ContextRetentionRequestInput,
  ContextRetentionProposal,
  ContextRetentionProvenance,
  DecisionRegistryEntry,
  DecisionRequestKind,
  DecisionProposalViolationCode,
  DecisionEvaluationCode,
} from "../src/types/decision.ts";
import type { GovernanceDecisionRecord } from "../src/types/governance.ts";
import type { ContextItem, GovernanceDecision } from "../src/types/context.ts";
import type {
  GovernancePolicySet,
  GovernanceRule,
  GovernorInput,
} from "../src/types/governance.ts";

const item: ContextItem = {
  id: "tool-1",
  type: "tool_output",
  content: "an old tool output under evaluation",
  tokenCount: 10,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  metadata: {
    priority: 0.5,
    ageTurns: 4,
    references: 0,
    source: "test",
    compressed: false,
    transformed: false,
    pinned: false,
  },
  state: "ACTIVE",
  revision: 1,
};

function makePolicies(escalationEnabled: boolean, ambiguityConfigured = true): GovernancePolicySet {
  return {
    allowedActionsByType: new Map([
      ["tool_output", new Set(["KEEP", "DROP"] as const)],
    ]),
    providerEscalationEnabled: escalationEnabled,
    ...(ambiguityConfigured ? { ambiguityRange: { min: 0.3, max: 0.7 } } : {}),
    fallbackByDecisionKind: new Map(),
    thresholds: { keepAtOrAbove: 0.65, retainAtOrAbove: 0.35 },
  };
}

interface RunOptions {
  rules?: readonly GovernanceRule[];
  enabled?: readonly GovernanceDecision[];
  taskSummary?: string;
  policyVersion?: string;
  pinned?: boolean;
  requestTimeoutMs?: number;
}

function runResolve(
  policies: GovernancePolicySet,
  scores: ReadonlyMap<string, number>,
  registry: readonly DecisionRegistryEntry[] = [],
  options: RunOptions = {},
): Promise<{ readonly record: GovernanceDecisionRecord; readonly provenance: ContextRetentionProvenance }> {
  return resolveContextRetention({
    item: {
      ...item,
      ...(options.pinned === undefined ? {} : { metadata: { ...item.metadata, pinned: options.pinned } }),
    },
    rules: options.rules ?? [],
    policies,
    scores,
    enabledDecisionKinds: new Set(options.enabled ?? ["KEEP", "DROP"]),
    taskSummary: options.taskSummary ?? "fix the reported test failure",
    policyVersion: options.policyVersion ?? "policy-v1",
    registry,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
}

const asProposal = (value: unknown): ContextRetentionProposal => value as ContextRetentionProposal;

function makeEntry(
  id: string,
  propose: (request: ContextRetentionRequest) => Promise<ContextRetentionProposal>,
  enabled = true,
): DecisionRegistryEntry {
  return {
    id,
    capabilities: ["ContextRetentionDecision"],
    enabled,
    propose,
  };
}

function wellFormedDrop(confidence = 0.9): Promise<ContextRetentionProposal> {
  return Promise.resolve(asProposal({
    requestId: "retain:tool-1@policy-v1",
    kind: "ContextRetentionDecision",
    schemaVersion: "1",
    outcome: "DROP",
    confidence,
  }));
}

function scoresFor(score: number): ReadonlyMap<string, number> {
  return new Map([[item.id, score]]);
}

test("buildContextRetentionRequest stamps the deterministic envelope the Governor owns", () => {
  const requestInput: ContextRetentionRequestInput = {
    itemId: item.id,
    itemType: item.type,
    taskSummary: "fix the reported test failure",
    tokenCost: item.tokenCount,
    ageTurns: item.metadata.ageTurns,
    referenceCount: item.metadata.references,
    pinned: false,
  };
  const request = buildContextRetentionRequest(requestInput, ["KEEP", "DROP"], "policy-v1");

  assert.equal(request.requestId, "retain:tool-1@policy-v1");
  assert.equal(request.kind, "ContextRetentionDecision");
  assert.equal(request.schemaVersion, "1");
  assert.equal(request.policyVersion, "policy-v1");
  assert.deepEqual([...request.allowedOutcomes], ["KEEP", "DROP"]);
  assert.equal(request.input.tokenCost, 10);
});

test("a malformed request envelope surfaces as an explicit Governor-side input error", async () => {
  const brokenInput: ContextRetentionRequestInput = {
    itemId: item.id,
    itemType: item.type,
    taskSummary: "",
    tokenCost: item.tokenCount,
    pinned: false,
  };
  try {
    buildContextRetentionRequest(brokenInput, ["KEEP"], "policy-v1");
    assert.fail("expected InvalidContextItemError for the empty taskSummary");
  } catch (error) {
    assert.ok(error instanceof InvalidContextItemError);
    assert.equal(error.itemId, item.id);
    assert.match(error.reason, /invalid_task_summary/);
  }
});

test("escalation disabled resolves to the exact deterministic record with gating provenance", async () => {
  const policies = makePolicies(false);
  const scores = scoresFor(0.5);
  const registry = [makeEntry("any-provider", (_request) => wellFormedDrop())];
  const direct = createDecisionRecord(
    item,
    decideItem(item, [], policies, scores, new Set(["KEEP", "DROP"]), resolvePolicyThresholds(policies)),
    policies,
  );

  const resolved = await runResolve(policies, scores, registry);
  assert.deepEqual(resolved.record, direct);
  assert.equal(resolved.provenance.status, "deterministic");
  assert.equal(resolved.provenance.reasonCode, "ESCALATION_DISABLED");
  assert.equal(resolved.provenance.finalAction, "KEEP");
  assert.equal(resolved.provenance.finalReasonCode, "MIDDLE_BAND_KEEP");
  assert.equal(resolved.provenance.providerId, undefined);
});

test("pinned items never reach a provider even when escalation is enabled", async () => {
  const policies = makePolicies(true);
  const registry = [makeEntry("any-provider", (_request) => wellFormedDrop())];
  const resolved = await runResolve(policies, scoresFor(0.5), registry, { pinned: true });

  assert.equal(resolved.record.action, "KEEP");
  assert.equal(resolved.record.reasonCode, "HARD_CONSTRAINT_PINNED");
  assert.equal(resolved.provenance.status, "deterministic");
  assert.equal(resolved.provenance.reasonCode, "HARD_CONSTRAINT_PINNED");
  assert.equal(resolved.provenance.providerId, undefined);
});

test("an explicit rule already decides the case, so no provider is consulted", async () => {
  const policies = makePolicies(true);
  const rules: readonly GovernanceRule[] = [{ ruleId: "drop-old-tool", priority: 1, scope: "item", itemId: item.id, action: "DROP" }];
  const registry = [makeEntry("any-provider", (_request) => wellFormedDrop())];
  const resolved = await runResolve(policies, scoresFor(0.5), registry, { rules });

  assert.equal(resolved.record.action, "DROP");
  assert.match(resolved.record.reasonCode, /ruleId=drop-old-tool/);
  assert.equal(resolved.provenance.status, "deterministic");
  assert.equal(resolved.provenance.reasonCode, "RULE_ALREADY_DECIDED");
  assert.equal(resolved.provenance.providerId, undefined);
});

test("policies without an ambiguity window keep the deterministic path in full control", async () => {
  const policies = makePolicies(true, false);
  const registry = [makeEntry("any-provider", (_request) => wellFormedDrop())];
  const resolved = await runResolve(policies, scoresFor(0.5), registry);

  assert.equal(resolved.provenance.status, "deterministic");
  assert.equal(resolved.provenance.reasonCode, "AMBIGUITY_NOT_CONFIGURED");
  assert.equal(resolved.record.action, "KEEP");
  assert.equal(resolved.record.reasonCode, "MIDDLE_BAND_KEEP");
});

const retentionRequestInput: ContextRetentionRequestInput = {
  itemId: item.id,
  itemType: item.type,
  taskSummary: "fix the reported test failure",
  tokenCost: item.tokenCount,
  ageTurns: item.metadata.ageTurns,
  referenceCount: item.metadata.references,
  pinned: false,
};

const retentionRequest = buildContextRetentionRequest(retentionRequestInput, ["KEEP", "DROP"], "policy-v1");

test("registry lookup takes the first entry declaring the kind, even when it is disabled", async () => {
  let secondInvoked = false;
  const registry = [
    makeEntry("disabled-first", (_request) => wellFormedDrop(), false),
    makeEntry("second-capable", (_request) => {
      secondInvoked = true;
      return wellFormedDrop();
    }),
  ];
  const evaluation = await evaluateContextRetentionRequest(retentionRequest, registry);

  assert.equal(evaluation.status, "PROVIDER_DISABLED");
  assert.equal(evaluation.providerId, "");
  assert.equal(secondInvoked, false);
});

test("a valid proposal normalizes to the contract with provider extras stripped", async () => {
  const entry = makeEntry("advisor", (_request) => Promise.resolve(asProposal({
    requestId: "retain:tool-1@policy-v1",
    kind: "ContextRetentionDecision",
    schemaVersion: "1",
    outcome: "DROP",
    confidence: 0.7,
    scores: { relevance: 0.4 },
    rationaleCode: "old and unrelated",
    providerInternalPrompt: "this must never survive validation",
  })));
  const evaluation = await evaluateContextRetentionRequest(retentionRequest, [entry]);

  assert.equal(evaluation.status, "proposal");
  assert.equal(evaluation.providerId, "advisor");
  assert.deepEqual(evaluation.proposal, {
    requestId: "retain:tool-1@policy-v1",
    kind: "ContextRetentionDecision",
    schemaVersion: "1",
    outcome: "DROP",
    confidence: 0.7,
    scores: { relevance: 0.4 },
    rationaleCode: "old and unrelated",
  });
});

test("provider unavailability, exceptions, and timeouts are recorded as distinct failure codes", async () => {
  const hang = new Promise<ContextRetentionProposal>(() => undefined);
  const cases: readonly [DecisionEvaluationCode, DecisionRegistryEntry[]][] = [
    ["PROVIDER_UNAVAILABLE", [makeEntry("no-backend", (_request) =>
      Promise.reject(new DecisionProviderUnavailableError("no local backend configured")))]],
    ["PROVIDER_EXCEPTION", [makeEntry("exploding", (_request) =>
      Promise.reject(new Error("backend exploded")))]],
    ["PROVIDER_TIMEOUT", [makeEntry("slow", (_request) => hang)]],
  ];

  for (const [expected, registry] of cases) {
    const evaluation = await evaluateContextRetentionRequest(retentionRequest, registry, 5);
    assert.equal(evaluation.status, expected);
    assert.equal(evaluation.proposal, undefined);
    assert.equal(evaluation.providerId, registry[0].id);
  }
});

test("malformed provider output is rejected with an explicit violation code, never adopted", async () => {
  const malformed: readonly [unknown, DecisionProposalViolationCode][] = [
    [null, "PROPOSAL_NOT_OBJECT"],
    [[{ requestId: "retain:tool-1@policy-v1" }], "PROPOSAL_NOT_OBJECT"],
    ["DROP", "PROPOSAL_NOT_OBJECT"],
    [{ requestId: "other:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "DROP" }, "PROPOSAL_REQUEST_ID_MISMATCH"],
    [{ kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "DROP" }, "PROPOSAL_REQUEST_ID_MISMATCH"],
    [{ requestId: "r".repeat(300), kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "DROP" }, "PROPOSAL_REQUEST_ID_TOO_LONG"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "MemoryImportanceDecision", schemaVersion: "1", outcome: "DROP" }, "PROPOSAL_KIND_MISMATCH"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "2", outcome: "DROP" }, "PROPOSAL_SCHEMA_VERSION_UNSUPPORTED"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "PURGE" }, "PROPOSAL_OUTCOME_INVALID"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "COMPRESS" }, "PROPOSAL_OUTCOME_NOT_ALLOWED"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "DROP", confidence: 1.5 }, "PROPOSAL_CONFIDENCE_INVALID"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "DROP", confidence: "0.9" }, "PROPOSAL_CONFIDENCE_INVALID"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "DROP", scores: { relevance: -0.1 } }, "PROPOSAL_SCORES_INVALID"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "DROP", scores: ["relevance"] }, "PROPOSAL_SCORES_INVALID"],
    [{ requestId: "retain:tool-1@policy-v1", kind: "ContextRetentionDecision", schemaVersion: "1", outcome: "DROP", rationaleCode: {} }, "PROPOSAL_RATIONALE_INVALID"],
  ];

  for (const [raw, violationCode] of malformed) {
    const evaluation = await evaluateContextRetentionRequest(
      retentionRequest,
      [makeEntry("bad-output", (_request) => Promise.resolve(asProposal(raw)))],
    );
    assert.equal(evaluation.status, "PROPOSAL_INVALID");
    assert.equal(evaluation.violationCode, violationCode);
    assert.equal(evaluation.providerId, "bad-output");
    assert.equal(evaluation.proposal, undefined);
  }
});

test("a non-positive call ceiling is a governor-side configuration error, not a provider failure", async () => {
  try {
    await evaluateContextRetentionRequest(
      retentionRequest,
      [makeEntry("slow", (_request) => wellFormedDrop())],
      0,
    );
    assert.fail("expected InvalidContextItemError for the non-positive ceiling");
  } catch (error) {
    assert.ok(error instanceof InvalidContextItemError);
    assert.match(error.reason, /invalid_timeout_ceiling/);
  }
});

test("a valid, allowed provider outcome is adopted as the Governor-owned final action", async () => {
  const policies = makePolicies(true);
  const resolved = await runResolve(policies, scoresFor(0.5), [makeEntry("advisor", (_request) => wellFormedDrop(0.8))]);

  assert.equal(resolved.provenance.status, "provider_adopted");
  assert.equal(resolved.provenance.reasonCode, "PROPOSAL_ADOPTED");
  assert.equal(resolved.provenance.deterministicAction, "KEEP");
  assert.equal(resolved.provenance.deterministicReasonCode, "MIDDLE_BAND_KEEP");
  assert.equal(resolved.provenance.finalAction, "DROP");
  // The adopted record's reason must name provider adoption, not the
  // deterministic band that produced a different action.
  assert.equal(resolved.provenance.finalReasonCode, "PROVIDER_PROPOSAL_ADOPTED");
  assert.equal(resolved.provenance.providerId, "advisor");
  assert.equal(resolved.provenance.proposalOutcome, "DROP");
  assert.equal(resolved.record.action, "DROP");
  assert.equal(resolved.record.reasonCode, "PROVIDER_PROPOSAL_ADOPTED");
  assert.equal(resolved.record.reasonCode, resolved.provenance.finalReasonCode);
  assert.equal(resolved.record.score, 0.5);
  assert.equal(resolved.record.providerProposal, "DROP");
  // The adopted record must be frozen like every other resolution record, so
  // post-resolution mutation cannot make action/reason disagree with provenance.
  assert.equal(Object.isFrozen(resolved.record), true);
});

test("providers cannot widen the outcome space even under a permissive policy", async () => {
  const permissive: GovernancePolicySet = {
    allowedActionsByType: new Map([["tool_output", new Set(["KEEP", "DROP", "COMPRESS"] as const)]]),
    providerEscalationEnabled: true,
    ambiguityRange: { min: 0.3, max: 0.7 },
    fallbackByDecisionKind: new Map(),
    thresholds: { keepAtOrAbove: 0.65, retainAtOrAbove: 0.35 },
  };
  const resolved = await runResolve(permissive, scoresFor(0.5), [
    makeEntry("compressor", (_request) => Promise.resolve(asProposal({
      requestId: "retain:tool-1@policy-v1",
      kind: "ContextRetentionDecision",
      schemaVersion: "1",
      outcome: "COMPRESS",
    }))),
  ]);

  assert.equal(resolved.provenance.status, "provider_failed");
  assert.equal(resolved.provenance.reasonCode, "PROPOSAL_INVALID");
  assert.equal(resolved.record.action, "KEEP");
  assert.equal(resolved.record.reasonCode, "MIDDLE_BAND_KEEP");
});

test("disabled, unavailable, failed, timed out, and invalid providers fall back deterministically", async () => {
  const hang = new Promise<ContextRetentionProposal>(() => undefined);
  const fallbackCases: readonly [string, readonly DecisionRegistryEntry[], RunOptions][] = [
    ["PROVIDER_UNAVAILABLE", [makeEntry("no-backend", (_request) =>
      Promise.reject(new DecisionProviderUnavailableError("no local backend")))], {}],
    ["PROVIDER_EXCEPTION", [makeEntry("exploding", (_request) =>
      Promise.reject(new Error("backend exploded")))], {}],
    ["PROVIDER_TIMEOUT", [makeEntry("slow", (_request) => hang)], { requestTimeoutMs: 5 }],
    ["PROVIDER_DISABLED", [makeEntry("off", (_request) => wellFormedDrop(), false)], {}],
    ["NO_CAPABLE_PROVIDER", [], {}],
    ["PROPOSAL_INVALID", [makeEntry("bad-output", (_request) =>
      Promise.resolve(asProposal({ requestId: "different@request", outcome: "DROP" })))], {}],
  ];

  for (const [expected, registry, options] of fallbackCases) {
    const resolved = await runResolve(makePolicies(true), scoresFor(0.5), registry, options);

    assert.equal(resolved.provenance.status, "provider_failed");
    assert.equal(resolved.provenance.reasonCode, expected);
    assert.equal(resolved.provenance.finalAction, resolved.provenance.deterministicAction);
    assert.equal(resolved.record.action, "KEEP");
    assert.equal(resolved.record.reasonCode, "MIDDLE_BAND_KEEP");
  }
});

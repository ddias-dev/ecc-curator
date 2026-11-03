// ECC Curator — Decision Provider Interface enforcement (Phase 3).
// Source of truth: docs/GOVERNOR_ALGORITHM.md ("Deterministic evaluation
// order" steps 5-8, "Provider escalation criteria", "Provider fallback
// behavior") and the frozen Phase-3 contracts in ../types/decision.ts
// (imported, never rewritten), composed on top of the deterministic
// Governor decisions in ./govern.ts (imported, never rewritten).
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums;
// `import type` for compile-time imports, plain imports for runtime values.
//
// INVARIANTS (ADR-011 / roadmap Phase 3 success criteria):
//  - Providers are consulted ONLY here, behind explicit deterministic gates
//    (escalation enabled, item not pinned, no rule already decided, score
//    inside the configured ambiguity window, allowed outcomes non-empty).
//  - The deterministic govern() path never calls a provider; this module
//    composes with it without altering its baseline behavior.
//  - Raw provider output is handled as `unknown` and re-validated against the
//    request before it can influence any governance decision; proposals stay
//    advisory, and pins/budgets remain enforced by decideItem()/
//    createDecisionRecord()/fitWorkingSet() as before.
//  - Every non-adoption path (disabled, unavailable, timeout, exception,
//    unsupported kind, invalid proposal, disallowed outcome) falls back to
//    the same deterministic baseline action and records WHY — never a
//    success-shaped result, never a silent provider "win".

import { DecisionProviderUnavailableError } from "../types/decision.ts";
import { InvalidContextItemError } from "../types/inventory.ts";
import { createDecisionRecord, decideItem, resolvePolicyThresholds } from "../governor/govern.ts";

import type {
  ContextRetentionRequest,
  ContextRetentionRequestInput,
  ContextRetentionProposal,
  ContextRetentionProvenance,
  ContextRetentionResolution,
  ContextRetentionResolutionInput,
  DecisionRegistryEntry,
  DecisionEvaluationResult,
  DecisionCallFailureCode,
  DecisionProposalViolationCode,
  DecisionRequestKind,
  DecisionAllowedOutcome,
  ContextRetentionOutcome,
  DecisionTimeoutMs,
} from "../types/decision.ts";
import type { ContextType, GovernanceDecision } from "../types/context.ts";
import type { GovernorItemDecision, PolicyThresholds } from "../governor/govern.ts";
import type { GovernanceDecisionRecord } from "../types/governance.ts";

const REQUEST_ID_MAX_CHARACTERS = 256;
const POLICY_VERSION_MAX_CHARACTERS = 256;
const TASK_SUMMARY_MAX_CHARACTERS = 2_000;
const CONTENT_SUMMARY_MAX_CHARACTERS = 1_000;
const PROPOSAL_ID_MAX_CHARACTERS = 256;
const PROPOSAL_RATIONALE_MAX_CHARACTERS = 256;
const PROPOSAL_SCORE_MAX_ENTRIES = 16;
const DEFAULT_CALL_TIMEOUT_MS = 5_000;

const CONTRACT_OUTCOMES: readonly ContextRetentionOutcome[] = ["KEEP", "DROP", "COMPRESS", "TRANSFORM"];
const MVP_EXECUTABLE_OUTCOMES = new Set(["KEEP", "DROP"]);

const isFiniteUnit = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const isNonNegativeInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isBoundedText = (value: unknown, maxCharacters: number): boolean =>
  typeof value === "string" && value.length > 0 && value.length <= maxCharacters;

const isOptionalBoundedText = (value: unknown, maxCharacters: number): boolean =>
  value === undefined || (typeof value === "string" && value.length <= maxCharacters);

// ---------------------------------------------------------------------------
// Deterministic request envelope construction + validation (the Governor
// builds requests; providers construct no request state and cannot widen
// allowedOutcomes). A malformed envelope is a Governor-side input problem:
// it surfaces explicitly as InvalidContextItemError, never as a provider
// failure (a provider failure is only what happens when CALLING a provider).
// requestId derivation is deterministic and auditable: retain:<itemId>@<policyVersion>.
// ---------------------------------------------------------------------------

function requireValid(ok: boolean, itemId: string, reason: string): void {
  if (!ok) {
    throw new InvalidContextItemError(itemId, reason);
  }
}

export function validateContextRetentionRequest(request: ContextRetentionRequest): void {
  const input = request.input;
  requireValid(
    isBoundedText(request.requestId, REQUEST_ID_MAX_CHARACTERS),
    input.itemId,
    "invalid_request_id: requestId must be a non-empty bounded string",
  );
  requireValid(
    request.kind === "ContextRetentionDecision",
    input.itemId,
    "unsupported_request_kind: only ContextRetentionDecision has an implemented Phase-3 contract",
  );
  requireValid(
    request.schemaVersion === "1",
    input.itemId,
    'unsupported_schema_version: Phase 3 implements schema version "1" only',
  );
  requireValid(
    isBoundedText(request.policyVersion, POLICY_VERSION_MAX_CHARACTERS),
    input.itemId,
    "invalid_policy_version: policyVersion must be a non-empty bounded string",
  );
  requireValid(
    request.allowedOutcomes.length > 0,
    input.itemId,
    "empty_allowed_outcomes: a decision request needs at least one allowed outcome",
  );
  for (const outcome of request.allowedOutcomes) {
    requireValid(
      CONTRACT_OUTCOMES.includes(outcome),
      input.itemId,
      `invalid_allowed_outcome: ${outcome} is not a governance action value`,
    );
  }
  requireValid(
    isBoundedText(input.itemId, REQUEST_ID_MAX_CHARACTERS),
    input.itemId,
    "invalid_item_id: itemId must be a non-empty bounded string",
  );
  requireValid(
    isBoundedText(input.itemType, REQUEST_ID_MAX_CHARACTERS),
    input.itemId,
    "invalid_item_type: itemType must be a non-empty bounded string",
  );
  requireValid(
    isBoundedText(input.taskSummary, TASK_SUMMARY_MAX_CHARACTERS),
    input.itemId,
    "invalid_task_summary: task state must be non-empty bounded text (never a full transcript)",
  );
  requireValid(
    isOptionalBoundedText(input.contentSummary, CONTENT_SUMMARY_MAX_CHARACTERS),
    input.itemId,
    "invalid_content_summary: contentSummary must be bounded text or omitted",
  );
  requireValid(
    isNonNegativeInteger(input.tokenCost),
    input.itemId,
    "invalid_token_cost: tokenCost must be a non-negative safe integer",
  );
  requireValid(
    input.ageTurns === undefined || isNonNegativeInteger(input.ageTurns),
    input.itemId,
    "invalid_age_turns: ageTurns must be a non-negative safe integer or omitted",
  );
  requireValid(
    input.referenceCount === undefined || isNonNegativeInteger(input.referenceCount),
    input.itemId,
    "invalid_reference_count: referenceCount must be a non-negative safe integer or omitted",
  );
  requireValid(
    typeof input.pinned === "boolean",
    input.itemId,
    "invalid_pinned_flag: pinned must be an explicit boolean",
  );
}

export function buildContextRetentionRequest(
  input: ContextRetentionRequestInput,
  allowedOutcomes: readonly DecisionAllowedOutcome[],
  policyVersion: string,
): ContextRetentionRequest {
  const request: ContextRetentionRequest = {
    requestId: `retain:${input.itemId}@${policyVersion}`,
    kind: "ContextRetentionDecision",
    schemaVersion: "1",
    policyVersion,
    allowedOutcomes,
    input,
  };
  validateContextRetentionRequest(request);
  return request;
}

// ---------------------------------------------------------------------------
// Registry lookup and provider invocation. Lookup takes the FIRST entry
// declaring the requested kind, deterministically (registry order is explicit
// caller configuration). Timeout ceilings are host-declared: explicit call
// config wins, then the provider-declared ceiling, then the default. A
// timed-out or still-running provider call is never retried here.
// ---------------------------------------------------------------------------

const TIMEOUT_SENTINEL = { timedOut: true };

async function callWithTimeout(callPromise: Promise<unknown>, ceilingMs: number): Promise<unknown> {
  let timer; // node:timers Timeout (no annotation: the interface is not importable from the types lib)
  try {
    const timeoutPromise = new Promise((accept) => {
      timer = setTimeout(() => accept(TIMEOUT_SENTINEL), ceilingMs);
    });
    return await Promise.race([callPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

interface ProviderCallOutcome {
  code: DecisionCallFailureCode | ""; // "" only when the call returned and produced raw output
  providerId: string; // entry id when a provider was invoked; "" when gating stopped the call
  raw: unknown; // raw provider output, ALWAYS unvalidated — handled as unknown
}

async function invokeRegistryEntry(
  entry: DecisionRegistryEntry,
  request: ContextRetentionRequest,
  hostTimeoutMs?: number,
): Promise<ProviderCallOutcome> {
  if (!entry.enabled) {
    return { code: "PROVIDER_DISABLED", providerId: "", raw: undefined };
  }
  if (!entry.capabilities.includes(request.kind)) {
    return { code: "UNSUPPORTED_DECISION_KIND", providerId: "", raw: undefined };
  }
  const ceilingMs = hostTimeoutMs ?? entry.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(ceilingMs) || ceilingMs <= 0) {
    throw new InvalidContextItemError(
      request.input.itemId,
      `invalid_timeout_ceiling: call ceiling ${ceilingMs} must be a safe integer > 0`,
    );
  }
  try {
    const raw = await callWithTimeout(entry.propose(request), ceilingMs);
    if (raw === TIMEOUT_SENTINEL) {
      return { code: "PROVIDER_TIMEOUT", providerId: entry.id, raw: undefined };
    }
    return { code: "", providerId: entry.id, raw };
  } catch (error) {
    if (error instanceof DecisionProviderUnavailableError) {
      return { code: "PROVIDER_UNAVAILABLE", providerId: entry.id, raw: undefined };
    }
    return { code: "PROVIDER_EXCEPTION", providerId: entry.id, raw: undefined };
  }
}

// ---------------------------------------------------------------------------
// Governor-side proposal validation (GOVERNOR_ALGORITHM step 6: "Match
// request ID, kind, schema version, required fields, score bounds, allowed
// outcomes ... Invalid output is a provider failure"). Raw provider output is
// `unknown`; on success a NORMALIZED proposal is built from validated fields
// only (no extra provider keys survive, rationale is length-capped, and
// confidence/scores are only copied after finite [0, 1] checks).
// ---------------------------------------------------------------------------

interface ProposalValidationResult {
  code: DecisionProposalViolationCode | ""; // "" when valid
  detail?: string;
}

export function validateContextRetentionProposal(
  request: ContextRetentionRequest,
  raw: unknown,
): ProposalValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { code: "PROPOSAL_NOT_OBJECT" };
  }
  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.requestId !== "string") {
    return { code: "PROPOSAL_REQUEST_ID_MISMATCH" };
  }
  if (candidate.requestId.length > PROPOSAL_ID_MAX_CHARACTERS) {
    return { code: "PROPOSAL_REQUEST_ID_TOO_LONG" };
  }
  if (candidate.requestId !== request.requestId) {
    return { code: "PROPOSAL_REQUEST_ID_MISMATCH" };
  }
  if (candidate.kind !== request.kind) {
    return { code: "PROPOSAL_KIND_MISMATCH" };
  }
  if (candidate.schemaVersion !== request.schemaVersion) {
    return { code: "PROPOSAL_SCHEMA_VERSION_UNSUPPORTED" };
  }

  if (typeof candidate.outcome !== "string") {
    return { code: "PROPOSAL_OUTCOME_INVALID" };
  }
  const outcome = candidate.outcome as GovernanceDecision;
  if (!CONTRACT_OUTCOMES.includes(outcome)) {
    return { code: "PROPOSAL_OUTCOME_INVALID" };
  }
  if (!request.allowedOutcomes.includes(outcome)) {
    return {
      code: "PROPOSAL_OUTCOME_NOT_ALLOWED",
      detail: `outcome ${outcome} not in request allowedOutcomes`,
    };
  }

  if (candidate.confidence !== undefined && !isFiniteUnit(candidate.confidence)) {
    return {
      code: "PROPOSAL_CONFIDENCE_INVALID",
      detail: `confidence ${candidate.confidence} not finite in [0,1]`,
    };
  }

  const scoreEntries: [string, number][] = [];
  if (candidate.scores !== undefined) {
    if (typeof candidate.scores !== "object" || candidate.scores === null ||
      Array.isArray(candidate.scores)) {
      return { code: "PROPOSAL_SCORES_INVALID" };
    }
    const scores = candidate.scores as Record<string, unknown>;
    for (const [key, value] of Object.entries(scores)) {
      if (!isFiniteUnit(value)) {
        return {
          code: "PROPOSAL_SCORES_INVALID",
          detail: `score ${key}=${value} not finite in [0,1]`,
        };
      }
      scoreEntries.push([key, value as number]);
    }
    if (scoreEntries.length > PROPOSAL_SCORE_MAX_ENTRIES) {
      return {
        code: "PROPOSAL_SCORES_INVALID",
        detail: `score map exceeds ${PROPOSAL_SCORE_MAX_ENTRIES} entries`,
      };
    }
  }

  if (candidate.rationaleCode !== undefined) {
    if (typeof candidate.rationaleCode !== "string" ||
      candidate.rationaleCode.length > PROPOSAL_RATIONALE_MAX_CHARACTERS) {
      return {
        code: "PROPOSAL_RATIONALE_INVALID",
        detail: "rationaleCode must be bounded audit text",
      };
    }
  }

  return { code: "" };
}

// Build the normalized proposal from validated fields ONLY (keys like
// confidence/scores/rationaleCode are re-emitted exactly once each, so a
// prototype-polluted or duplicate-key provider object cannot smuggle extras).
function normalizeProposal(
  request: ContextRetentionRequest,
  candidate: Record<string, unknown>,
  outcome: GovernanceDecision,
  scoreEntries: readonly [string, number][],
): ContextRetentionProposal {
  const confidence = candidate.confidence;
  const rationaleCode = candidate.rationaleCode;
  return {
    requestId: request.requestId,
    kind: request.kind,
    schemaVersion: request.schemaVersion,
    outcome,
    ...(confidence !== undefined && typeof confidence === "number"
      ? { confidence }
      : {}),
    ...(scoreEntries.length > 0 ? { scores: Object.fromEntries(scoreEntries) } : {}),
    ...(rationaleCode !== undefined && typeof rationaleCode === "string" && rationaleCode !== ""
      ? { rationaleCode }
      : {}),
  };
}

interface RegistryLookup {
  entry?: DecisionRegistryEntry;
  failureCode?: DecisionCallFailureCode; // set only when no entry matched
}

function selectRegistryEntry(
  registry: readonly DecisionRegistryEntry[],
  kind: DecisionRequestKind,
): RegistryLookup {
  for (const entry of registry) {
    if (entry.capabilities.includes(kind)) {
      return { entry };
    }
  }
  return { failureCode: "NO_CAPABLE_PROVIDER" };
}

// ---------------------------------------------------------------------------
// Full provider evaluation: registry lookup -> gated call -> proposal
// validation. Never throws for provider problems: every provider failure and
// violation is surfaced in the typed result so the caller can fall back
// deterministically. (Invalid REQUEST envelopes still throw — request
// construction is Governor-owned programming, not provider behavior.)
// ---------------------------------------------------------------------------

export async function evaluateContextRetentionRequest(
  request: ContextRetentionRequest,
  registry: readonly DecisionRegistryEntry[],
  hostTimeoutMs?: number,
): Promise<DecisionEvaluationResult> {
  validateContextRetentionRequest(request);
  const lookup = selectRegistryEntry(registry, request.kind);
  if (lookup.entry === undefined) {
    return {
      requestId: request.requestId,
      kind: request.kind,
      providerId: "",
      status: lookup.failureCode ?? "NO_CAPABLE_PROVIDER",
    };
  }
  const call = await invokeRegistryEntry(lookup.entry, request, hostTimeoutMs);
  if (call.code !== "") {
    return {
      requestId: request.requestId,
      kind: request.kind,
      providerId: call.providerId,
      status: call.code,
    };
  }
  const validation = validateContextRetentionProposal(request, call.raw);
  if (validation.code !== "") {
    return {
      requestId: request.requestId,
      kind: request.kind,
      providerId: call.providerId,
      status: "PROPOSAL_INVALID",
      violationCode: validation.code,
      detail: validation.detail,
    };
  }
  const candidate = call.raw as Record<string, unknown>;
  const outcome = candidate.outcome as GovernanceDecision;
  const scoreEntries: [string, number][] = [];
  if (candidate.scores !== undefined && typeof candidate.scores === "object" &&
    candidate.scores !== null && !Array.isArray(candidate.scores)) {
    for (const [key, value] of Object.entries(candidate.scores)) {
      scoreEntries.push([key, value as number]);
    }
  }
  return {
    requestId: request.requestId,
    kind: request.kind,
    providerId: call.providerId,
    status: "proposal",
    proposal: normalizeProposal(request, candidate, outcome, scoreEntries),
  };
}

// ---------------------------------------------------------------------------
// Full Governor-side resolution for one item: deterministic decision first
// (decideItem), gated provider escalation second (GOVERNOR_ALGORITHM steps
// 5-7), deterministic fallback + provenance always recorded (step 8).
// Budget fitting remains the caller's existing fitWorkingSet step — pins and
// budget pressure therefore stay authoritative even when a proposal is
// adopted (the record enters the same allocator as before).
// ---------------------------------------------------------------------------

// Governor-owned gating codes: why escalation was skipped for an item.
export type EscalationSkipCode =
  | "ESCALATION_DISABLED" // policies.providerEscalationEnabled === false
  | "HARD_CONSTRAINT_PINNED" // pinned items never ask providers (hard constraint first)
  | "RULE_ALREADY_DECIDED" // an explicit rule resolved the case
  | "AMBIGUITY_NOT_CONFIGURED" // no ambiguityRange in policy: the deterministic path owns all cases
  | "AMBIGUITY_WINDOW_MISS" // heuristic score outside the configured ambiguity window
  | "POLICY_TYPE_UNREGISTERED" // context type missing from allowedActionsByType
  | "NO_ALLOWED_OUTCOMES"; // policy/enabled/MVP intersection is empty

function deriveRequestId(itemId: string, policyVersion: string): string {
  return `retain:${itemId}@${policyVersion}`;
}

export async function resolveContextRetention(
  input: ContextRetentionResolutionInput,
): Promise<ContextRetentionResolution> {
  const thresholds = resolvePolicyThresholds(input.policies);
  const itemDecision = decideItem(
    input.item,
    input.rules,
    input.policies,
    input.scores,
    input.enabledDecisionKinds,
    thresholds,
  );
  const deterministicRecord = createDecisionRecord(
    input.item,
    itemDecision,
    input.policies,
  );
  const requestId = deriveRequestId(input.item.id, input.policyVersion);

  const skip = gateEscalation(input, itemDecision);
  if (skip !== undefined) {
    return Object.freeze({
      record: deterministicRecord,
      provenance: Object.freeze({
        itemId: input.item.id,
        requestId,
        kind: "ContextRetentionDecision",
        policyVersion: input.policyVersion,
        status: "deterministic",
        reasonCode: skip,
        deterministicAction: itemDecision.action,
        deterministicReasonCode: itemDecision.reasonCode,
        finalAction: deterministicRecord.action,
        finalReasonCode: deterministicRecord.reasonCode,
      }) as ContextRetentionProvenance,
    });
  }

  const allowedActions = input.policies.allowedActionsByType.get(input.item.type);
  // gateEscalation guarantees allowedActions is present and the intersection
  // below is non-empty; recompute here because the skip function must stay
  // side-effect-free (the request envelope is built from these outcomes).
  const allowedOutcomes = CONTRACT_OUTCOMES.filter(
    (outcome) =>
      allowedActions !== undefined &&
      allowedActions.has(outcome) &&
      input.enabledDecisionKinds.has(outcome) &&
      MVP_EXECUTABLE_OUTCOMES.has(outcome),
  );

  const request = buildContextRetentionRequest({
    itemId: input.item.id,
    itemType: input.item.type,
    taskSummary: input.taskSummary,
    tokenCost: input.item.tokenCount,
    ageTurns: input.item.metadata.ageTurns,
    referenceCount: input.item.metadata.references,
    pinned: input.item.metadata.pinned,
  }, allowedOutcomes, input.policyVersion);

  const evaluation = await evaluateContextRetentionRequest(
    request,
    input.registry,
    input.requestTimeoutMs,
  );

  if (evaluation.status === "proposal" && evaluation.proposal !== undefined) {
    const adoptedDecision: GovernorItemDecision = {
      ...itemDecision,
      action: evaluation.proposal.outcome,
    };
    // The final action comes from the provider proposal, not from the
    // deterministic band, so the record's reasonCode must not claim a
    // threshold-band reason ("MIDDLE_BAND_KEEP" alongside action DROP would
    // be contradictory). The deterministic baseline (action + reasonCode)
    // remains fully auditable in ContextRetentionProvenance.
    // createDecisionRecord returns a frozen record, but spreading it into a
    // fresh literal does not — re-freeze so callers cannot mutate action or
    // reasonCode after resolution and disagree with provenance.
    const record = Object.freeze({
      ...createDecisionRecord(
        input.item,
        adoptedDecision,
        input.policies,
        {
          decisionKind: evaluation.proposal.outcome,
          itemId: input.item.id,
          proposal: evaluation.proposal.outcome,
          rationale: `providerId=${evaluation.providerId}`,
        },
      ),
      reasonCode: "PROVIDER_PROPOSAL_ADOPTED",
    }) as GovernanceDecisionRecord;
    return Object.freeze({
      record,
      provenance: Object.freeze({
        itemId: input.item.id,
        requestId,
        kind: "ContextRetentionDecision",
        policyVersion: input.policyVersion,
        status: "provider_adopted",
        reasonCode: "PROPOSAL_ADOPTED",
        deterministicAction: itemDecision.action,
        deterministicReasonCode: itemDecision.reasonCode,
        finalAction: record.action,
        finalReasonCode: record.reasonCode,
        providerId: evaluation.providerId,
        proposalOutcome: evaluation.proposal.outcome,
      }) as ContextRetentionProvenance,
    });
  }

  // Fallback keeps the deterministic record byte-for-byte; the provenance
  // carries why the provider changed nothing ("fallback = baseline, unchanged").
  const record = deterministicRecord;
  return Object.freeze({
    record,
    provenance: Object.freeze({
      itemId: input.item.id,
      requestId,
      kind: "ContextRetentionDecision",
      policyVersion: input.policyVersion,
      status: "provider_failed",
      reasonCode: evaluation.status,
      deterministicAction: itemDecision.action,
      deterministicReasonCode: itemDecision.reasonCode,
      finalAction: record.action,
      finalReasonCode: record.reasonCode,
      ...(evaluation.providerId === "" ? {} : { providerId: evaluation.providerId }),
    }) as ContextRetentionProvenance,
  });
}

// Escalation gating (GOVERNOR_ALGORITHM "Provider escalation criteria"):
// consult a provider only when deterministic policy has not already resolved
// the case, the item is not pinned, the heuristic score sits inside the
// configured ambiguity window, the context type is registered in policy, and
// at least one outcome is policy-allowed AND governance-enabled AND executable
// without a strategy executor (Phase 3 MVP: KEEP/DROP). A malformed
// ambiguity window is a policy configuration error and surfaces explicitly.
function gateEscalation(
  input: ContextRetentionResolutionInput,
  itemDecision: GovernorItemDecision,
): EscalationSkipCode | undefined {
  if (!input.policies.providerEscalationEnabled) {
    return "ESCALATION_DISABLED";
  }
  if (input.item.metadata.pinned === true) {
    return "HARD_CONSTRAINT_PINNED";
  }
  if (itemDecision.winningRuleId !== undefined) {
    return "RULE_ALREADY_DECIDED";
  }
  const ambiguity = input.policies.ambiguityRange;
  if (ambiguity === undefined) {
    return "AMBIGUITY_NOT_CONFIGURED";
  }
  if (!isFiniteUnit(ambiguity.min) || !isFiniteUnit(ambiguity.max) || ambiguity.min > ambiguity.max) {
    throw new InvalidContextItemError(
      input.item.id,
      "invalid_ambiguity_range: min/max must be finite numbers in [0,1] with min <= max",
    );
  }
  if (itemDecision.score < ambiguity.min || itemDecision.score > ambiguity.max) {
    return "AMBIGUITY_WINDOW_MISS";
  }
  const allowed = input.policies.allowedActionsByType.get(input.item.type);
  if (allowed === undefined) {
    return "POLICY_TYPE_UNREGISTERED";
  }
  for (const outcome of CONTRACT_OUTCOMES) {
    if (allowed.has(outcome) && input.enabledDecisionKinds.has(outcome) && MVP_EXECUTABLE_OUTCOMES.has(outcome)) {
      return undefined;
    }
  }
  return "NO_ALLOWED_OUTCOMES";
}

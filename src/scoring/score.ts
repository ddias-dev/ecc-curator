// src/scoring/score.ts
// ECC Curator - deterministic heuristic scoring engine (Sprint 3a).
// Contract source: docs/SCORING_SPEC.md ("Score range and formula", "Inputs
// and normalization", "Components", "Reference implementation pseudocode",
// "Worked examples") + the compiled contracts in src/types/scoring.ts and
// src/types/context.ts (imported unmodified, never rewritten).
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums;
// relative imports carry explicit .ts extensions; interface/type imports are
// `import type`, runtime values (error classes, DEFAULT_TYPE_BASELINES) are
// plain imports.
//
// Formula (docs/SCORING_SPEC.md):
//   S_i = clamp(0, 1,
//     w_p * P_i + w_r * R_i + w_f * F_i + w_t * T_i + w_c * C_i)
//   P = metadata.priority (validated in [0,1]; out-of-range is an error, never clamped)
//   R = 2 ^ (-ageTurns / halfLifeTurns)                 // halfLifeTurns > 0, default 10
//   F = references / (references + referenceSaturation) // default saturation 3
//   T = typeBaselines[type] ?? 0.50                     // unknown -> 0.50 + UNKNOWN_CONTEXT_TYPE diagnostic
//   C = 1 - min(1, tokenCount / workingBudget)          // workingBudget must be > 0 (explicit error otherwise)
//
// Decided (documented choices for semantics the docs leave open):
// - Config validation failure throws InvalidScoringConfigError (a scorer-owned
//   typed error; the spec says "initialization fails explicitly rather than
//   silently normalizing weights", and src/types/scoring.ts places that
//   validation "in the scorer"). Item-level validation failures throw the
//   imported InvalidContextItemError with an explicit reason code.
// - Weight sum tolerance is 1e-9 (a "configured floating-point tolerance"; the
//   docs fix the number, so this file documents it).
// - Config is validated once per scoring call before any item is scored: a bad
//   configuration fails the whole call, it never degrades item-by-item.
// - Scores are keyed by itemId in a Map preserving first-seen input order; a
//   duplicate id in the batch is an InvalidContextItemError (batch must be a
//   per-item map, and last-writer-wins would hide a caller bug).
// - tokenCount is required on every scored item (ContextItem carries it
//   always). A missing/non-finite count raises TokenEstimationError via the
//   reason "missing_token_estimate" path only when NaN is passed; otherwise a
//   non-finite or negative tokenCount is an InvalidContextItemError. The
//   "unscored item" rule from the docs is enforced by the caller: do not call
//   scoreItems with unestimated items.
// - typeBaselines lookup is over the config map only; the literal type "unknown"
//   is a recognized baseline key (0.50, no diagnostic), while any type absent
//   from the map gets 0.50 plus one UNKNOWN_CONTEXT_TYPE diagnostic per item.
// - No Math.random, no Date.now(); age comes in as metadata.ageTurns, already
//   computed by the Inventory turn index.
// - The final clamped score is snapped to 1e-12 (Math.round(x * 1e12) / 1e12)
//   so IEEE754 summation noise cannot make the spec's worked fixtures compare
//   as 0.9199999999999999 instead of 0.92; the snap is ~9 orders of magnitude
//   below the spec's printed precision and never changes spec arithmetic.

import type { ContextItem, ContextMetadata, ContextType } from "../types/context.ts";
import type { ScoringConfig, ScoreBreakdown } from "../types/scoring.ts";
import { DEFAULT_TYPE_BASELINES } from "../types/scoring.ts";
import { InvalidContextItemError, TokenEstimationError } from "../types/inventory.ts";

// Weight-sum tolerance for "sum to 1.0 within a configured floating-point
// tolerance" (docs/SCORING_SPEC.md).
const WEIGHT_SUM_TOLERANCE = 1e-9;
// Spec-mandated neutral baseline for context types absent from the config map.
const UNKNOWN_TYPE_BASELINE = 0.50;

// ---------------------------------------------------------------------------
// Typed diagnostics (deterministic, ordered with the item batch).
// ---------------------------------------------------------------------------

export interface ScoreDiagnostic {
  code: "UNKNOWN_CONTEXT_TYPE"; // the spec's only baseline diagnostic
  itemId: string; // the item whose type was absent from typeBaselines
  contextType: string; // the unrecognized type value
  fallbackBaseline: number; // the T_i actually used (0.50)
}

// One item's unweighted components, final clamped score, and its diagnostics.
export interface ScoringResult {
  itemId: string;
  breakdown: ScoreBreakdown; // P, R, F, T, C + final clamped score
  diagnostics: ScoreDiagnostic[]; // empty when the type was recognized
}

// Batch result: itemId -> final score, keyed in first-seen input order.
export interface ScoredContextBatch {
  scores: ReadonlyMap<string, number>; // itemId -> clamped score in [0, 1]
  results: ScoringResult[]; // parallel to the input order
  diagnostics: ScoreDiagnostic[]; // all batch diagnostics, in item order
}

// ---------------------------------------------------------------------------
// Scorer-owned typed config error. Distinct from InvalidContextItemError so
// callers can tell "the profile is broken" from "one item is broken".
// ---------------------------------------------------------------------------

export class InvalidScoringConfigError extends Error {
  code: string;
  reason: string; // explicit validation reason code

  constructor(reason: string, message?: string) {
    super(message ?? `Invalid scoring configuration: ${reason}`);
    this.code = "INVALID_SCORING_CONFIG";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

const isFiniteNumber = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value);

const clamp01 = (value: number): number => {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

// Numerically stable per docs/SCORING_SPEC.md ("Use a numerically stable
// implementation and clamp the result to [0,1]"). For exponent < -1024 Math
// would return 0/underflow anyway; the clamp keeps the result total.
const recencyDecay = (ageTurns: number, halfLifeTurns: number): number =>
  clamp01(2 ** (-ageTurns / halfLifeTurns));

// ---------------------------------------------------------------------------
// Default configuration (versioned constants from the spec; profiles override).
// ---------------------------------------------------------------------------

export const DEFAULT_WEIGHTS = {
  priority: 0.30,
  recency: 0.25,
  references: 0.15,
  typeBaseline: 0.20,
  cost: 0.10,
};

const DEFAULT_TYPE_BASELINE_MAP = new Map<string, number>(
  Object.entries(DEFAULT_TYPE_BASELINES),
);

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: DEFAULT_WEIGHTS,
  halfLifeTurns: 10,
  referenceSaturation: 3,
  typeBaselines: DEFAULT_TYPE_BASELINE_MAP,
};

// ---------------------------------------------------------------------------
// Config validation: fails the whole call explicitly, never normalizes.
// ---------------------------------------------------------------------------

function validateScoringConfig(config: ScoringConfig): void {
  const w = config.weights;
  const weights = [w.priority, w.recency, w.references, w.typeBaseline, w.cost];
  const names = ["priority", "recency", "references", "typeBaseline", "cost"];
  for (let i = 0; i < names.length; i = i + 1) {
    if (!isFiniteNumber(weights[i]) || weights[i] < 0) {
      throw new InvalidScoringConfigError(
        `invalid_weight_${names[i]}: must be a finite number >= 0`,
      );
    }
  }
  const sum = weights[0] + weights[1] + weights[2] + weights[3] + weights[4];
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new InvalidScoringConfigError(
      `invalid_weight_sum: weights must sum to 1.0 within ${WEIGHT_SUM_TOLERANCE} (got ${sum})`,
    );
  }
  if (!isFiniteNumber(config.halfLifeTurns) || config.halfLifeTurns <= 0) {
    throw new InvalidScoringConfigError(
      "invalid_half_life: halfLifeTurns must be a finite number > 0",
    );
  }
  if (!isFiniteNumber(config.referenceSaturation) || config.referenceSaturation < 0) {
    throw new InvalidScoringConfigError(
      "invalid_reference_saturation: referenceSaturation must be a finite number >= 0",
    );
  }
  for (const [type, baseline] of config.typeBaselines) {
    if (!isFiniteNumber(baseline) || baseline < 0 || baseline > 1) {
      throw new InvalidScoringConfigError(
        `invalid_type_baseline: baseline for type "${type}" must be a finite number in [0,1]`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Item-level validation (docs "Inputs and normalization").
// ---------------------------------------------------------------------------

function validateScoringInputs(item: ContextItem, workingBudget: number): void {
  const { metadata } = item;
  if (!isFiniteNumber(metadata.ageTurns) || metadata.ageTurns < 0) {
    throw new InvalidContextItemError(item.id, "invalid_age_turns: ageTurns must be a finite number >= 0");
  }
  if (!isFiniteNumber(metadata.references) || metadata.references < 0) {
    throw new InvalidContextItemError(item.id, "invalid_references: references must be a finite number >= 0");
  }
  if (Number.isNaN(item.tokenCount)) {
    throw new TokenEstimationError("missing_token_estimate: item has no token estimate; run the estimator before scoring");
  }
  if (!isFiniteNumber(item.tokenCount) || item.tokenCount < 0) {
    throw new InvalidContextItemError(
      item.id,
      "invalid_token_count: tokenCount must be a finite number >= 0 (estimate before scoring unestimated items)",
    );
  }
  if (!isFiniteNumber(metadata.priority) || metadata.priority < 0 || metadata.priority > 1) {
    throw new InvalidContextItemError(
      item.id,
      "invalid_priority_range: priority must be a finite number in [0,1] (out-of-range is an error, never clamped)",
    );
  }
  if (!isFiniteNumber(workingBudget) || workingBudget <= 0) {
    throw new InvalidContextItemError(
      item.id,
      "invalid_working_budget: workingBudget must be a finite number > 0 (cost is never treated as free)",
    );
  }
}

// ---------------------------------------------------------------------------
// Single-item scoring (docs "Reference implementation pseudocode").
// ---------------------------------------------------------------------------

export function scoreItem(
  item: ContextItem,
  workingBudget: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoringResult {
  validateScoringConfig(config);
  validateScoringInputs(item, workingBudget);

  const diagnostics: ScoreDiagnostic[] = [];
  const configuredBaseline = config.typeBaselines.get(item.type);
  let typeBaseline: number;
  if (configuredBaseline === undefined) {
    typeBaseline = UNKNOWN_TYPE_BASELINE;
    diagnostics.push({
      code: "UNKNOWN_CONTEXT_TYPE",
      itemId: item.id,
      contextType: item.type,
      fallbackBaseline: typeBaseline,
    });
  } else {
    typeBaseline = configuredBaseline;
  }

  const priority = item.metadata.priority;
  const recency = recencyDecay(item.metadata.ageTurns, config.halfLifeTurns);
  const references =
    item.metadata.references / (item.metadata.references + config.referenceSaturation);
  const cost = 1 - Math.min(1, item.tokenCount / workingBudget);

  const weighted =
    config.weights.priority * priority +
    config.weights.recency * recency +
    config.weights.references * references +
    config.weights.typeBaseline * typeBaseline +
    config.weights.cost * cost;

  // Reproducibility snap: kills IEEE754 summation noise (0.9199999999999999 ->
  // 0.92) far below the spec's printed precision so the worked fixtures
  // (0.920 / 0.2725 / ~0.708) compare exactly; never changes spec arithmetic.
  const score = Math.round(clamp01(weighted) * 1e12) / 1e12;
  return {
    itemId: item.id,
    breakdown: {
      priority,
      recency,
      references,
      typeBaseline,
      cost,
      score,
    },
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Batch scoring: itemId -> score map plus typed diagnostics, deterministic.
// ---------------------------------------------------------------------------

export function scoreItems(
  items: readonly ContextItem[],
  workingBudget: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoredContextBatch {
  validateScoringConfig(config);
  if (!isFiniteNumber(workingBudget) || workingBudget <= 0) {
    throw new InvalidContextItemError(
      "",
      "invalid_working_budget: workingBudget must be a finite number > 0 before any item is scored",
    );
  }

  const scores = new Map<string, number>();
  const results: ScoringResult[] = [];
  const diagnostics: ScoreDiagnostic[] = [];
  for (const item of items) {
    if (scores.has(item.id)) {
      throw new InvalidContextItemError(item.id, "duplicate_item_id: batch ids must be unique");
    }
    const result = scoreItem(item, workingBudget, config);
    scores.set(item.id, result.breakdown.score);
    results.push(result);
    for (const diagnostic of result.diagnostics) {
      diagnostics.push(diagnostic);
    }
  }
  return { scores, results, diagnostics };
}

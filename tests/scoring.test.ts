// tests/scoring.test.ts
// Runs via `node --test tests/` (Node 24 native TS type-stripping).
// Contract under test (src/scoring/score.ts + docs/SCORING_SPEC.md "Score range
// and formula", "Inputs and normalization", "Components", "Worked examples" +
// the compiled contracts in src/types/context.ts and src/types/scoring.ts,
// imported unmodified):
//   - worked fixtures: current goal 0.920, old terminal output 0.2725, current
//     test result ~0.708, asserted to the spec's printed precision for identical
//     inputs (identical output; the implementation's 1e-12 snap removes IEEE754
//     summation noise so the fixtures compare exactly)
//   - weights must be finite, non-negative, and sum to 1.0 within a configured
//     tolerance; invalid configuration throws InvalidScoringConfigError with an
//     explicit reason code -- no silent normalization (negative weight, out-of-
//     tolerance sum, non-positive halfLife, negative saturation, out-of-range
//     baseline all rejected; boundary-valid configurations accepted)
//   - R = 2 ^ (-ageTurns / halfLifeTurns): age 0 -> 1.0, one half-life -> 0.5,
//     two half-lives -> 0.25 (exact binary powers for any half-life)
//   - F = references / (references + saturation): 0 -> 0, saturation -> 0.5,
//     saturates strictly below 1 and never reaches it for finite counts
//   - C = 1 - min(1, tokenCount / workingBudget): floored at 0 when the item
//     costs at or above the whole budget; workingBudget must be > 0 (explicit
//     error, cost is never treated as free)
//   - unknown context type -> T = 0.50 plus one UNKNOWN_CONTEXT_TYPE diagnostic
//     (scorer's documented choice: the literal type "unknown" IS a recognized
//     baseline key in DEFAULT_TYPE_BASELINES, so it gets no diagnostic)
//   - item-level validation: priority out of [0,1] -> InvalidContextItemError
//     (never silently clamped), NaN tokenCount -> TokenEstimationError
//   - batch: scores keyed by itemId in first-seen input order; duplicate id ->
//     InvalidContextItemError; config validated before any item is scored;
//     diagnostics ordered with the item batch
//   - determinism: two calls with identical input produce identical scores
//     (deep-equal Maps), identical results, and identical diagnostics
//
// Determinism: no Math.random, no Date.now(); everything is pure arithmetic on
// explicit numbers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_WEIGHTS,
  DEFAULT_SCORING_CONFIG,
  InvalidScoringConfigError,
  scoreItem,
  scoreItems,
} from "../src/scoring/score.ts";
import { InvalidContextItemError, TokenEstimationError } from "../src/types/inventory.ts";
import { DEFAULT_TYPE_BASELINES } from "../src/types/scoring.ts";

import type { ContextItem, ContextMetadata, ContextType } from "../src/types/context.ts";
import type { ScoringConfig, ScoreBreakdown } from "../src/types/scoring.ts";

const BUDGET = 10_000; // workingBudget from the spec's worked examples

// node:assert/strict has no closeTo; tolerance checks are spelled out.
function closeTo(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function makeItem(
  id: string,
  type: ContextType,
  tokenCount: number,
  priority: number,
  ageTurns: number,
  references: number,
): ContextItem {
  return {
    id,
    type,
    content: "content is irrelevant to the score",
    tokenCount,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    state: "ACTIVE",
    revision: 1,
    metadata: {
      priority,
      ageTurns,
      references,
      source: "test-source",
      compressed: false,
      transformed: false,
      pinned: false,
    },
  };
}

// Same shape as DEFAULT_SCORING_CONFIG; used where an explicit config argument
// is wanted (profiles override the defaults per the spec).
function configFor(weights: ScoringConfig["weights"]): ScoringConfig {
  return {
    weights,
    halfLifeTurns: 10,
    referenceSaturation: 3,
    typeBaselines: DEFAULT_SCORING_CONFIG.typeBaselines,
  };
}

function expectThrown(action: () => void): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a thrown error, none thrown");
}

// ---------------------------------------------------------------------------
// Worked fixtures (docs/SCORING_SPEC.md "Worked examples"): identical inputs
// -> identical outputs, asserted at the spec's stated precision.
// ---------------------------------------------------------------------------

test("fixture: current goal (type goal, P 1.00, age 0, refs 3, cost 500) scores 0.920", () => {
  const item = makeItem("goal-current", "goal", 500, 1.0, 0, 3);
  const result = scoreItem(item, BUDGET, DEFAULT_SCORING_CONFIG);
  assert.equal(result.itemId, "goal-current");
  const bd = result.breakdown;
  assert.equal(bd.priority, 1.0);
  assert.equal(bd.recency, 1); // R = 2 ^ 0 = 1
  assert.equal(bd.references, 0.5); // F = 3 / (3 + 3) = 0.5 exactly
  assert.equal(bd.typeBaseline, 1.0); // goal baseline from DEFAULT_TYPE_BASELINES
  assert.ok(closeTo(bd.cost, 0.95, Number.EPSILON)); // C = 1 - 500/10,000 = 0.95
  assert.equal(bd.score, 0.92); // spec S = 0.920 (1e-12 snap makes it exact)
  assert.equal(result.diagnostics.length, 0);

  // Scoring the identical item again yields an identical breakdown and score.
  const again = scoreItem(makeItem("goal-current", "goal", 500, 1.0, 0, 3), BUDGET, DEFAULT_SCORING_CONFIG);
  assert.deepEqual(again.breakdown, bd);
  assert.equal(again.breakdown.score, bd.score);
});

test("fixture: old terminal output (P 0.20, age 20, refs 0, cost 2000) scores 0.2725", () => {
  const item = makeItem("term-old", "terminal_output", 2000, 0.2, 20, 0);
  const result = scoreItem(item, BUDGET);
  assert.equal(result.itemId, "term-old");
  const bd = result.breakdown;
  assert.equal(bd.priority, 0.2);
  assert.equal(bd.recency, 0.25); // R = 2 ^ (-20 / 10) = 0.25 exactly
  assert.equal(bd.references, 0); // F = 0 / (0 + 3) = 0
  assert.equal(bd.typeBaseline, 0.35); // terminal_output baseline
  assert.ok(closeTo(bd.cost, 0.8, Number.EPSILON)); // C = 1 - 2,000/10,000 = 0.80
  assert.equal(bd.score, 0.2725); // spec S = 0.2725 exactly
  assert.equal(result.diagnostics.length, 0);

  // Identical inputs through scoreItems give the identical score in the map.
  const batch = scoreItems([makeItem("term-old", "terminal_output", 2000, 0.2, 20, 0)], BUDGET);
  assert.equal(batch.scores.get("term-old"), 0.2725);
});

test("fixture: current test result (P 0.70, age 2, refs 2, cost 1000) scores ~0.708", () => {
  const item = makeItem("test-current", "test_result", 1000, 0.7, 2, 2);
  const result = scoreItem(item, BUDGET, DEFAULT_SCORING_CONFIG);
  const bd = result.breakdown;
  assert.equal(bd.priority, 0.7);
  assert.ok(closeTo(bd.recency, 0.8706, 1e-4)); // spec R = 2 ^ (-2/10) ~= 0.8706
  assert.equal(bd.references, 2 / 5); // F = 2 / (2 + 3) = 0.4
  assert.equal(bd.typeBaseline, 0.65); // test_result baseline
  assert.ok(closeTo(bd.cost, 0.9, Number.EPSILON)); // C = 1 - 1,000/10,000 = 0.90
  assert.ok(closeTo(bd.score, 0.708, 1e-3)); // spec S ~= 0.708 (printed to 3 dp)
  assert.equal(result.diagnostics.length, 0);

  // Reproducibility for identical inputs: exact bitwise equality across calls.
  const again = scoreItem(makeItem("test-current", "test_result", 1000, 0.7, 2, 2), BUDGET, DEFAULT_SCORING_CONFIG);
  assert.equal(again.breakdown.score, bd.score);
});

// ---------------------------------------------------------------------------
// Configuration: weights are finite/non-negative/sum-to-1 within tolerance;
// invalid config fails explicitly (InvalidScoringConfigError), it is never
// silently normalized or clamped.
// ---------------------------------------------------------------------------

test("config: DEFAULT_WEIGHTS and DEFAULT_SCORING_CONFIG match the spec constants", () => {
  assert.equal(DEFAULT_WEIGHTS.priority, 0.3);
  assert.equal(DEFAULT_WEIGHTS.recency, 0.25);
  assert.equal(DEFAULT_WEIGHTS.references, 0.15);
  assert.equal(DEFAULT_WEIGHTS.typeBaseline, 0.2);
  assert.equal(DEFAULT_WEIGHTS.cost, 0.1);
  // The raw IEEE754 sum is 1.0000000000000002; the scorer accepts it because it
  // is within the configured 1e-9 weight-sum tolerance, without normalizing.
  const defaultWeightSum = DEFAULT_WEIGHTS.priority + DEFAULT_WEIGHTS.recency + DEFAULT_WEIGHTS.references + DEFAULT_WEIGHTS.typeBaseline + DEFAULT_WEIGHTS.cost;
  assert.ok(closeTo(defaultWeightSum, 1, 1e-9));
  assert.equal(DEFAULT_SCORING_CONFIG.halfLifeTurns, 10);
  assert.equal(DEFAULT_SCORING_CONFIG.referenceSaturation, 3);
  assert.equal(DEFAULT_SCORING_CONFIG.typeBaselines.get("goal"), DEFAULT_TYPE_BASELINES.goal);
  assert.equal(DEFAULT_SCORING_CONFIG.typeBaselines.get("terminal_output"), DEFAULT_TYPE_BASELINES.terminal_output);
});

test("config: custom weights summing to 1.0 are accepted and used as-is", () => {
  const weights = { priority: 0.5, recency: 0.25, references: 0.15, typeBaseline: 0.05, cost: 0.05 };
  const profile = configFor(weights);
  const item = makeItem("cfg-1", "goal", 0, 1.0, 0, 3);
  const result = scoreItem(item, BUDGET, profile);
  // Components are P = 1, R = 1, F = 0.5, T = 1, C = 1, so the raw weighted
  // sum must be 0.925: acceptance proves the weights were used verbatim.
  assert.equal(result.breakdown.score, 0.925);
});

test("config: sum drift within the 1e-9 tolerance accepted, drift kept (no renormalization)", () => {
  const weights = { priority: 0.3, recency: 0.25, references: 0.15, typeBaseline: 0.2, cost: 0.1 + 1e-10 };
  const result = scoreItem(makeItem("cfg-2", "goal", 0, 1.0, 0, 3), BUDGET, configFor(weights));
  assert.equal(result.diagnostics.length, 0);
  // Accepted near-1 sum (1 + 1e-10): the drift is kept, not normalized away.
  assert.equal(result.breakdown.score, 0.9250000001);
});

test("config: sum outside the tolerance -> invalid_weight_sum, not normalized", () => {
  const weights = { priority: 0.4, recency: 0.25, references: 0.15, typeBaseline: 0.2, cost: 0.1 };
  const err = expectThrown(() => {
    scoreItem(makeItem("cfg-bad", "goal", 100, 0.5, 0, 0), BUDGET, configFor(weights));
  });
  assert.ok(err instanceof InvalidScoringConfigError);
  const asErr = err as InvalidScoringConfigError;
  assert.equal(asErr.code, "INVALID_SCORING_CONFIG");
  assert.ok(asErr.reason.startsWith("invalid_weight_sum:"));
});

test("config: negative weight -> invalid_weight_recency (never clamped to 0)", () => {
  const weights = { priority: 0.3, recency: -0.1, references: 0.35, typeBaseline: 0.2, cost: 0.25 };
  const err = expectThrown(() => {
    scoreItem(makeItem("cfg-neg", "goal", 100, 0.5, 0, 0), BUDGET, configFor(weights));
  });
  assert.ok(err instanceof InvalidScoringConfigError);
  const asErr = err as InvalidScoringConfigError;
  assert.equal(asErr.code, "INVALID_SCORING_CONFIG");
  assert.ok(asErr.reason.startsWith("invalid_weight_recency:"));
});

test("config: halfLifeTurns must be finite > 0 (zero and negative both rejected)", () => {
  for (const halfLife of [0, -5]) {
    const err = expectThrown(() => {
      const item = makeItem("cfg-hl", "goal", 100, 0.5, 0, 0);
      scoreItem(item, BUDGET, { weights: DEFAULT_WEIGHTS, halfLifeTurns: halfLife, referenceSaturation: 3, typeBaselines: DEFAULT_SCORING_CONFIG.typeBaselines });
    });
    assert.ok(err instanceof InvalidScoringConfigError);
    const asErr = err as InvalidScoringConfigError;
    assert.equal(asErr.code, "INVALID_SCORING_CONFIG");
    assert.ok(asErr.reason.startsWith("invalid_half_life:"));
  }
});

test("config: referenceSaturation >= 0 accepted (0 makes F jump to 1 at refs 1); negative rejected", () => {
  const zeroSat = { weights: DEFAULT_WEIGHTS, halfLifeTurns: 10, referenceSaturation: 0, typeBaselines: DEFAULT_SCORING_CONFIG.typeBaselines };
  const accepted = scoreItem(makeItem("cfg-sat", "goal", 100, 0.5, 1, 4), BUDGET, zeroSat);
  assert.equal(accepted.breakdown.references, 1); // 4 / (4 + 0) = 1
  const err = expectThrown(() => {
    scoreItem(makeItem("cfg-sat-bad", "goal", 100, 0.5, 0, 0), BUDGET, { weights: DEFAULT_WEIGHTS, halfLifeTurns: 10, referenceSaturation: -1, typeBaselines: DEFAULT_SCORING_CONFIG.typeBaselines });
  });
  assert.ok(err instanceof InvalidScoringConfigError);
  const asErr = err as InvalidScoringConfigError;
  assert.equal(asErr.code, "INVALID_SCORING_CONFIG");
  assert.ok(asErr.reason.startsWith("invalid_reference_saturation:"));
});

test("config: type baseline outside [0,1] -> invalid_type_baseline", () => {
  const baselines = new Map<string, number>([...DEFAULT_SCORING_CONFIG.typeBaselines, ["goal", 1.5]]);
  const err = expectThrown(() => {
    scoreItem(makeItem("cfg-base", "goal", 100, 0.5, 0, 0), BUDGET, { weights: DEFAULT_WEIGHTS, halfLifeTurns: 10, referenceSaturation: 3, typeBaselines: baselines });
  });
  assert.ok(err instanceof InvalidScoringConfigError);
  const asErr = err as InvalidScoringConfigError;
  assert.equal(asErr.code, "INVALID_SCORING_CONFIG");
  assert.ok(asErr.reason.startsWith("invalid_type_baseline:"));
});

// ---------------------------------------------------------------------------
// Component curves: R (age 0 and half-life boundaries), F saturation, C floor.
// ---------------------------------------------------------------------------

test("recency: R = 1 at age 0; exactly 0.5 and 0.25 at one/two half-lives for any half-life", () => {
  for (const halfLife of [1, 4, 10, 250]) {
    const profile = { weights: DEFAULT_WEIGHTS, halfLifeTurns: halfLife, referenceSaturation: 3, typeBaselines: DEFAULT_SCORING_CONFIG.typeBaselines };
    const zero = scoreItem(makeItem("age-0", "goal", 0, 0, 0, 0), BUDGET, profile);
    assert.equal(zero.breakdown.recency, 1); // 2 ^ (-0 / hl) = 1
    const one = scoreItem(makeItem("age-1hl", "goal", 0, 0, halfLife, 0), BUDGET, profile);
    assert.equal(one.breakdown.recency, 0.5); // 2 ^ -1 exactly
    const two = scoreItem(makeItem("age-2hl", "goal", 0, 0, 2 * halfLife, 0), BUDGET, profile);
    assert.equal(two.breakdown.recency, 0.25); // 2 ^ -2 exactly
  }
});

test("recency: default half-life 10 reproduces the spec examples age 10 -> 0.5, age 20 -> 0.25", () => {
  const atHalf = scoreItem(makeItem("r-half", "goal", 0, 0, 10, 0), BUDGET).breakdown.recency;
  assert.equal(atHalf, 0.5);
  const atDouble = scoreItem(makeItem("r-double", "goal", 0, 0, 20, 0), BUDGET).breakdown.recency;
  assert.equal(atDouble, 0.25);
});

test("references: F saturates (refs 0 -> 0, refs = saturation -> 0.5, large -> < 1 but never 1)", () => {
  const none = scoreItem(makeItem("f-0", "goal", 0, 0, 0, 0), BUDGET).breakdown.references;
  assert.equal(none, 0); // 0 / (0 + 3) = 0
  const half = scoreItem(makeItem("f-half", "goal", 0, 0, 0, 3), BUDGET).breakdown.references;
  assert.equal(half, 0.5); // 3 / (3 + 3) = 0.5
  const huge = scoreItem(makeItem("f-huge", "goal", 0, 0, 0, 1000000), BUDGET).breakdown.references;
  assert.ok(huge > 0.99 && huge < 1); // saturates strictly below 1 for finite counts
});

test("cost: C floored at 0 when tokenCount is at or above the whole budget", () => {
  const atBudget = scoreItem(makeItem("c-at", "task", BUDGET, 0.5, 0, 0), BUDGET);
  assert.equal(atBudget.breakdown.cost, 0); // min(1, 10000/10000) = 1 -> C = 0
  const overBudget = scoreItem(makeItem("c-over", "task", 4 * BUDGET, 0.5, 0, 0), BUDGET);
  assert.equal(overBudget.breakdown.cost, 0); // floored, never negative
});

test("cost: workingBudget must be > 0 or scoring fails explicitly (cost never treated as free)", () => {
  const item = makeItem("c-budget", "task", 500, 0.5, 0, 0);
  for (const badBudget of [0, -100]) {
    const err = expectThrown(() => {
      scoreItem(item, badBudget);
    });
    assert.ok(err instanceof InvalidContextItemError);
    const asErr = err as InvalidContextItemError;
    assert.equal(asErr.code, "INVALID_CONTEXT_ITEM");
    assert.equal(asErr.itemId, "c-budget");
    assert.ok(asErr.reason.startsWith("invalid_working_budget:"));
  }
  // scoreItems validates the budget before any item is scored (batch-level id "").
  const batchErr = expectThrown(() => {
    scoreItems([item], 0);
  });
  assert.ok(batchErr instanceof InvalidContextItemError);
  const asBatch = batchErr as InvalidContextItemError;
  assert.equal(asBatch.code, "INVALID_CONTEXT_ITEM");
  assert.equal(asBatch.itemId, "");
  assert.ok(asBatch.reason.startsWith("invalid_working_budget:"));
});

// ---------------------------------------------------------------------------
// Unknown context type: T = 0.50 + UNKNOWN_CONTEXT_TYPE diagnostic; the
// literal type "unknown" is a recognized baseline key (no diagnostic).
// ---------------------------------------------------------------------------

test("unknown type: absent from typeBaselines -> T = 0.50 and one UNKNOWN_CONTEXT_TYPE diagnostic", () => {
  const result = scoreItem(makeItem("mystery-1", "quantum_crystal", 0, 0, 0, 0), BUDGET);
  assert.equal(result.breakdown.typeBaseline, 0.5);
  assert.equal(result.diagnostics.length, 1);
  const diag = result.diagnostics[0];
  assert.equal(diag.code, "UNKNOWN_CONTEXT_TYPE");
  assert.equal(diag.itemId, "mystery-1");
  assert.equal(diag.contextType, "quantum_crystal");
  assert.equal(diag.fallbackBaseline, 0.5);
});

test("type \"unknown\": literal key IS in DEFAULT_TYPE_BASELINES, so 0.50 without a diagnostic", () => {
  const result = scoreItem(makeItem("lit-unknown", "unknown", 0, 0, 0, 0), BUDGET);
  assert.equal(result.breakdown.typeBaseline, 0.5);
  assert.equal(result.diagnostics.length, 0);
});

test("item validation: priority outside [0,1] -> InvalidContextItemError (never silently clamped)", () => {
  const err = expectThrown(() => {
    scoreItem(makeItem("p-high", "goal", 100, 1.5, 0, 0), BUDGET);
  });
  assert.ok(err instanceof InvalidContextItemError);
  const asErr = err as InvalidContextItemError;
  assert.equal(asErr.code, "INVALID_CONTEXT_ITEM");
  assert.equal(asErr.itemId, "p-high");
  assert.ok(asErr.reason.startsWith("invalid_priority_range:"));
});

test("item validation: NaN tokenCount -> TokenEstimationError (run the estimator first)", () => {
  const err = expectThrown(() => {
    scoreItem(makeItem("no-est", "file", Number.NaN, 0.5, 0, 0), BUDGET);
  });
  assert.ok(err instanceof TokenEstimationError);
  const asErr = err as TokenEstimationError;
  assert.ok(asErr.reason.startsWith("missing_token_estimate:"));
});

// ---------------------------------------------------------------------------
// Batches: first-seen input order, duplicate ids rejected, config validated
// before any item is scored, diagnostics ordered with the batch.
// ---------------------------------------------------------------------------

test("batch: scores keyed by itemId in first-seen order; results parallel to the input", () => {
  const batch = scoreItems(
    [
      makeItem("b-goal", "goal", 500, 1.0, 0, 3),
      makeItem("b-term", "terminal_output", 2000, 0.2, 20, 0),
    ],
    BUDGET,
  );
  const keys: string[] = [];
  for (const key of batch.scores.keys()) {
    keys.push(key);
  }
  assert.deepEqual(keys, ["b-goal", "b-term"]);
  assert.equal(batch.scores.get("b-goal"), 0.92);
  assert.equal(batch.scores.get("b-term"), 0.2725);
  assert.deepEqual(batch.results.map((r) => r.itemId), ["b-goal", "b-term"]);
  assert.equal(batch.diagnostics.length, 0);
});

test("batch: duplicate item id -> InvalidContextItemError duplicate_item_id", () => {
  const err = expectThrown(() => {
    scoreItems([makeItem("dup-1", "goal", 10, 0.5, 0, 0), makeItem("dup-1", "task", 20, 0.5, 0, 0)], BUDGET);
  });
  assert.ok(err instanceof InvalidContextItemError);
  const asErr = err as InvalidContextItemError;
  assert.equal(asErr.code, "INVALID_CONTEXT_ITEM");
  assert.equal(asErr.itemId, "dup-1");
  assert.ok(asErr.reason.startsWith("duplicate_item_id:"));
});

test("batch: invalid config fails the whole call before any item is scored", () => {
  const weights = { priority: 0.4, recency: 0.25, references: 0.15, typeBaseline: 0.2, cost: 0.1 };
  const err = expectThrown(() => {
    scoreItems([makeItem("never-scored", "goal", 100, 0.5, 0, 0)], BUDGET, configFor(weights));
  });
  assert.ok(err instanceof InvalidScoringConfigError);
  assert.equal((err as InvalidScoringConfigError).code, "INVALID_SCORING_CONFIG");
});

test("batch: diagnostics ordered with the item batch (one UNKNOWN_CONTEXT_TYPE per unknown item)", () => {
  const batch = scoreItems(
    [
      makeItem("u-1", "zzz_alpha", 0, 0, 0, 0),
      makeItem("u-2", "goal", 0, 0, 0, 0),
      makeItem("u-3", "zzz_beta", 0, 0, 0, 0),
    ],
    BUDGET,
  );
  assert.equal(batch.diagnostics.length, 2);
  assert.deepEqual(
    batch.diagnostics.map((d) => `${d.itemId}:${d.contextType}`),
    ["u-1:zzz_alpha", "u-3:zzz_beta"],
  );
});

// ---------------------------------------------------------------------------
// Determinism property: two calls with identical input produce identical maps
// (and identical results/diagnostics). No clock, no randomness: scoring is
// pure arithmetic on explicit numbers.
// ---------------------------------------------------------------------------

test("determinism: two scoreItems calls on identical input yield deep-equal score maps", () => {
  const items = [
    makeItem("d-goal", "goal", 500, 1.0, 0, 3),
    makeItem("d-term", "terminal_output", 2000, 0.2, 20, 0),
    makeItem("d-test", "test_result", 1000, 0.7, 2, 2),
  ];
  const first = scoreItems(items, BUDGET);
  const second = scoreItems(
    [
      makeItem("d-goal", "goal", 500, 1.0, 0, 3),
      makeItem("d-term", "terminal_output", 2000, 0.2, 20, 0),
      makeItem("d-test", "test_result", 1000, 0.7, 2, 2),
    ],
    BUDGET,
    DEFAULT_SCORING_CONFIG,
  );
  assert.deepEqual(first.scores, second.scores); // identical Maps (values included)
  assert.deepEqual(first.results, second.results);
  assert.deepEqual(first.diagnostics, second.diagnostics);

  // Single-item calls are stable too, including the fixture values.
  assert.equal(scoreItem(items[0], BUDGET).breakdown.score, first.scores.get("d-goal"));
  assert.equal(first.scores.get("d-goal"), 0.92);
  assert.equal(first.scores.get("d-term"), 0.2725);
});

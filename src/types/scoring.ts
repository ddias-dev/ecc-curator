// ECC Curator — scoring contracts.
// Source of truth: docs/SCORING_SPEC.md.
// Erasable TypeScript only (Node 24 type-stripping): interfaces, Record types, no enums.
//
// Deterministic heuristic score (docs/SCORING_SPEC.md, "Score range and formula"):
//
//   score = clamp(0, 1,
//     0.30 * P + 0.25 * R + 0.15 * F + 0.20 * T + 0.10 * C)
//
// Components (all finite numbers in [0, 1]):
//   P = metadata.priority, validated in [0, 1]; out-of-range is an error, never silently clamped.
//   R = 2 ^ (-ageTurns / halfLifeTurns)                    // recency decay; halfLifeTurns > 0, default 10; clamp to [0,1].
//   F = references / (references + referenceSaturation)    // saturating reference boost; default saturation 3.
//   T = typeBaselines[type] ?? 0.50                        // context-type baseline; unknown type -> 0.50 + UNKNOWN_CONTEXT_TYPE diagnostic.
//   C = 1 - min(1, tokenCount / workingBudget)             // cost affordability; requires workingBudget > 0 (explicit error otherwise).
//
// Default weights { priority: 0.30, recency: 0.25, references: 0.15, typeBaseline: 0.20, cost: 0.10 } sum to 1.00.
// Weight validation (finite, non-negative, sum to 1.0 within floating-point tolerance; invalid configuration
// fails explicitly instead of silently normalizing) lives in the scorer (src/scoring/score.ts, Sprint 3),
// NOT in these type contracts.

export interface ScoringConfig {
  weights: {
    // Default weights per docs/SCORING_SPEC.md; must sum to 1.0 (validated by the scorer).
    priority: number; // default 0.30
    recency: number; // default 0.25
    references: number; // default 0.15
    typeBaseline: number; // default 0.20
    cost: number; // default 0.10
  };
  halfLifeTurns: number; // recency half-life in turns; must be > 0; default 10
  referenceSaturation: number; // reference-boost saturation constant; default 3
  typeBaselines: ReadonlyMap<string, number>; // context type -> T_i; defaults from DEFAULT_TYPE_BASELINES
}

// Per-component values for one scored item (the unweighted P, R, F, T, C) plus the
// final weighted, clamped score. Each value is a finite number in [0, 1].
export interface ScoreBreakdown {
  priority: number; // P
  recency: number; // R
  references: number; // F
  typeBaseline: number; // T
  cost: number; // C
  score: number; // clamp(0, 1, 0.30*P + 0.25*R + 0.15*F + 0.20*T + 0.10*C) with default weights
}

// Default context-type baselines (docs/SCORING_SPEC.md, "Context-type baseline T_i").
// Explicit reproducibility defaults, not empirically validated importance labels; profiles may override.
// Unknown context types fall back to `unknown` (0.50) and emit an UNKNOWN_CONTEXT_TYPE diagnostic.
export const DEFAULT_TYPE_BASELINES: Readonly<Record<string, number>> = {
  goal: 1.0,
  task: 0.95,
  file: 0.8,
  diff: 0.8,
  memory: 0.75,
  test_result: 0.65,
  plan: 0.6,
  retrieved_content: 0.55,
  tool_output: 0.4,
  terminal_output: 0.35,
  unknown: 0.5,
};

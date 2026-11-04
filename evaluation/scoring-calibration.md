# Scoring Calibration — Measurement, Not Redesign (Priority 6)

Evidence base: the 15 real sessions in `datasets/real-sessions/` (2,430 items after
capture capping), scored through the EXISTING scorer (`src/scoring/score.ts`,
`DEFAULT_SCORING_CONFIG`) at the adapter-default working budget 30,208 tokens.
Raw data: `evaluation/scoring-calibration-stats.json`, produced by
`evaluation/scoring-calibration.mjs`. No scoring code was changed.

## Current constants (as shipped)

| Constant | Value | Where |
| --- | --- | --- |
| weights | priority 0.30, recency 0.25, references 0.15, typeBaseline 0.20, cost 0.10 | `DEFAULT_WEIGHTS` |
| halfLifeTurns | 10 | `DEFAULT_SCORING_CONFIG` |
| referenceSaturation | 3 | `DEFAULT_SCORING_CONFIG` |
| decision boundary used here | score ≥ 0.35 (`retainAtOrAbove`) separates DROP from (KEEP or middle-band) | `adapter.ts createPolicies` |

## Observed behaviour

Per-feature distributions over the 2,430 real items (quantiles 5/25/50/75/95):

| Feature | 5% | 25% | 50% | 75% | 95% | mean |
| --- | --- | --- | --- | --- | --- | --- |
| P (priority) | 0.35 | 0.50 | 0.80 | 0.80 | 0.80 | 0.634 |
| R (recency) | 3.99e-9 | 1.16e-5 | 0.0017 | 0.0947 | 0.6156 | 0.103 |
| F (references) | 0 | 0 | 0 | 0 | 0.625 | 0.087 |
| T (typeBaseline) | 0.35 | 0.50 | 0.80 | 0.80 | 0.80 | 0.634 |
| C (cost) | 0.976 | 0.978 | 0.993 | 0.998 | 0.999 | 0.989 |
| score | 0.275 | 0.350 | 0.498 | 0.521 | 0.618 | 0.454 |

Notes that the raw numbers force us to state:

- **P ≡ T identically.** The capture never sets metadata priority, so P falls back to
  the type baseline. Any sensitivity of P is therefore unmeasurable on this dataset;
  only the type baseline T is real here.
- **Recency is nearly dead at halfLifeTurns=10.** Median R = 0.0017; 61 compaction
  events across 15 sessions mean real item ages run in the tens-to-hundreds of turns.
  Items older than ~5 half-lives carry no recency signal at all.
- **References: 95% of items have F = 0.** Only the 95th-percentile band (0.625) is
  non-zero. `referenceSaturation` 1→6 changes **zero** decisions: the knob is
  unmeasurable at this density; the sparse high-F items dominate its weight's
  effect (removing the weight flips 471/2430 ≈ 19%).
- **Cost is a near-constant ≈ 0.99** for every item: all captured items are small
  relative to the 30,208-token working budget, so C adds ~0.099 to everyone and
  discriminates nothing. Removing it still "flips" 331 items — but that is the
  weight-rescaling artefact, not signal the cost feature was carrying.
- **Type baselines are the dominant real lever.** keptShare by type: file/diff/
  retrieved_content/test_result = 1.00; tool_output = 0.233, terminal_output = 0.160.
  Half of item type is decided deterministically by T alone; removing T flips only
  217 (9%).
- **Median score 0.498 sits inside the middle band [0.35, 0.65)** — the bulk of items
  are in the escalation-substituted band (this is the same fact the ambiguity
  instrument reports: ambiguity rate 0.73).

Decision flips when one constant changes (out of 2,430 items; ablation redistributes
the removed weight proportionally to avoid a scale artefact):

| Variant | flips | % |
| --- | --- | --- |
| recency_weight → 0 | 615 | 25.3 |
| references_weight → 0 | 471 | 19.4 |
| cost_weight → 0 | 331 | 13.6 |
| priority_weight → 0 | 264 | 10.9 |
| typeBaseline_weight → 0 | 217 | 9.0 |
| halfLifeTurns 10 → 5 | 146 | 6.0 |
| halfLifeTurns 10 → 20 | 202 | 8.3 |
| referenceSaturation 3 → 1 / 3 → 6 | 0 | 0.0 |

Caveat stated honestly: weight-zero ablation rescales the survivors by 1/(1−w), so
flip counts for low-weight features (cost 0.10, typeBaseline 0.20) partly measure the
rescaling, not feature usefulness. The only clean readings are the halfLife variants
(scale-preserving) and the referenceSaturation null result.

## Token-estimator error

Two estimators were compared against actual prompt-side growth (sum of POSITIVE
turn-to-turn deltas of reported `input + cache_read + cache_creation`; negative
deltas are harness compactions — first→last alone is meaningless and was
measured this way deliberately):

| Basis | 25% | 50% | 75% | min–max |
| --- | --- | --- | --- | --- |
| estTokensKept (1,500-char-truncated items) / actual growth | 0.555 | 0.625 | 0.869 | 0.436–1.211 |
| estTokensFull (untruncated) / actual growth | 2.12 | 3.53 | 8.49 | 1.64–12.57 |

Reading: the char-based estimator is **within a factor ~2 of the true prompt-side
cost**, not off by orders of magnitude. Both directions appear (0.44 underestimate to
1.21 overestimate), confounded by three dataset-side gaps that the same table shows:
the 300-item capture cap (estKept < actual in the low ratios), truncation of large
tool results (estFull over-counts by 2–12×), and assistant-text items that live on
the output side but are counted as content. The 61 compaction events across the
sample also mean any "context keeps growing" assumption is false in real sessions:
the harness already rewrites the prompt 25 times in the longest session.

## Recommended changes — evidence-backed only

1. **halfLifeTurns 10 → session-scaled (e.g. proportional to observed session
   length).** Evidence: median R = 0.0017 vs 0.616 at the 95th percentile means the
   feature is dead for ~most items while it is at full strength for the newest 5%;
   doubling halfLife flips 8.3% of decisions. The one constant whose sensitivity was
   measured without an ablation artefact is the one the data most clearly says is
   mis-scaled for long-running sessions.
2. **Do NOT change referenceSaturation.** Evidence: 3→1 and 3→6 both flip zero
   decisions; at 95% F=0 the knob cannot currently be calibrated at all.
3. **Do NOT change weights yet.** Every weight-ablation confound is the rescaling
   artefact above; with P≡T on this dataset, priority weight is unmeasurable. A
   failing-workload run (Priority 5) must supply the counterfactual before any
   weight change is justified.
4. **Do NOT re-tune the token estimator constants.** Observed per-session ratios are
   already within ×2; the remaining error is dataset capture mechanics, not the
   estimator formula.
5. **Cost feature: flag as candidate for removal ONLY after a workload where item
   size approaches the budget** — current evidence (C∈[0.976, 0.999] for every item)
   shows it carries no signal at current budgets, but that is an argument about the
   feature's range, not yet about its replacement.

All of the above are proposals pending Priority-5 counterfactual runs; none has been
applied to code.

## Supporting data

- `evaluation/scoring-calibration-stats.json` — per-session estimator rows,
  feature quantiles/means, per-type kept shares and median scores, flip counts per
  variant, config snapshot.
- `evaluation/ambiguity-report.json` — 2,430 per-item decision records the score
  distributions explain (0.7313 in the middle band, 0 rule-resolved, 653
  budget-overflow downgrades).

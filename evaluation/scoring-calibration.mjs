// ECC Curator - scoring calibration measurement (Priority 6: measure, do not redesign).
//
// Measures the EXISTING scorer (src/scoring/score.ts DEFAULT_SCORING_CONFIG) over the
// REAL captured sessions (datasets/real-sessions), reporting:
//   - per-feature contribution distributions (P, R, F, T, C and final score)
//   - decision sensitivity per constant (how many KEEP/DROP decisions flip when one
//     constant changes - the evidence basis for any recommended change)
//   - token-estimator error vs actual prompt-side growth reported by the transcripts
//     (datasets/real-sessions manifest usagePerTurn)
// No re-design, no new constants proposed beyond sensitivity data; the markdown
// summary (evaluation/scoring-calibration.md) is written from this JSON.
// Usage: node evaluation/scoring-calibration.mjs

import { ingestContext } from "../src/pipeline/run.ts";
import { scoreItems, DEFAULT_SCORING_CONFIG, DEFAULT_WEIGHTS } from "../src/scoring/score.ts";
import { defaultTokenEstimator } from "../src/token-estimator.ts";

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATASET_DIR = "datasets/real-sessions";
const STATS_OUT = "evaluation/scoring-calibration-stats.json";

// Same working budget as ambiguity-instrument (adapter defaults): 32_768
// - (committed 0 + output reserve 2_048 + safety margin 512).
const workingBudget = 32_768 - 2_048 - 512;

function quantiles(values, probs) {
  const sorted = [...values].sort((a, b) => a - b);
  return probs.map((p) => {
    const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
    return sorted[idx];
  });
}

async function main() {
  const entries = (await readdir(DATASET_DIR)).filter((n) => n !== "manifest.json");
  entries.sort();

  const breakdown = { P: [], R: [], F: [], T: [], C: [], score: [] };
  const estKeptBySession = new Map(); // sessionId -> sum of estTokensKept over captured (truncated) items
  const perType = {};
  const boundary = 0.35; // governance retainAtOrAbove (deterministic MVP decision boundary: score >= 0.35 -> KEEP)

  const itemsPerSession = [];
  for (const sessionId of entries) {
    const document = JSON.parse(await readFile(join(DATASET_DIR, sessionId, "items.json"), "utf8"));
    const items = document.items;
    const refCount = new Map();
    for (const item of items) {
      const ref = item.pathRef ?? "";
      if (ref === "") continue;
      refCount.set(ref, (refCount.get(ref) ?? 0) + 1);
    }
    const estKeptTotalSession = items.reduce((sum, item) => sum + (item.estTokensKept ?? 0), 0);
    estKeptBySession.set(sessionId, estKeptTotalSession);
    const newItems = items.map((item) => ({
      id: item.id,
      type: item.type ?? "unknown",
      content: item.content,
      tokenCount: item.estTokensKept,
      metadata: {
        source: item.source,
        ageTurns: item.ageTurns,
        references: item.pathRef ? (refCount.get(item.pathRef) ?? 1) - 1 : 0,
      },
    }));
    const inventory = ingestContext(newItems, { estimator: defaultTokenEstimator });
    itemsPerSession.push({ sessionId, inventory });
  }

  // ScoringConfig invariant: weights must sum to 1.0. Removing a feature's
  // weight redistributes it proportionally to the others (the fairest
  // ablation; the alternative — just dropping the weight — changes the scale
  // of every score and would confound the sensitivity measurement).
  function weightVariant(dropKey) {
    const kept = Object.keys(DEFAULT_WEIGHTS).filter((k) => k !== dropKey);
    const keptSum = kept.reduce((sum, k) => sum + DEFAULT_WEIGHTS[k], 0);
    const weights = Object.fromEntries(kept.map((k) => [k, DEFAULT_WEIGHTS[k] / keptSum]));
    weights[dropKey] = 0;
    const residual = 1 - Object.keys(weights).reduce((sum, k) => sum + weights[k], 0);
    weights[kept[0]] += residual; // keep the sum exactly 1
    return weights;
  }
  const variantConfigs = [
    { label: "baseline", config: DEFAULT_SCORING_CONFIG },
    { label: "recency_weight_0", config: { ...DEFAULT_SCORING_CONFIG, weights: weightVariant("recency") } },
    { label: "references_weight_0", config: { ...DEFAULT_SCORING_CONFIG, weights: weightVariant("references") } },
    { label: "cost_weight_0", config: { ...DEFAULT_SCORING_CONFIG, weights: weightVariant("cost") } },
    { label: "priority_weight_0", config: { ...DEFAULT_SCORING_CONFIG, weights: weightVariant("priority") } },
    { label: "typeBaseline_weight_0", config: { ...DEFAULT_SCORING_CONFIG, weights: weightVariant("typeBaseline") } },
    { label: "halfLife_5", config: { ...DEFAULT_SCORING_CONFIG, halfLifeTurns: 5 } },
    { label: "halfLife_20", config: { ...DEFAULT_SCORING_CONFIG, halfLifeTurns: 20 } },
    { label: "refSat_1", config: { ...DEFAULT_SCORING_CONFIG, referenceSaturation: 1 } },
    { label: "refSat_6", config: { ...DEFAULT_SCORING_CONFIG, referenceSaturation: 6 } },
  ];

  const actionsByVariant = {};
  for (const variant of variantConfigs) {
    const actions = [];
    for (const { inventory } of itemsPerSession) {
      const batch = scoreItems(inventory.items, workingBudget, variant.config);
      for (const result of batch.results) {
        actions.push(result.breakdown.score >= boundary ? "KEEP" : "DROP");
        if (variant.label === "baseline") {
          const b = result.breakdown;
          breakdown.P.push(b.priority);
          breakdown.R.push(b.recency);
          breakdown.F.push(b.references);
          breakdown.T.push(b.typeBaseline);
          breakdown.C.push(b.cost);
          breakdown.score.push(b.score);
          const typeKey = inventory.items.find((item) => item.id === result.itemId)?.type ?? "unknown";
          const bucket = perType[typeKey] ?? { n: 0, kept: 0, scores: [] };
          bucket.n += 1;
          if (actions[actions.length - 1] === "KEEP") bucket.kept += 1;
          bucket.scores.push(b.score);
          perType[typeKey] = bucket;
        }
      }
    }
    actionsByVariant[variant.label] = actions;
  }

  let diagnosticCount = 0;
  for (const { inventory } of itemsPerSession) {
    const batch = scoreItems(inventory.items, workingBudget, DEFAULT_SCORING_CONFIG);
    diagnosticCount += batch.diagnostics.length;
  }

  const baselineActions = actionsByVariant.baseline;
  const flips = {};
  for (const [label, actions] of Object.entries(actionsByVariant)) {
    if (label === "baseline") continue;
    let diff = 0;
    for (let i = 0; i < actions.length; i += 1) {
      if (actions[i] !== baselineActions[i]) diff += 1;
    }
    flips[label] = diff;
  }

  // estimator error: estimated item content tokens vs reported prompt-side growth
  const manifest = JSON.parse(await readFile(join(DATASET_DIR, "manifest.json"), "utf8"));
  const estimatorRows = [];
  for (const sessionRecord of manifest.sessions) {
    if (sessionRecord.skipped === true) continue;
    // prompt-side growth: sum of POSITIVE turn-to-turn deltas only. Negative
    // deltas are context compaction/reset events (the harness rewrites the
    // prompt), so first->last alone is meaningless in long sessions.
    const growth = sessionRecord.usagePerTurn.map((entry) => entry.actual);
    if (growth.length < 2) continue;
    let positiveGrowth = 0;
    let compactions = 0;
    let maxActual = 0;
    for (let i = 1; i < growth.length; i += 1) {
      const delta = growth[i] - growth[i - 1];
      if (delta > 0) positiveGrowth += delta;
      else if (delta < 0) compactions += 1;
      if (growth[i] > maxActual) maxActual = growth[i];
    }
    const est = sessionRecord.estContentTokensTotal;
    estimatorRows.push({
      sessionId: sessionRecord.sessionId,
      estContentTokens: est,
      promptSidePositiveGrowth: positiveGrowth,
      compactionEvents: compactions,
      maxPromptSideTokens: growth.length > 0 ? Math.max(maxActual, growth[0]) : 0,
      estTokensKeptTotal: estKeptBySession.get(sessionRecord.sessionId) ?? null,
      ratioFullContent: positiveGrowth === 0 ? null : Math.round((est / positiveGrowth) * 1000) / 1000,
      ratioKeptTruncated: positiveGrowth === 0 ? null : Math.round(((estKeptBySession.get(sessionRecord.sessionId) ?? 0) / positiveGrowth) * 1000) / 1000,
    });
  }

  const stats = {
    capturedAt: new Date().toISOString(),
    config: {
      weights: DEFAULT_WEIGHTS,
      halfLifeTurns: DEFAULT_SCORING_CONFIG.halfLifeTurns,
      referenceSaturation: DEFAULT_SCORING_CONFIG.referenceSaturation,
    },
    decisionBoundary: boundary,
    totalItems: itemCountFrom(breakdown),
    quantileProbs: [0.05, 0.25, 0.5, 0.75, 0.95],
    featureQuantiles: Object.fromEntries(
      Object.entries(breakdown).map(([k, v]) => [k, quantiles(v, [0.05, 0.25, 0.5, 0.75, 0.95])]),
    ),
    featureMeans: Object.fromEntries(
      Object.entries(breakdown).map(([k, v]) => [k, Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000]),
    ),
    perType: Object.fromEntries(
      Object.entries(perType).map(([type, bucket]) => [
        type,
        {
          n: bucket.n,
          keptShare: Math.round((bucket.kept / bucket.n) * 1000) / 1000,
          medianScore: quantiles(bucket.scores, [0.5])[0],
        },
      ]),
    ),
    unknownTypeDiagnostics: diagnosticCount,
    flipsVsBaseline: flips,
    estimatorRows,
  };

  await writeFile(STATS_OUT, `${JSON.stringify(stats, null, 1)}\n`, { encoding: "utf8" });
  console.log(`scoring stats -> ${STATS_OUT}`);
}

function itemCountFrom(b) {
  return b.score.length;
}

await main();

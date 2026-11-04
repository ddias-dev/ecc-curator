// ECC Curator - ambiguity-rate instrumentation over REAL captured sessions (Priority 2).
//
// Pure measurement over the EXISTING governance path (src/pipeline/run.ts ingestContext +
// scoreAndGovern, src/scoring/score.ts, src/governor/govern.ts) applied to
// datasets/real-sessions items. No new decision kinds, no new abstractions: the per-item
// records are derived from the EXISTING GovernanceDecisionRecord fields (reasonCode,
// winningRuleId, score, action) exactly as the Governor emits them.
//
// resolved_by mapping (derived from existing reason codes, documented here once):
//   "rule"                    - HARD_CONSTRAINT_PINNED, or a winning governance rule
//                               (reasonCode embeds ":ruleId=<id>")
//   "manual-review-candidate" - score fell in the escalation band [retainAtOrAbove,
//                               keepAtOrAbove) = [0.35, 0.65), i.e. reasonCode
//                               MIDDLE_BAND_KEEP: the region where the deterministic
//                               policy substitutes KEEP for COMPRESS and a provider
//                               escalation could change the outcome. ASSUMPTION: the
//                               experimental adapter path never configures
//                               ambiguityRange (adapter.ts createPolicies:
//                               providerEscalationEnabled=false), so this threshold
//                               band is the honest proxy for escalation candidates.
//   "score"                   - decisive score bands (THRESHOLD_KEEP / THRESHOLD_DROP)
// Budget-overflow downgrades are recorded separately (reasonCode BUDGET_OVERFLOW:...)
// without altering their underlying resolution.
//
// False-drop proxy (Q3 evidence, deterministic from captured data): a DROPped
// item is counted as a likely false drop when the SAME file path/pattern
// (pathRef) was opened again at a LATER turn in the same session — i.e. the
// session had to re-acquire the context governance discarded. Items without a
// pathRef cannot participate (no re-reference observable) and are excluded.
//
// Usage: node evaluation/ambiguity-instrument.mjs

import { ingestContext, scoreAndGovern } from "../src/pipeline/run.ts";
import { defaultTokenEstimator } from "../src/token-estimator.ts";

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATASET_DIR = "datasets/real-sessions";
const OUT_FILE = "evaluation/ambiguity-report.json";

// Mirrors experimental/adapter.ts: default budget with no fixed segments
// (DEFAULT_CONTEXT_WINDOW_TOKENS 32_768 / OUTPUT_RESERVE 2_048 / SAFETY_MARGIN 512,
// committedTokens = 0 because this measurement has no fixed prompt segments).
const budget = {
  availableInputTokens: 32_768,
  committedTokens: 0,
  outputReserveTokens: 2_048,
  safetyMarginTokens: 512,
};

function resolveResolution(decision) {
  const reasonCode = String(decision.reasonCode ?? "");
  if (reasonCode === "HARD_CONSTRAINT_PINNED") return "rule";
  if (reasonCode.includes(":ruleId=")) return "rule";
  if (reasonCode.includes("MIDDLE_BAND_KEEP")) return "manual-review-candidate";
  return "score";
}

async function main() {
  const entries = await readdir(DATASET_DIR);
  const sessionDirs = entries.filter((name) => name !== "manifest.json" && name !== undefined && name.length > 0);
  sessionDirs.sort();

  const allRecords = [];
  const perSession = [];
  const reasonHistogram = {};
  const totals = {
    total_items: 0,
    resolved_by_rules: 0,
    resolved_by_scoring: 0,
    ambiguous_items: 0,
    budget_overflow_downgrades: 0,
    dropped_items_with_pathRef: 0,
    dropped_items_reacquired_later: 0,
  };

  for (const sessionId of sessionDirs) {
    const itemsPath = join(DATASET_DIR, sessionId, "items.json");
    const document = JSON.parse(await readFile(itemsPath, "utf8"));
    const items = document.items;

    // references proxy (honest, bounded): number of times the same file
    // path/pattern was opened in this session minus this one opening; 0 when no
    // pathRef is observable.
    const refCount = new Map();
    for (const item of items) {
      const ref = item.pathRef ?? "";
      if (ref === "") continue;
      refCount.set(ref, (refCount.get(ref) ?? 0) + 1);
    }
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

    // Mirror adapter.ts createPolicies() but over the types actually observed
    // (the classifier's open ContextType can emit types beyond the adapter's
    // eight experimental types; policy must cover what the measurement feeds).
    const observedTypes = [...new Set(newItems.map((item) => item.type))];
    const policies = {
      allowedActionsByType: new Map(
        observedTypes.map((type) => [type, new Set(["KEEP", "DROP"])]),
      ),
      providerEscalationEnabled: false,
      fallbackByDecisionKind: new Map(),
      thresholds: { keepAtOrAbove: 0.65, retainAtOrAbove: 0.35 },
    };

    const inventory = ingestContext(newItems, { estimator: defaultTokenEstimator });
    const stage = scoreAndGovern(inventory, {
      budget,
      policies,
      rules: [],
      enabledDecisionKinds: new Set(["KEEP", "DROP"]),
    });

    const session = { sessionId: document.sessionId, total: 0, rule: 0, score: 0, candidate: 0, overflow: 0, droppedWithPathRef: 0, reacquiredLater: 0 };
    const capturedById = new Map(items.map((item) => [item.id, item]));
    const refTimes = new Map(); // pathRef -> turns where that path/pattern was opened
    for (const item of items) {
      const ref = item.pathRef ?? "";
      if (ref === "") continue;
      const list = refTimes.get(ref) ?? [];
      list.push(item.atTurn);
      refTimes.set(ref, list);
    }
    const records = [];
    for (const decision of stage.governance.decisions) {
      const item = inventory.items.find((candidate) => candidate.id === decision.itemId);
      const record = {
        id: decision.itemId,
        sessionId,
        type: item?.type ?? "unknown",
        score: decision.score,
        decision: decision.action,
        resolved_by: resolveResolution(decision),
      };
      allRecords.push(record);
      totals.total_items += 1;
      session.total += 1;
      if (record.resolved_by === "rule") {
        totals.resolved_by_rules += 1;
        session.rule += 1;
      } else if (record.resolved_by === "manual-review-candidate") {
        totals.ambiguous_items += 1;
        session.candidate += 1;
      } else {
        totals.resolved_by_scoring += 1;
        session.score += 1;
      }
      if (String(decision.reasonCode ?? "").startsWith("BUDGET_OVERFLOW:")) {
        totals.budget_overflow_downgrades += 1;
        session.overflow += 1;
      }
      const key = `${decision.action}:${decision.reasonCode}`;
      reasonHistogram[key] = (reasonHistogram[key] ?? 0) + 1;
      const captured = capturedById.get(decision.itemId);
      if (decision.action === "DROP" && captured !== undefined) {
        const ref = captured.pathRef ?? "";
        if (ref !== "") {
          totals.dropped_items_with_pathRef += 1;
          session.droppedWithPathRef += 1;
          const opens = refTimes.get(ref) ?? [];
          if (opens.some((t) => t > captured.atTurn)) {
            totals.dropped_items_reacquired_later += 1;
            session.reacquiredLater += 1;
          }
        }
      }
      records.push(record);
    }
    session.ambiguity_rate = session.total === 0 ? 0 : Math.round((session.candidate / session.total) * 10_000) / 10_000;
    session.false_drop_proxy_rate = session.droppedWithPathRef === 0 ? null : Math.round((session.reacquiredLater / session.droppedWithPathRef) * 10_000) / 10_000;
    perSession.push(session);
  }

  const report = {
    capturedAt: new Date().toISOString(),
    method: "existing governance path (src/pipeline/run.ts scoreAndGovern) over datasets/real-sessions items; resolution derived from GovernanceDecisionRecord.reasonCode",
    policy: "adapter.ts createPolicies defaults: thresholds keepAtOrAbove 0.65 / retainAtOrAbove 0.35, providerEscalationEnabled false, no rules",
    ambiguityDefinition: "resolved_by=manual-review-candidate == reasonCode MIDDLE_BAND_KEEP: score in [0.35,0.65), the band where the deterministic policy substitutes KEEP for COMPRESS; escalation band assumption (no ambiguityRange configured in the production path)",
    metadataAssumptions: "metadata.references = pathRef-occurrences-in-session minus 1 (observed re-open proxy; 0 when no pathRef); priority/pinned left to ingestion defaults (type baseline / false)",
    budget,
    totals,
    ambiguity_rate: totals.total_items === 0 ? 0 : Math.round((totals.ambiguous_items / totals.total_items) * 10_000) / 10_000,
    false_drop_proxy_rate: totals.dropped_items_with_pathRef === 0 ? null : Math.round((totals.dropped_items_reacquired_later / totals.dropped_items_with_pathRef) * 10_000) / 10_000,
    false_drop_note: "denominator = DROPped items carrying a pathRef (re-reference observable); numerator = same pathRef opened again at a later turn",
    reasonHistogram,
    perSession,
    records: allRecords,
  };

  await writeFile(OUT_FILE, `${JSON.stringify(report, null, 1)}\n`, { encoding: "utf8" });
  console.log(`ambiguity report -> ${OUT_FILE}: ${totals.total_items} items, ${totals.ambiguous_items} manual-review-candidates (${report.ambiguity_rate}), ${totals.resolved_by_rules} rule, ${totals.resolved_by_scoring} score, ${totals.budget_overflow_downgrades} budget-overflow downgrades, ${totals.dropped_items_reacquired_later}/${totals.dropped_items_with_pathRef} dropped items re-acquired later (false-drop proxy ${report.false_drop_proxy_rate})`);
}

await main();

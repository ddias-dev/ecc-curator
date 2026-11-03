// ECC Curator - paired benchmark runner (dataset -> harness -> saved results).
// Contract source: evaluation/dataset.ts (workload loader), evaluation/harness.ts
// (compareEvaluationWorkload + saveEvaluationComparison), and the dataset format
// documented in docs/BENCHMARK_DATASETS.md.
//
// Honest scope: this runner executes workloads from the benchmark dataset using a
// SCRIPTED reference agent (apply the dataset's declared solution, then score the
// dataset's checks). That validates the paired-comparison plumbing offline; the
// task outcomes it records describe the scripted fixture, NOT a real coding-agent
// or model run. Token/context/item measurements around each run are real
// pipeline measurements, but no outcome improvement or savings claim follows from
// these runs. See docs/BENCHMARK_DATASETS.md (run paired comparisons, report
// limitations).
//
// Usage: node evaluation/runner.mjs [datasetDir] [outputDir] [resultTag]
//   datasetDir  default "benchmarks"      (JSON workload documents)
//   outputDir   default "evaluation"      (results written as <id>-<tag>.json)
//   resultTag   default "paired"          (safe filename tag; existing results
//                                          are never overwritten, re-tag or move
//                                          the file to re-run into a fresh slot)
// No network access, no credentials: workspaces are materialized under the OS
// temp directory, test invocations are restricted to node argv arrays.

import { loadBenchmarkDataset, toEvaluationWorkload, toIntegrationConfig, materializeWorkspace, runScriptedAgent } from "./dataset.ts";
import { compareEvaluationWorkload, saveEvaluationComparison } from "./harness.ts";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const datasetDirectory = process.argv[2] ?? "benchmarks";
const outputDirectory = process.argv[3] ?? "evaluation";
const resultTag = process.argv[4] ?? "paired";

console.log("ECC Curator benchmark runner - scripted reference agent; task outcomes are fixture plumbing checks, not model results.");

const workloads = await loadBenchmarkDataset(datasetDirectory);
console.log(`Loaded ${workloads.length} workload(s) from ${datasetDirectory}`);

for (const workload of workloads) {
  const workloadId = workload.id;

  // Fresh, isolated workspace for each mode: mkdtemp under os.tmpdir(), never
  // the repository checkout. Baseline and governed runs therefore start from
  // identical starting state and cannot observe each other's edits.
  const execute = async (prompt, mode, workloadIdForRun) => {
    const workspace = await mkdtemp(join(tmpdir(), `ecc-curator-${workloadId}-${mode}-`));
    await materializeWorkspace(workload, workspace);
    try {
      return await runScriptedAgent(workload, workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };

  const comparison = await compareEvaluationWorkload(
    toEvaluationWorkload(workload),
    toIntegrationConfig(workload, 32_768),
    execute,
  );

  const [baseline, governed] = comparison.runs;
  console.log(
    `workload ${workloadId}: ` +
    `baseline {prompt ${baseline.promptTokens}, ctx ${baseline.contextTokens}, kept ${baseline.itemsKept}, dropped ${baseline.itemsDropped}, tests ${baseline.testsPassed}/${baseline.testsTotal}} vs ` +
    `governed {prompt ${governed.promptTokens}, ctx ${governed.contextTokens}, kept ${governed.itemsKept}, dropped ${governed.itemsDropped}, tests ${governed.testsPassed}/${governed.testsTotal}}`,
  );

  const resultPath = await saveEvaluationComparison(comparison, `${workloadId}-${resultTag}`, outputDirectory);
  console.log(`saved: ${resultPath} (existing files are not overwritten)`);
}

console.log("Limitations: scripted reference agent only; real-agent runs must replace runScriptedAgent. Nondeterministic model runs, workspace/order effects, and single repetitions are not comparable across releases. See docs/BENCHMARK_DATASETS.md.");

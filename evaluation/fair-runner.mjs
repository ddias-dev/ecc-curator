// ECC Curator - fair repeated comparison runner (evaluation fairness: N>=5 per
// workload, alternating execution order, raw evidence saved per run).
//
// Contract sources: ./dataset.ts (workload loader), ./real-agent.ts (callback
// contract + createRealAgentExecute), ./harness.ts (compareEvaluationWorkload -
// now order-parameterized - and saveEvaluationComparison).
//
// Opt-in guard reuses runner-real.mjs's rule: nothing runs until the user passes
// --agent naming a reviewed callback module (trusted, un-sandboxed user code).
//
// Fairness implemented (docs/BENCHMARK_DATASETS.md limitation list):
//   - repetition count N per workload (default 5; recorded in the manifest)
//   - alternating execution order per repetition: rep0 baseline-first, rep1
//     governed-first, rep2 baseline-first, ... — the recorded per-result
//     executionOrder field names the order that actually ran
//   - fresh per-mode workspaces (createRealAgentExecute; os.tmpdir(), torn down)
//   - every raw comparison saved (evaluation/results/<id>-fair-r<rep>.json);
//     existing files are never overwritten (re-tag to re-run into a fresh slot)
//   - reproducibility metadata: agent module + exported AGENT_SETTINGS, dataset
//     state (sha-256 per workload JSON), Node version, timestamp, env note
//
// Usage: node evaluation/fair-runner.mjs --agent <agentModulePath> \
//          [datasetDir=benchmarks] [outputDir=evaluation/results] [repeats=5]

import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { readdir, readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";

import { loadBenchmarkDataset, toEvaluationWorkload, toIntegrationConfig } from "./dataset.ts";
import { createRealAgentExecute } from "./real-agent.ts";
import { compareEvaluationWorkload, saveEvaluationComparison } from "./harness.ts";

const cliArgs = process.argv.slice(2);
const agentIndex = cliArgs.indexOf("--agent");
if (agentIndex < 0 || agentIndex + 1 >= cliArgs.length) {
  console.error(
    "Refusing to run: real-agent evaluation is explicitly opt-in. Pass --agent <path> " +
    "naming a reviewed callback module (see docs/BENCHMARK_DATASETS.md).",
  );
  process.exit(1);
}
const agentModulePath = resolve(cliArgs[agentIndex + 1]);
const positional = [];
for (let index = 0; index < cliArgs.length; index = index + 1) {
  if (index !== agentIndex && index !== agentIndex + 1) {
    positional.push(cliArgs[index]);
  }
}
const datasetDirectory = positional[0] ?? "benchmarks";
const outputDirectory = positional[1] ?? "evaluation/results";
const repeats = positional[2] === undefined ? 5 : Number(positional[2]);
// result tag base: reference/deterministic and real-agent runs must not collide
// (saveEvaluationComparison never overwrites; re-run into a fresh tag slot).
const tagBase = positional[3] ?? "fair";
if (!Number.isInteger(repeats) || repeats < 1) {
  console.error("repeats must be a positive integer (plan requires N >= 5).");
  process.exit(1);
}
if (repeats < 5) {
  console.log(`NOTE: repeats=${repeats} is below the plan minimum N >= 5; recorded as such, results are indicative only.`);
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function collectJsonPaths(dir) {
  const paths = [];
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = (await lstat(full)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) paths.push(...await collectJsonPaths(full));
    else if (full.endsWith(".json")) paths.push(full);
  }
  return paths;
}

async function collectDatasetState(dir) {
  const paths = (await collectJsonPaths(dir)).sort();
  const state = [];
  for (const file of paths) {
    state.push({ file, sha256: digest(await readFile(file, "utf8")) });
  }
  return state;
}

async function main() {
  const agentModule = await import(pathToFileURL(agentModulePath).href);
  const runAgent = agentModule.runAgent;
  if (typeof runAgent !== "function") {
    console.error(`Agent module must export a runAgent function: ${agentModulePath}`);
    process.exit(1);
  }
  const agentSettings = agentModule.AGENT_SETTINGS ?? null;

  await mkdir(outputDirectory, { recursive: true });

  const workloads = await loadBenchmarkDataset(datasetDirectory);
  console.log(`Loaded ${workloads.length} workload(s) from ${datasetDirectory}; N=${repeats} repetitions, alternating order`);

  const manifest = {
    capturedAt: new Date().toISOString(),
    nodeVersion: process.version,
    agentModulePath,
    agentSettings,
    envNote: "agent callback inherits the parent process environment in full (model endpoint auth); recorded per docs/BENCHMARK_DATASETS.md",
    datasetDirectory,
    datasetState: await collectDatasetState(datasetDirectory),
    repeats,
    orderPattern: "rep0 baseline-first, rep1 governed-first, alternating",
    runs: [],
    summaries: [],
  };

  for (const workload of workloads) {
    const workloadId = workload.id;
    const summary = { workloadId, reps: 0, baselineCompleted: 0, baselineTestsPass: 0, governedCompleted: 0, governedTestsPass: 0, promptTokens: { baseline: [], governed: [] }, errors: [] };
    for (let rep = 0; rep < repeats; rep += 1) {
      const order = rep % 2 === 0 ? ["baseline", "governed"] : ["governed", "baseline"];
      const row = { workloadId, rep, order };
      try {
        const comparison = await compareEvaluationWorkload(
          toEvaluationWorkload(workload),
          toIntegrationConfig(workload, 32_768),
          createRealAgentExecute(workload, runAgent),
          order,
        );
        const [baseline, governed] = comparison.runs;
        row.resultFile = await saveEvaluationComparison(comparison, `${workloadId}-${tagBase}-r${rep}`, outputDirectory);
        row.baseline = { taskCompleted: baseline.taskCompleted, testsPassed: baseline.testsPassed, testsTotal: baseline.testsTotal, promptTokens: baseline.promptTokens, errors: baseline.errors, errorStage: baseline.errorStage };
        row.governed = { taskCompleted: governed.taskCompleted, testsPassed: governed.testsPassed, testsTotal: governed.testsTotal, promptTokens: governed.promptTokens, itemsKept: governed.itemsKept, itemsDropped: governed.itemsDropped, errors: governed.errors, errorStage: governed.errorStage };
        summary.reps += 1;
        if (baseline.taskCompleted) summary.baselineCompleted += 1;
        if (baseline.testsTotal > 0 && baseline.testsPassed === baseline.testsTotal) summary.baselineTestsPass += 1;
        if (governed.taskCompleted) summary.governedCompleted += 1;
        if (governed.testsTotal > 0 && governed.testsPassed === governed.testsTotal) summary.governedTestsPass += 1;
        summary.promptTokens.baseline.push(baseline.promptTokens);
        summary.promptTokens.governed.push(governed.promptTokens);
        console.log(
          `${workloadId} r${rep} order=${order.join(">")} baseline {completed ${baseline.taskCompleted}, tests ${baseline.testsPassed}/${baseline.testsTotal}, prompt ${baseline.promptTokens}} governed {completed ${governed.taskCompleted}, tests ${governed.testsPassed}/${governed.testsTotal}, prompt ${governed.promptTokens}, kept ${governed.itemsKept}, dropped ${governed.itemsDropped}}`,
        );
      } catch (error) {
        row.error = `${error?.name ?? "Error"}: ${String(error?.message ?? error)}`;
        summary.errors.push(row.error);
        console.log(`${workloadId} r${rep}: RUN ERROR ${row.error}`);
      }
      manifest.runs.push(row);
    }
    manifest.summaries.push(summary);
  }

  const manifestPath = join(outputDirectory, "fair-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`, { encoding: "utf8" });
  console.log(`manifest -> ${manifestPath}`);
}

await main();

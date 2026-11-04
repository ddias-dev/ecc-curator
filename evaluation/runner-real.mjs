// ECC Curator - REAL-AGENT paired benchmark runner (opt-in path).
// Contract sources: ./dataset.ts (workload loader + shared scoreWorkspace), ./real-agent.ts
// (callback contract + createRealAgentExecute), ./harness.ts (compareEvaluationWorkload +
// saveEvaluationComparison), and the dataset format documented in docs/BENCHMARK_DATASETS.md
// ("Real-agent opt-in path").
//
// OPT-IN ONLY. This runner does nothing until the user passes an explicit --agent
// <path> naming a module they wrote and reviewed. This module imports no model, no
// agent runtime, and no vendor SDK; the callback you provide is trusted user code and
// is NOT sandboxed (the same trust boundary as dataset test scripts applies to it: no
// filesystem/network isolation, and the callback typically launches a runtime that
// contacts a model endpoint). Clearing child-process environment variables bounds
// credential inheritance only; it does not make execution safe. Never point this
// runner at unreviewed datasets or callbacks.
//
// Honest scope: unlike evaluation/runner.mjs (scripted reference agent, unchanged),
// this path runs a user-supplied callback against fresh per-mode workspaces that hold
// ONLY the dataset's setup files - the workload's scripted `solution` is never applied
// here. Task outcomes therefore measure what the callback actually did. A single run
// proves nothing about improvement, savings, or model capability: real runs are
// nondeterministic, order-sensitive (baseline first, governed second), and comparable
// only across repeats with the agent/runtime/model configuration recorded.
//
// Usage: node evaluation/runner-real.mjs --agent <agentModulePath> [datasetDir] [outputDir] [resultTag]
//   --agent       REQUIRED opt-in switch: path (absolute or relative to the current
//                 directory) to a local module exporting `runAgent` (the callback:
//                 (RealAgentRequest) => optional RealAgentReport).
//   datasetDir    default "benchmarks" (trusted, reviewed datasets only)
//   outputDir     default "evaluation" (results written as <id>-<tag>.json)
//   resultTag     default "real" - keep tags distinct per run mode so scripted
//                 (<id>-paired.json) and real (<id>-real.json by default) results
//                 never collide; existing files are never overwritten (re-tag to
//                 re-run into a fresh slot).

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { loadBenchmarkDataset, toEvaluationWorkload, toIntegrationConfig } from "./dataset.ts";
import { createRealAgentExecute } from "./real-agent.ts";
import { compareEvaluationWorkload, saveEvaluationComparison } from "./harness.ts";

const cliArgs = process.argv.slice(2);
const agentIndex = cliArgs.indexOf("--agent");
if (agentIndex < 0 || agentIndex + 1 >= cliArgs.length) {
  console.error(
    "Refusing to run: real-agent evaluation is explicitly opt-in. Pass --agent <path> " +
    "naming a reviewed local module exporting runAgent (see docs/BENCHMARK_DATASETS.md). " +
    "Nothing in this repository invokes a model or agent runtime on its own.",
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
const outputDirectory = positional[1] ?? "evaluation";
const resultTag = positional[2] ?? "real";

const agentModule = await import(pathToFileURL(agentModulePath).href);
const runAgent = agentModule.runAgent;
if (typeof runAgent !== "function") {
  console.error(`Agent module must export a runAgent function: ${agentModulePath}`);
  process.exit(1);
}

console.log(
  "REAL-AGENT run - the callback is user-supplied, trusted, un-sandboxed code that may invoke a model/runtime; " +
  "workspaces contain only the dataset's setup files (the scripted solution is never applied); record the agent/runtime/model settings, dataset state, Node version, run tag, and execution order for reproducibility.",
);

const workloads = await loadBenchmarkDataset(datasetDirectory);
console.log(`Loaded ${workloads.length} workload(s) from ${datasetDirectory}`);

for (const workload of workloads) {
  const workloadId = workload.id;
  const comparison = await compareEvaluationWorkload(
    toEvaluationWorkload(workload),
    toIntegrationConfig(workload, 32_768),
    createRealAgentExecute(workload, runAgent),
  );

  const [baseline, governed] = comparison.runs;
  console.log(
    `workload ${workloadId} (real agent): ` +
    `baseline {prompt ${baseline.promptTokens}, ctx ${baseline.contextTokens}, tests ${baseline.testsPassed}/${baseline.testsTotal}} vs ` +
    `governed {prompt ${governed.promptTokens}, ctx ${governed.contextTokens}, kept ${governed.itemsKept}, dropped ${governed.itemsDropped}, tests ${governed.testsPassed}/${governed.testsTotal}, dur ${Math.round(governed.sessionDurationMs)}ms}`,
  );

  const resultPath = await saveEvaluationComparison(comparison, `${workloadId}-${resultTag}`, outputDirectory);
  console.log(`saved: ${resultPath} (tag ${resultTag}; existing files are not overwritten)`);
}

console.log(
  "Limitations: a single real-agent run is not comparable evidence - model/agent nondeterminism, one repetition, " +
  "baseline-before-governed execution order, and workspace/environment state the agent inherits must all be recorded. " +
  "Compare real runs only against other real runs; scripted results measure plumbing, not outcomes. No claim of task-quality " +
  "improvement or token savings follows from any run here. Dataset test scripts and the callback execute trusted, unreviewed-by-runtime code with no sandboxing. See docs/BENCHMARK_DATASETS.md.",
);

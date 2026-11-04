// ECC Curator - opt-in real-agent evaluation path (callback contract +
// harness-compatible execute factory).
// Contract sources: evaluation/harness.ts (compareEvaluationWorkload consumes
// the factory this module produces), ./dataset.ts (workload validation and the
// shared scoreWorkspace check scoring), and docs/BENCHMARK_DATASETS.md
// ("Real-agent opt-in path").
//
// Opt-in and honesty constraints (docs/BENCHMARK_DATASETS.md):
// - Nothing here runs any model, agent runtime, or network call by itself. A
//   real evaluation happens ONLY when the user supplies a callback module and
//   runs evaluation/runner-real.mjs with an explicit --agent argument; the
//   scripted runner (evaluation/runner.mjs) remains the default path and is
//   unchanged.
// - The callback is user-supplied code that may launch a coding agent, call a
//   model, or read/write files. It is trusted user code, not sandboxed: the
//   same trust boundary as the dataset's test scripts applies to it (docs/
//   BENCHMARK_DATASETS.md, "Trust boundary"); never wire in a callback you
//   have not reviewed.
// - The workload's scripted `solution` is NEVER applied in this path. The
//   workspace holds only the dataset's `setup` files before the callback runs;
//   afterwards the objective completion + test checks (scoreWorkspace, shared
//   with the scripted path) decide the outcome. Results from this path must
//   not be compared against scripted results as improvements; they measure
//   different things.
// - Provider-neutral: no vendor, model, or agent runtime is imported,
//   required, or assumed. What the callback does is entirely the user's
//   decision and must be recorded (agent/runtime/model settings) for a run to
//   be reproducible.
// - Baseline and governed runs get separate fresh workspaces under os.tmpdir()
//   (mode-named for legibility), never the repository checkout, and are torn
//   down after each run. The harness runs baseline first and governed second;
//   this module does not randomize order — a real comparison must record
//   execution order and any state the agent inherits.
// - A callback exception propagates to the harness (recorded as a failed run
//   with one error, errorStage "agent", so the paired run can continue); an
//   optional report with retries/errors is validated by the harness
//   (InvalidEvaluationOutcomeError), consistent with scripted runs. Prompts
//   and workspace contents are not persisted by the harness.

import { materializeWorkspace, scoreWorkspace } from "./dataset.ts";
import type { BenchmarkWorkload } from "./dataset.ts";
import type { EvaluationTaskOutcome, EvaluationMode } from "./harness.ts";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The request every real-agent callback receives. Everything is explicit so
// the callback needs no hidden harness state: the mode-appropriate prompt the
// harness chose (the raw task prompt in baseline, the assembled governed
// package in governed), the mode, the workload id, and a fresh isolated
// workspace already holding the dataset's setup files (and no solution).
export interface RealAgentRequest {
  workloadId: string;
  mode: EvaluationMode;
  prompt: string;
  workspaceDirectory: string;
}

// The callback returns nothing, or an optional self-report of retries and
// errors the agent experienced ("where available" — an uninstrumented agent
// simply returns nothing). Counts must be non-negative safe integers; the
// harness validates them, so an invalid report rejects the run exactly like
// an invalid scripted outcome does.
export interface RealAgentReport {
  retries?: number;
  errors?: number;
}

// The user-supplied real-agent callback shape. RealAgentRequest is a structural
// superset of what the callback reads, so any conforming user function (one
// annotated with this parameter type) is assignable to this contract.
export type RealAgentCallback = (
  request: RealAgentRequest,
) => void | RealAgentReport | Promise<void | RealAgentReport>;

// Harness-compatible execute factory: the result's signature matches what
// compareEvaluationWorkload expects, so the real-agent path reuses the whole
// existing harness (prompt assembly, metrics, error recording, saving).
// Per invocation: create a fresh workspace under os.tmpdir() named for the
// mode, materialize ONLY the setup files, await the user callback, then score
// the workspace with the shared objective checks. The workspace is removed
// afterwards either way (finally), so runs cannot accumulate state.
export function createRealAgentExecute(
  workload: BenchmarkWorkload,
  runAgent: RealAgentCallback,
): (prompt: string, mode: EvaluationMode, workloadId: string) => Promise<EvaluationTaskOutcome> {
  return async (prompt: string, mode: EvaluationMode, _workloadId: string) => {
    const workspaceDirectory = await mkdtemp(join(tmpdir(), `ecc-curator-${workload.id}-${mode}-`));
    try {
      await materializeWorkspace(workload, workspaceDirectory);
      const report = await runAgent({
        workloadId: workload.id,
        mode,
        prompt,
        workspaceDirectory,
      });
      const outcome = await scoreWorkspace(workload, workspaceDirectory);
      if (report === undefined || report === null) {
        return outcome;
      }
      if (report.retries !== undefined) {
        outcome.retries = report.retries;
      }
      if (report.errors !== undefined) {
        outcome.errors = report.errors;
      }
      return outcome;
    } finally {
      await rm(workspaceDirectory, { recursive: true, force: true });
    }
  };
}

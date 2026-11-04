// Tests for evaluation/real-agent.ts and evaluation/runner-real.mjs: the opt-in
// real-agent callback path. The callback here is a LOCAL test callback (it
// writes files in the workspace like a real agent would); these tests validate
// the callback plumbing only - they establish nothing about any real model or
// agent behaviour, and no model or runtime is ever invoked.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRealAgentExecute } from "../evaluation/real-agent.ts";
import type { RealAgentRequest } from "../evaluation/real-agent.ts";

import { parseBenchmarkWorkload, toEvaluationWorkload, toIntegrationConfig, materializeWorkspace, runScriptedAgent } from "../evaluation/dataset.ts";
import type { BenchmarkWorkload } from "../evaluation/dataset.ts";

import { compareEvaluationWorkload } from "../evaluation/harness.ts";
import { InvalidEvaluationOutcomeError } from "../evaluation/harness.ts";

import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setupContent = "return count - 1;\n";
const solutionContent = "return count + 1;\n";

function minimalDocument(): unknown {
  return {
    schemaVersion: "1",
    id: "issue-fix-boundary",
    category: "coding/issue-fix",
    task: "Fix src/boundary.js so boundarySize returns count + 1.",
    setup: [{ path: "src/boundary.js", content: setupContent }],
    solution: [{ path: "src/boundary.js", content: solutionContent }],
    contextItems: [{ id: "goal-1", type: "goal", content: "Boundary correctness.", source: "user_goal", priority: 1 }],
    checks: {
      tests: [],
      completion: [{ kind: "file_contains", path: "src/boundary.js", needle: "count + 1" }],
    },
  };
}

async function withTempDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ecc-real-agent-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("callback gets explicit mode/workloadId/prompt/workspace; setup-only and fresh per mode", async () => {
  const workload: BenchmarkWorkload = parseBenchmarkWorkload(minimalDocument());
  const requests: RealAgentRequest[] = [];
  const execute = createRealAgentExecute(workload, async (request: RealAgentRequest) => {
    requests.push({ ...request });
    const content = await readFile(join(request.workspaceDirectory, "src", "boundary.js"), "utf8");
    // The scripted solution must NOT be pre-applied: the workspace holds the
    // unfixed setup content when the callback starts.
    assert.equal(content, setupContent);
  });

  const baselineOutcome = await execute("first prompt", "baseline", workload.id);
  const governedOutcome = await execute("second prompt", "governed", workload.id);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.mode), ["baseline", "governed"]);
  assert.deepEqual(requests.map((request) => request.workloadId), [workload.id, workload.id]);
  assert.equal(requests[0].prompt, "first prompt");
  assert.equal(requests[1].prompt, "second prompt");
  assert.notEqual(requests[0].workspaceDirectory, requests[1].workspaceDirectory);

  // A no-op callback leaves the workload unsolved: checks must fail; nothing
  // about model behaviour is implied by this.
  assert.equal(baselineOutcome.taskCompleted, false);
  assert.deepEqual([baselineOutcome.testsPassed, baselineOutcome.testsTotal], [0, 0]);

  // Workspaces are torn down after each run (finally), so no state leaks.
  const missing = (error: unknown) =>
    error instanceof Error && (error as { code?: string}).code === "ENOENT";
  await assert.rejects(() => stat(requests[0].workspaceDirectory), missing);
  await assert.rejects(() => stat(requests[1].workspaceDirectory), missing);
});
test("compareEvaluationWorkload drives the real callback in both modes with mode-appropriate prompts", async () => {
  const workload: BenchmarkWorkload = parseBenchmarkWorkload(minimalDocument());
  const invocations: { mode: string; prompt: string; workspace: string }[] = [];
  const execute = createRealAgentExecute(workload, async (request: RealAgentRequest) => {
    invocations.push({ mode: request.mode, prompt: request.prompt, workspace: request.workspaceDirectory });
    // A "fixing" callback writes the fix itself - the only way the objective
    // checks can pass in this path; the dataset solution is never pre-applied.
    await writeFile(join(request.workspaceDirectory, "src", "boundary.js"), solutionContent, { encoding: "utf8" });
  });

  const projected = toEvaluationWorkload(workload);
  const comparison = await compareEvaluationWorkload(
    projected,
    toIntegrationConfig(workload, 8_192),
    execute,
  );

  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations.map((invocation) => invocation.mode), ["baseline", "governed"]);
  assert.notEqual(invocations[0].workspace, invocations[1].workspace);
  // Baseline sees the host-built UNGOVERNED serialization (task + every
  // context item); governed sees the assembled governed package
  // (JSON of fixed segments + kept context items in ContextItem shape).
  // Same task text and same context source feed both.
  assert.equal(invocations[0].prompt, projected.baselinePrompt);
  assert.ok(invocations[0].prompt.includes(workload.task));
  assert.ok(invocations[0].prompt.includes("Boundary correctness."));
  assert.ok(invocations[1].prompt.includes(workload.task));
  assert.notEqual(invocations[1].prompt, invocations[0].prompt);

  const [baseline, governed] = comparison.runs;
  assert.deepEqual([baseline.mode, governed.mode], ["baseline", "governed"]);
  assert.equal(baseline.taskCompleted, true);
  assert.equal(governed.taskCompleted, true);
  assert.equal(governed.itemsDropped, 0);
  assert.ok(
    governed.contextTokens !== null
      && baseline.contextTokens !== null
      && governed.contextTokens <= baseline.contextTokens,
  );
});

// Workload whose context has one item a governed rule will DROP: the fair
// comparison must show the baseline callback receiving it and the governed
// callback not receiving it.
function noiseDocument(): unknown {
  return {
    schemaVersion: "1",
    id: "issue-fix-boundary-noisy",
    category: "coding/issue-fix",
    task: "Fix src/boundary.js so boundarySize returns count + 1.",
    setup: [{ path: "src/boundary.js", content: setupContent }],
    solution: [{ path: "src/boundary.js", content: solutionContent }],
    contextItems: [
      { id: "goal-1", type: "goal", content: "Boundary correctness.", source: "user_goal", priority: 1 },
      { id: "noise-1", type: "terminal_output", content: "UNGOVERNED-ONLY-MARKER", source: "operator", priority: 1 },
    ],
    rules: [{ ruleId: "drop-terminal-noise", priority: 10, scope: "context_type", contextType: "terminal_output", action: "DROP" }],
    checks: {
      tests: [],
      completion: [{ kind: "file_contains", path: "src/boundary.js", needle: "count + 1" }],
    },
  };
}

test("baseline callback receives task plus EVERY context item, including one a governed rule drops; governed receives only retained items", async () => {
  const workload: BenchmarkWorkload = parseBenchmarkWorkload(noiseDocument());
  const prompts: { mode: string; prompt: string }[] = [];
  const execute = createRealAgentExecute(workload, async (request: RealAgentRequest) => {
    prompts.push({ mode: request.mode, prompt: request.prompt });
    await writeFile(join(request.workspaceDirectory, "src", "boundary.js"), solutionContent, { encoding: "utf8" });
  });

  const comparison = await compareEvaluationWorkload(
    toEvaluationWorkload(workload),
    toIntegrationConfig(workload, 8_192),
    execute,
  );

  const [baselineRun, governedRun] = comparison.runs;
  const [baselinePrompt, governedPrompt] = [prompts[0].prompt, prompts[1].prompt];

  // Baseline: ungoverned serialization carries the task AND every context
  // item verbatim, including the terminal_output item the governed DROP rule
  // removes. No governance selection was applied to it.
  assert.equal(baselineRun.mode, "baseline");
  assert.ok(baselinePrompt.includes(workload.task));
  assert.ok(baselinePrompt.includes("Boundary correctness."));
  assert.ok(baselinePrompt.includes("UNGOVERNED-ONLY-MARKER"));
  assert.equal(baselineRun.itemsKept, 2);
  assert.equal(baselineRun.itemsDropped, 0);

  // Governed: same task instruction, only governance-retained items - the
  // rule-dropped item's content never appears in the governed prompt.
  assert.equal(governedRun.mode, "governed");
  assert.ok(governedPrompt.includes(workload.task));
  assert.ok(governedPrompt.includes("Boundary correctness."));
  assert.notEqual(governedPrompt.includes("UNGOVERNED-ONLY-MARKER"), true);
  assert.equal(governedRun.itemsKept, 1);
  assert.equal(governedRun.itemsDropped, 1);
});

test("baseline and governed prompts are deterministic across repeated comparisons of the same workload", async () => {
  const workload: BenchmarkWorkload = parseBenchmarkWorkload(noiseDocument());
  const prompts: string[] = [];
  const runOnce = async (): Promise<void> => {
    const execute = createRealAgentExecute(workload, async (request: RealAgentRequest) => {
      prompts.push(`${request.mode}:${request.prompt}`);
      await writeFile(join(request.workspaceDirectory, "src", "boundary.js"), solutionContent, { encoding: "utf8" });
    });
    await compareEvaluationWorkload(
      toEvaluationWorkload(workload),
      toIntegrationConfig(workload, 8_192),
      execute,
    );
  };

  await runOnce();
  await runOnce();

  assert.equal(prompts.length, 4);
  // Byte-identical prompts across independent comparisons (same workload
  // inputs, no random selection, no Date.now in the governed path).
  assert.equal(prompts[0], prompts[2]);
  assert.equal(prompts[1], prompts[3]);
  assert.notEqual(prompts[0], prompts[1]);
});

test("a callback exception is recorded as a failed run and the paired run continues", async () => {
  const workload: BenchmarkWorkload = parseBenchmarkWorkload(minimalDocument());
  const execute = createRealAgentExecute(workload, async (request: RealAgentRequest) => {
    if (request.mode === "governed") {
      throw new Error("simulated agent crash");
    }
    await writeFile(join(request.workspaceDirectory, "src", "boundary.js"), solutionContent, { encoding: "utf8" });
  });

  const comparison = await compareEvaluationWorkload(
    toEvaluationWorkload(workload),
    toIntegrationConfig(workload),
    execute,
  );
  const [baseline, governed] = comparison.runs;
  assert.equal(baseline.taskCompleted, true);
  assert.equal(baseline.errors, 0);
  // Harness-consistent recording of an agent error (same as scripted runs):
  assert.equal(governed.taskCompleted, false);
  assert.equal(governed.errors, 1);
  assert.equal(governed.errorStage, "agent");
  assert.ok(governed.promptTokens !== null);
});

test("an invalid callback report is rejected by the harness, not coerced", async () => {
  const workload: BenchmarkWorkload = parseBenchmarkWorkload(minimalDocument());
  const execute = createRealAgentExecute(workload, async (request: RealAgentRequest) => {
    await writeFile(join(request.workspaceDirectory, "src", "boundary.js"), solutionContent, { encoding: "utf8" });
    return { retries: -1 };
  });

  await assert.rejects(
    () =>
      compareEvaluationWorkload(
        toEvaluationWorkload(workload),
        toIntegrationConfig(workload),
        execute,
      ),
    (error: unknown) => error instanceof InvalidEvaluationOutcomeError,
  );
});

test("an optional self-report contributes retries/errors where available", async () => {
  const workload: BenchmarkWorkload = parseBenchmarkWorkload(minimalDocument());
  const execute = createRealAgentExecute(workload, async (request: RealAgentRequest) => {
    await writeFile(join(request.workspaceDirectory, "src", "boundary.js"), solutionContent, { encoding: "utf8" });
    return { retries: 2 };
  });
  const outcome = await execute("prompt", "baseline", workload.id);
  assert.equal(outcome.taskCompleted, true);
  assert.equal(outcome.retries, 2);
  assert.equal(outcome.errors, 0);
});
test("the scripted reference path keeps working unchanged next to the real path", async () => {
  const workload: BenchmarkWorkload = parseBenchmarkWorkload(minimalDocument());
  const comparison = await compareEvaluationWorkload(
    toEvaluationWorkload(workload),
    toIntegrationConfig(workload),
    async (_prompt, mode, _workloadId) => {
      const workspace = await mkdtemp(join(tmpdir(), `ecc-scripted-${mode}-`));
      try {
        await materializeWorkspace(workload, workspace);
        return await runScriptedAgent(workload, workspace);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
  const [baseline, governed] = comparison.runs;
  assert.deepEqual([baseline.mode, governed.mode], ["baseline", "governed"]);
  assert.equal(baseline.taskCompleted, true);
  assert.equal(governed.taskCompleted, true);
  assert.deepEqual([baseline.retries, baseline.errors, governed.retries, governed.errors], [0, 0, 0, 0]);
});

test("runner-real.mjs refuses to run without the explicit --agent opt-in", () => {
  const runner = join(process.cwd(), "evaluation", "runner-real.mjs");
  const run = spawnSync(process.execPath, [runner], { cwd: process.cwd() });
  assert.notEqual(run.status, 0);
  assert.ok(String(run.stderr).includes("opt-in"));
});

test("runner-real.mjs runs a supplied callback and saves identifiable, non-overwritten results", async () => {
  const agentSource = [
    "import { writeFile } from \"node:fs/promises\";",
    "import { join } from \"node:path\";",
    "export async function runAgent(request) {",
    "  await writeFile(join(request.workspaceDirectory, \"src\", \"boundary.js\"), \"return count + 1;\\n\", { encoding: \"utf8\" });",
    "}",
  ].join("\n");
  await withTempDirectory(async (directory) => {
    const datasetDir = join(directory, "dataset");
    const outDir = join(directory, "results");
    const agentPath = join(directory, "agent.mjs");
    await mkdir(datasetDir, { recursive: true });
    await writeFile(agentPath, agentSource, { encoding: "utf8" });
    await writeFile(join(datasetDir, "boundary.json"), JSON.stringify(minimalDocument()), { encoding: "utf8" });

    const runner = join(process.cwd(), "evaluation", "runner-real.mjs");
    const runnerArguments = [runner, "--agent", agentPath, datasetDir, outDir, "cli-real"];
    const first = spawnSync(process.execPath, runnerArguments, { cwd: process.cwd() });
    assert.equal(first.status, 0);

    const saved = join(outDir, "issue-fix-boundary-cli-real.json");
    const text = await readFile(saved, "utf8");
    const savedDocument = JSON.parse(text) as {
      schemaVersion: string;
      runs: ({ mode: string; taskCompleted: boolean }[]);
    };
    assert.equal(savedDocument.schemaVersion, "1");
    assert.deepEqual(savedDocument.runs.map((runMetrics) => runMetrics.mode), ["baseline", "governed"]);
    assert.ok(savedDocument.runs.every((runMetrics) => runMetrics.taskCompleted));

    // Re-running with the same tag must never overwrite: the saved bytes stay
    // identical and the second run fails on the existing file.
    const second = spawnSync(process.execPath, runnerArguments, { cwd: process.cwd() });
    assert.notEqual(second.status, 0);
    assert.equal(await readFile(saved, "utf8"), text);
  });
});
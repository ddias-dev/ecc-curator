// Tests for evaluation/dataset.ts: workload validation (malformed + unknown
// shapes), dataset loading, harness projections, and the isolated-workspace
// plumbing (materialize, scripted solution, node-only test invocations).
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBenchmarkWorkload, loadBenchmarkWorkload, loadBenchmarkDataset, toEvaluationWorkload, toIntegrationConfig, materializeWorkspace, runScriptedAgent, runTestRuns, evaluateCompletionChecks } from "../evaluation/dataset.ts";
import { InvalidBenchmarkWorkloadError, UnexpectedWorkspaceReadError } from "../evaluation/dataset.ts";

import type { BenchmarkWorkload } from "../evaluation/dataset.ts";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function minimalDocument(): unknown {
  return {
    schemaVersion: "1",
    id: "issue-fix-boundary",
    category: "coding/issue-fix",
    task: "Fix src/boundary.js so boundarySize returns count + 1.",
    setup: [{ path: "src/boundary.js", content: "return count - 1;\n" }],
    solution: [{ path: "src/boundary.js", content: "return count + 1;\n" }],
    contextItems: [{ id: "goal-1", type: "goal", content: "Boundary correctness.", source: "user_goal", priority: 1 }],
    checks: {
      tests: [{ id: "spec", argv: ["node", "tests/spec.js"] }],
      completion: [{ kind: "file_contains", path: "src/boundary.js", needle: "count + 1" }],
    },
  };
}

function mutate(field: string, value: unknown): unknown {
  const document = structuredClone(minimalDocument()) as Record<string, unknown>;
  document[field] = value;
  return document;
}

function freshError(reasonHint: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof InvalidBenchmarkWorkloadError && (error as Error).message.includes(reasonHint);
}

test("a well-formed document parses to the validated workload shape", () => {
  const workload = parseBenchmarkWorkload(minimalDocument());
  assert.equal(workload.id, "issue-fix-boundary");
  assert.deepEqual([...workload.rules], []);
  assert.equal(workload.contextItems.length, 1);
  assert.equal(workload.testRuns[0].argv[0], "node");
});

test("explicit governance rules round-trip as GovernanceRule values", () => {
  const workload = parseBenchmarkWorkload(mutate("rules", [
    { ruleId: "drop-noise", priority: 10, scope: "context_type", contextType: "terminal_output", action: "DROP" },
    { ruleId: "keep-goal", priority: 5, scope: "item", itemId: "goal-1", action: "KEEP" },
  ]));
  assert.equal(workload.rules.length, 2);
  assert.equal(workload.rules[0].scope, "context_type");
  assert.equal(workload.rules[0].contextType, "terminal_output");
  assert.equal(workload.rules[1].itemId, "goal-1");
});

test("unknown top-level fields are rejected, not ignored", () => {
  const document = { ...structuredClone(minimalDocument()) as Record<string, unknown>, provider: "d1-2b" };
  assert.throws(() => parseBenchmarkWorkload(document), freshError("unknown workload field"));
});

test("schema version drift fails instead of silently accepting", () => {
  assert.throws(() => parseBenchmarkWorkload(mutate("schemaVersion", "2")), freshError("schemaVersion"));
});

test("unsafe workspace paths (escaping, hidden, traversal) are rejected", () => {
  assert.throws(
    () => parseBenchmarkWorkload(mutate("setup", [{ path: "../outside.js", content: "x\n" }])),
    freshError("path must be a safe relative workspace path"),
  );
  assert.throws(
    () => parseBenchmarkWorkload(mutate("setup", [{ path: ".hidden", content: "x\n" }])),
    freshError("path must be a safe relative workspace path"),
  );
  assert.throws(
    () => parseBenchmarkWorkload(mutate("setup", [{ path: "src/../evil.js", content: "x\n" }])),
    freshError("path must be a safe relative workspace path"),
  );
});

test("context types outside the experimental allowlist are rejected", () => {
  assert.throws(
    () => parseBenchmarkWorkload(mutate("contextItems", [{ id: "mem-1", type: "memory", content: "x" }])),
    freshError("experimental context type"),
  );
});

test("duplicate ids and duplicate setup paths fail explicitly", () => {
  assert.throws(
    () => parseBenchmarkWorkload(mutate("contextItems", [
      { id: "goal-1", type: "goal", content: "a" },
      { id: "goal-1", type: "task", content: "b" },
    ])),
    freshError("duplicate context item id"),
  );
  assert.throws(
    () => parseBenchmarkWorkload(mutate("setup", [
      { path: "src/a.js", content: "1\n" },
      { path: "src/a.js", content: "2\n" },
    ])),
    freshError("duplicate setup path"),
  );
});

test("rules stay inside what the MVP executes: KEEP/DROP only, scope-consistent", () => {
  assert.throws(
    () => parseBenchmarkWorkload(mutate("rules", [{ ruleId: "c", priority: 1, scope: "global", action: "COMPRESS" }])),
    freshError("COMPRESS"),
  );
  assert.throws(
    () => parseBenchmarkWorkload(mutate("rules", [{ ruleId: "g", priority: 1, scope: "global", itemId: "goal-1", action: "DROP" }])),
    freshError("must not carry itemId"),
  );
  assert.throws(
    () => parseBenchmarkWorkload(mutate("rules", [{ ruleId: "i", priority: 1.5, scope: "item", itemId: "goal-1", action: "KEEP" }])),
    freshError("priority must be an integer"),
  );
});

test("test invocations stay node-only and path-bounded", () => {
  assert.throws(() => parseBenchmarkWorkload(mutate("checks", {
    tests: [{ id: "spec", argv: ["sh", "-c", "node tests/spec.js"] }],
    completion: [],
  })), freshError("argv must start"));
  assert.throws(() => parseBenchmarkWorkload(mutate("checks", {
    tests: [{ id: "spec", argv: ["node"], cwd: "." }],
    completion: [],
  })), freshError("non-empty array"));
  assert.throws(() => parseBenchmarkWorkload(mutate("checks", {
    tests: [{ id: "spec", argv: ["node", "../tests/spec.js"], cwd: "." }],
    completion: [],
  })), freshError("argument"));
  assert.throws(() => parseBenchmarkWorkload(mutate("checks", {
    tests: [{ id: "spec", argv: ["node", "tests/spec.js"], cwd: ".." }],
    completion: [],
  })), freshError("cwd must be a safe relative path"));
});

test("completion checks are malformed or unknown without silent coercion", () => {
  assert.throws(() => parseBenchmarkWorkload(mutate("checks", {
    tests: [],
    completion: [{ kind: "file_contains", path: "src/boundary.js" }],
  })), freshError("non-empty needle"));
  assert.throws(() => parseBenchmarkWorkload(mutate("checks", {
    tests: [],
    completion: [{ kind: "file_absent", path: "src/boundary.js", needle: "x" }],
  })), freshError("must not carry a needle"));
  assert.throws(() => parseBenchmarkWorkload(mutate("checks", {
    tests: [],
    completion: [{ kind: "file_size", path: "src/boundary.js" }],
  })), freshError("file_contains or file_absent"));
});

test("context inputs respect the collection bounds instead of overflowing", () => {
  assert.throws(
    () => parseBenchmarkWorkload(mutate("contextItems", [
      { id: "goal-1", type: "goal", content: "a".repeat(10_000) },
      { id: "goal-2", type: "goal", content: "b".repeat(10_000) },
      { id: "goal-3", type: "goal", content: "c".repeat(10_000) },
      { id: "goal-4", type: "goal", content: "d".repeat(10_000) },
      { id: "goal-5", type: "goal", content: "e".repeat(10_000) },
    ])),
    freshError("maxTotalCharacters"),
  );
  assert.throws(
    () => parseBenchmarkWorkload(mutate("contextItems", [{ id: "goal-1", type: "goal", content: "x", priority: 1.5 }])),
    freshError("priority must be in"),
  );
});

test("invalid JSON reports invalid_json, not a partial workload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ecc-dataset-broken-"));
  let matched = false;
  try {
    await writeFile(join(directory, "broken.json"), "{ not json", { encoding: "utf8" });
    await loadBenchmarkWorkload(join(directory, "broken.json"));
  } catch (error) {
    matched = freshError("invalid_json")(error);
  }
  await rm(directory, { recursive: true, force: true });
  assert.strictEqual(matched, true);
});

test("dataset directories load deterministically and ids stay unique", async () => {
  const workloads = await loadBenchmarkDataset("benchmarks/coding");
  assert.equal(workloads.length, 3);
  const ids = workloads.map((workload) => workload.id);
  assert.deepEqual([...ids], [...ids].sort());
});

test("harness projections share the task and context with both modes; baselinePrompt carries all of it ungoverned", () => {
  const workload = parseBenchmarkWorkload(minimalDocument());
  const evaluationWorkload = toEvaluationWorkload(workload);
  const segment = evaluationWorkload.fixedSegments[0];
  assert.equal(segment.role, "user");
  assert.equal(segment.fixed, true);
  assert.equal(segment.content, workload.task);
  // baselinePrompt is the host-built ungoverned serialization required by the
  // harness contract: fixedSegments + EVERY validated context item, JSON
  // framing mirroring the adapter's prompt serialization, with no rule/scoring/
  // budget filtering applied.
  assert.equal(
    evaluationWorkload.baselinePrompt,
    JSON.stringify({ fixedSegments: evaluationWorkload.fixedSegments, contextItems: evaluationWorkload.contextItems }),
  );
  assert.ok(evaluationWorkload.baselinePrompt.includes(workload.task));
  assert.ok(evaluationWorkload.baselinePrompt.includes("Boundary correctness."));

  const config = toIntegrationConfig(workload, 4_096);
  assert.equal(config.ecc_curator.enabled, true);
  assert.equal((config.ecc_curator.rules ?? []).length, 0);
  assert.equal(config.ecc_curator.contextWindowTokens, 4_096);
});

test("workspaces materialize byte-exact under an isolated temp directory", async () => {
  const workload = parseBenchmarkWorkload(minimalDocument());
  const directory = await mkdtemp(join(tmpdir(), "ecc-dataset-ws-"));
  try {
    await materializeWorkspace(workload, directory);
    const content = await readFile(join(directory, "src/boundary.js"), "utf8");
    assert.equal(content, "return count - 1;\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the scripted solution passes completion checks; an unsolved workload fails", async () => {
  const solved = parseBenchmarkWorkload(mutate("checks", {
    tests: [],
    completion: [{ kind: "file_contains", path: "src/boundary.js", needle: "count + 1" }],
  }));
  const solvedDirectory = await mkdtemp(join(tmpdir(), "ecc-dataset-solved-"));
  const unsolvedDocument = structuredClone(mutate("solution", [])) as Record<string, unknown>;
  unsolvedDocument.checks = {
    tests: [],
    completion: [{ kind: "file_contains", path: "src/boundary.js", needle: "count + 1" }],
  };
  const unsolved = parseBenchmarkWorkload(unsolvedDocument);
  const unsolvedDirectory = await mkdtemp(join(tmpdir(), "ecc-dataset-unsolved-"));
  try {
    await materializeWorkspace(solved, solvedDirectory);
    const solvedOutcome = await runScriptedAgent(solved, solvedDirectory);
    assert.equal(solvedOutcome.taskCompleted, true);
    assert.deepEqual([solvedOutcome.testsPassed, solvedOutcome.testsTotal], [0, 0]);

    await materializeWorkspace(unsolved, unsolvedDirectory);
    const unsolvedOutcome = await runScriptedAgent(unsolved, unsolvedDirectory);
    assert.equal(unsolvedOutcome.taskCompleted, false);
  } finally {
    await rm(solvedDirectory, { recursive: true, force: true });
    await rm(unsolvedDirectory, { recursive: true, force: true });
  }
});

test("failing node test invocations are recorded, not swallowed", async () => {
  const failing = structuredClone(minimalDocument()) as Record<string, unknown>;
  failing.setup = [{ path: "src/boundary.js", content: "count + 1;\n" }, { path: "spec.js", content: "process.exitCode = 1;\n" }];
  failing.checks = { tests: [{ id: "always-fails", argv: ["node", "spec.js"] }], completion: [] };
  const failingWorkload = parseBenchmarkWorkload(failing);
  const directory = await mkdtemp(join(tmpdir(), "ecc-dataset-test-"));
  try {
    await materializeWorkspace(failingWorkload, directory);
    const results = await runTestRuns(failingWorkload, directory);
    assert.deepEqual(results.map((result) => ({ id: result.id, exitCode: result.exitCode })), [{ id: "always-fails", exitCode: 1 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file_absent completion holds when nothing wrote outside the fixture", async () => {
  const workload = parseBenchmarkWorkload(mutate("checks", {
    tests: [],
    completion: [{ kind: "file_absent", path: "src/scratch.js" }],
  }));
  const directory = await mkdtemp(join(tmpdir(), "ecc-dataset-absent-"));
  try {
    await materializeWorkspace(workload, directory);
    const results = await evaluateCompletionChecks(workload, directory);
    assert.deepEqual([...results], [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("test children never inherit the parent environment (no credential leak)", async () => {
  const previousSecret = process.env.ECC_TEST_PARENT_SECRET;
  process.env.ECC_TEST_PARENT_SECRET = "do-not-inherit";
  const document = structuredClone(minimalDocument()) as Record<string, unknown>;
  document.setup = [{
    path: "env-probe.js",
    content: "const keys = Object.keys(process.env).map((key) => key.toUpperCase());\nprocess.exitCode = keys.includes(\"ECC_TEST_PARENT_SECRET\") ? 7 : 0;\n",
  }];
  document.checks = { tests: [{ id: "env-probe", argv: ["node", "env-probe.js"] }], completion: [] };
  const workload = parseBenchmarkWorkload(document);
  const directory = await mkdtemp(join(tmpdir(), "ecc-dataset-env-"));
  try {
    await materializeWorkspace(workload, directory);
    const results = await runTestRuns(workload, directory);
    assert.deepEqual(results.map((result) => result.exitCode), [0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousSecret === undefined) {
      delete process.env.ECC_TEST_PARENT_SECRET;
    } else {
      process.env.ECC_TEST_PARENT_SECRET = previousSecret;
    }
  }
});

test("only ENOENT reads as absent: deep missing paths still satisfy file_absent", async () => {
  const workload = parseBenchmarkWorkload(mutate("checks", {
    tests: [],
    completion: [
      { kind: "file_absent", path: "deep/nested/scratch.js" },
      { kind: "file_contains", path: "deep/nested/scratch.js", needle: "anything" },
    ],
  }));
  const directory = await mkdtemp(join(tmpdir(), "ecc-dataset-absent-"));
  try {
    await materializeWorkspace(workload, directory);
    const results = await evaluateCompletionChecks(workload, directory);
    assert.deepEqual([...results], [true, false]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an existing directory is not absent; the unexpected read error is surfaced", async () => {
  // The setup path src/boundary.js materializes "src" as a directory, so both
  // checks target an existing non-file path: file_absent must not pass and
  // file_contains must not silently fail behind a bare boolean.
  const document = structuredClone(minimalDocument()) as Record<string, unknown>;
  document.checks = { tests: [], completion: [{ kind: "file_absent", path: "src" }] };
  const absentWorkload = parseBenchmarkWorkload(document);
  const containsDocument = structuredClone(document) as Record<string, unknown>;
  containsDocument.checks = { tests: [], completion: [{ kind: "file_contains", path: "src", needle: "count" }] };
  const containsWorkload = parseBenchmarkWorkload(containsDocument);
  const directory = await mkdtemp(join(tmpdir(), "ecc-dataset-dir-present-"));
  try {
    await materializeWorkspace(containsWorkload, directory);
    await assert.rejects(
      () => evaluateCompletionChecks(containsWorkload, directory),
      (error: unknown) => error instanceof UnexpectedWorkspaceReadError,
    );
    await assert.rejects(
      () => evaluateCompletionChecks(absentWorkload, directory),
      (error: unknown) => error instanceof UnexpectedWorkspaceReadError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolated workspaces never sit inside the repository checkout", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ecc-dataset-isolated-"));
  try {
    assert.equal(join(workspace, "").startsWith(join(process.cwd(), "")), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
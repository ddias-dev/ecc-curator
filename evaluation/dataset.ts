// ECC Curator - benchmark dataset loader, validation, and workload plumbing.
// Contract source: docs/BENCHMARK_DATASETS.md (this directory's dataset format),
// plus the harness contracts in ./harness.ts and the experimental integration
// contracts in ../experimental/adapter.ts (imported, never modified).
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums;
// runtime imports carry explicit extensions; type imports are `import type`.
//
// Scope and honesty constraints (docs/BENCHMARK_DATASETS.md):
// - This module loads/validates workloads and provides the plumbing to run them
//   deterministically offline: fixture materialization, scripted solution
//   application, restricted test invocations, and completion checks. It records
//   no measurements and invents no outcomes; measurements come only from harness
//   runs (evaluation/harness.ts + evaluation/runner.mjs).
// - All inputs must be network-free and credential-free: workspace fixtures are
//   inline in the dataset JSON, paths are restricted to safe relative paths, and
//   test invocations are restricted to argv starting with "node" (argv arrays,
//   never shell strings).
// - Workspaces must be materialized outside the repository; the loader returns
//   validated data only, and callers choose the isolated directory (the runner
//   uses os.tmpdir()). This module never touches the checkout.
//
// Decided (documented choices the docs leave open):
// - Dataset format: one JSON document per workload under benchmarks/, schema
//   version "1". Loader enforces the experimental adapter's collection bounds
//   (DEFAULT_CONTEXT_COLLECTION_LIMITS) as "bounded context inputs".
// - Governance rules accepted by the dataset are restricted to the actions the
//   MVP pipeline can execute (KEEP/DROP); COMPRESS/TRANSFORM rules are rejected
//   because they would be silently unexecuted.
// - Test invocations are argv arrays with argv[0] === "node" and safe relative
//   path arguments; a spawn timeout bounds each test run (default 30s).
// - A scripted reference agent (applyScriptedSolution + evaluate checks) exists
//   for plumbing validation only; real agent execution belongs to the host.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { EXPERIMENTAL_CONTEXT_TYPES, DEFAULT_CONTEXT_COLLECTION_LIMITS } from "../experimental/adapter.ts";
import type { EvaluationWorkload, EvaluationTaskOutcome } from "./harness.ts";

import type { ExperimentalContextInput, ExperimentalContextType, ExperimentalIntegrationConfig } from "../experimental/adapter.ts";
import type { GovernanceRule } from "../src/types/governance.ts";
import type { PromptSegment } from "../src/types/assembler.ts";

export type BenchmarkSchemaVersion = "1";

// Loader-owned typed error: every malformed dataset shape fails with an
// explicit reason, not a partial workload or a defaulted field.
export class InvalidBenchmarkWorkloadError extends Error {
  constructor(reason: string, workloadHint?: string) {
    super(`Invalid benchmark workload${workloadHint === undefined ? "" : ` ${workloadHint}`}: ${reason}`);
    this.name = "InvalidBenchmarkWorkloadError";
  }
}

// A safe id: the same shape the harness allows for result ids.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A safe workspace-relative path: id-shaped segments joined by "/" (e.g.
// "src/module.js"). No leading or trailing separators, and because no segment
// may start with "." a path can never contain ".." or a hidden path.
const PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export interface BenchmarkFixtureFile {
  path: string; // safe relative path inside the workload workspace
  content: string; // byte-exact fixture content (UTF-8)
}

export interface BenchmarkWorkloadDocument {
  schemaVersion: BenchmarkSchemaVersion;
  id: string; // unique within the dataset
  category: string; // free-form grouping (docs/EVALUATION.md benchmark categories)
  task: string; // the objective given to the agent in both modes
  setup: readonly BenchmarkFixtureFile[]; // starting-state files, materialized identically
  solution: readonly BenchmarkFixtureFile[]; // scripted reference-agent edits (plumbing only)
  contextItems: readonly ContextInputDocument[]; // bounded context inputs
  rules?: readonly BenchmarkRuleDocument[]; // governed-mode rules (KEEP/DROP only)
  checks: BenchmarkCheckDocument; // completion + test-run definitions
  notes?: string;
}

// Governance rules restricted to the actions the MVP pipeline executes.
// COMPRESS/TRANSFORM rule actions are rejected because the MVP would accept
// them and silently not execute them (docs/GOVERNOR_ALGORITHM.md: enabled
// decision kinds for the experimental adapter are KEEP/DROP only).
export interface BenchmarkRuleDocument {
  ruleId: string; // safe id, unique within the workload
  priority: number; // integer; lower wins within a scope level (GovernanceRule)
  scope: "item" | "context_type" | "global";
  itemId?: string; // required when scope === "item"
  contextType?: ExperimentalContextType; // required when scope === "context_type"
  action: "KEEP" | "DROP";
}

export interface ContextInputDocument {
  id: string;
  type: ExperimentalContextType; // restricted to the experimental allowlist
  content: string;
  source?: string;
  priority?: number; // [0, 1]
  pinned?: boolean;
}

export interface BenchmarkCheckDocument {
  tests: BenchmarkTestDocument[]; // runnable test harnesses for the fixture
  completion: BenchmarkCompletionDocument[]; // scripted-agent success checks
}

export interface BenchmarkTestDocument {
  id: string;
  argv: string[]; // argv array; argv[0] must be "node"
  cwd: string; // workspace-relative directory (default ".")
}

export interface BenchmarkCompletionDocument {
  kind: "file_contains" | "file_absent";
  path: string; // workspace-relative path
  needle?: string; // required for file_contains
}

// Validated, in-memory workload shape used by the runner.
export interface BenchmarkWorkload {
  schemaVersion: BenchmarkSchemaVersion;
  id: string;
  category: string;
  task: string;
  setup: readonly BenchmarkFixtureFile[];
  solution: readonly BenchmarkFixtureFile[];
  contextItems: readonly ExperimentalContextInput[];
  rules: readonly GovernanceRule[]; // governed-mode rules; empty when absent
  testRuns: readonly BenchmarkTestDocument[];
  completionChecks: readonly BenchmarkCompletionDocument[];
  notes?: string;
}

function require(condition: boolean, reason: string, workloadHint: string | undefined): void {
  if (!condition) {
    throw new InvalidBenchmarkWorkloadError(reason, workloadHint);
  }
}

function isSafeId(id: unknown, label: string, workloadHint: string | undefined): string {
  require(
    typeof id === "string" && ID_PATTERN.test(id),
    `${label} must match [A-Za-z0-9][A-Za-z0-9._-]*`,
    workloadHint,
  );
  return id as string;
}

function isSafePath(path: unknown, workloadHint: string | undefined): string {
  require(
    typeof path === "string" && PATH_PATTERN.test(path),
    "path must be a safe relative workspace path",
    workloadHint,
  );
  return path as string;
}

function parseContextItem(item: unknown, workloadHint: string | undefined): ExperimentalContextInput {
  require(item !== null && typeof item === "object" && !Array.isArray(item), "context item must be an object", workloadHint);
  const document = item as Record<string, unknown>;
  const id = isSafeId(document.id, "context item id", workloadHint);
  require(
    typeof document.type === "string" && EXPERIMENTAL_CONTEXT_TYPES.includes(document.type as ExperimentalContextType),
    "context item type must be an experimental context type",
    workloadHint,
  );
  require(typeof document.content === "string", "context item content must be a string", workloadHint);
  const input: ExperimentalContextInput = {
    id,
    type: document.type as ExperimentalContextType,
    content: document.content as string,
  };
  if (document.source !== undefined) {
    require(typeof document.source === "string" && document.source !== "", "context item source must be a non-empty string", workloadHint);
    input.source = document.source as string;
  }
  if (document.priority !== undefined) {
    require(
      typeof document.priority === "number" &&
        Number.isFinite(document.priority as number) &&
        (document.priority as number) >= 0 &&
        (document.priority as number) <= 1,
      "context item priority must be in [0, 1]",
      workloadHint,
    );
    input.priority = document.priority as number;
  }
  if (document.pinned !== undefined) {
    require(typeof document.pinned === "boolean", "context item pinned must be a boolean", workloadHint);
    input.pinned = document.pinned as boolean;
  }
  const allowedKeys = ["id", "type", "content", "source", "priority", "pinned"];
  for (const key of Object.keys(document)) {
    require(allowedKeys.includes(key), `unknown context item field: ${key}`, workloadHint);
  }
  return input;
}

export function parseBenchmarkWorkload(document: unknown): BenchmarkWorkload {
  require(document !== null && typeof document === "object" && !Array.isArray(document), "workload must be an object", undefined);
  const raw = document as Record<string, unknown>;
  require(raw.schemaVersion === "1", "schemaVersion must be \"1\"", undefined);

  const id = isSafeId(raw.id, "workload id", undefined);
  require(typeof raw.category === "string" && raw.category.length > 0, "category must be a non-empty string", id);
  require(typeof raw.task === "string" && raw.task.length > 0, "task must be a non-empty string", id);

  require(Array.isArray(raw.setup), "setup must be an array", id);
  const setup: BenchmarkFixtureFile[] = [];
  const setupPaths = new Set<string>();
  for (const entry of raw.setup as unknown[]) {
    require(entry !== null && typeof entry === "object" && !Array.isArray(entry), "setup entry must be an object", id);
    const file = entry as Record<string, unknown>;
    const path = isSafePath(file.path, id);
    require(!setupPaths.has(path), `duplicate setup path: ${path}`, id);
    setupPaths.add(path);
    require(typeof file.content === "string", "setup file content must be a string", id);
    const allowedKeys = ["path", "content"];
    for (const key of Object.keys(file)) {
      require(allowedKeys.includes(key), `unknown setup field: ${key}`, id);
    }
    setup.push({ path, content: file.content as string });
  }

  require(Array.isArray(raw.solution), "solution must be an array", id);
  const solution: BenchmarkFixtureFile[] = [];
  const solutionPaths = new Set<string>();
  for (const entry of raw.solution as unknown[]) {
    require(entry !== null && typeof entry === "object" && !Array.isArray(entry), "solution entry must be an object", id);
    const file = entry as Record<string, unknown>;
    const path = isSafePath(file.path, id);
    require(!solutionPaths.has(path), `duplicate solution path: ${path}`, id);
    solutionPaths.add(path);
    require(typeof file.content === "string", "solution file content must be a string", id);
    const allowedKeys = ["path", "content"];
    for (const key of Object.keys(file)) {
      require(allowedKeys.includes(key), `unknown solution field: ${key}`, id);
    }
    solution.push({ path, content: file.content as string });
  }

  require(Array.isArray(raw.contextItems), "contextItems must be an array", id);
  const contextItems: ExperimentalContextInput[] = [];
  const seenIds = new Set<string>(setupPaths);
  let totalCharacters = 0;
  for (const item of raw.contextItems as unknown[]) {
    require(contextItems.length < DEFAULT_CONTEXT_COLLECTION_LIMITS.maxItems, "contextItems exceed the collection maxItems limit", id);
    const input = parseContextItem(item, id);
    require(!seenIds.has(input.id), `duplicate context item id: ${input.id}`, id);
    seenIds.add(input.id);
    require(
      input.content.length <= DEFAULT_CONTEXT_COLLECTION_LIMITS.maxCharactersPerItem,
      `context item ${input.id} exceeds the maxCharactersPerItem limit`,
      id,
    );
    totalCharacters += input.content.length;
    contextItems.push(input);
  }
  require(
    totalCharacters <= DEFAULT_CONTEXT_COLLECTION_LIMITS.maxTotalCharacters,
    "context items exceed the collection maxTotalCharacters limit",
    id,
  );

  const rules: GovernanceRule[] = [];
  if (raw.rules !== undefined) {
    require(Array.isArray(raw.rules), "rules must be an array", id);
    const ruleIds = new Set<string>();
    for (const entry of raw.rules as unknown[]) {
      require(entry !== null && typeof entry === "object" && !Array.isArray(entry), "rule entry must be an object", id);
      const rule = entry as Record<string, unknown>;
      const ruleId = isSafeId(rule.ruleId, "rule id", id);
      require(!ruleIds.has(ruleId), `duplicate rule id: ${ruleId}`, id);
      ruleIds.add(ruleId);
      require(
        typeof rule.priority === "number" && Number.isSafeInteger(rule.priority as number),
        `rule ${ruleId} priority must be an integer`,
        id,
      );
      const scope = rule.scope;
      require(
        scope === "item" || scope === "context_type" || scope === "global",
        `rule ${ruleId} scope must be item, context_type, or global`,
        id,
      );
      const action = rule.action;
      require(
        action === "KEEP" || action === "DROP",
        `rule ${ruleId} action must be KEEP or DROP (COMPRESS/TRANSFORM are not executed by the MVP pipeline)`,
        id,
      );
      const governedRule: GovernanceRule = {
        ruleId,
        priority: rule.priority as number,
        scope: scope as "item" | "context_type" | "global",
        action: action as "KEEP" | "DROP",
      };
      if (scope === "item") {
        require(
          typeof rule.itemId === "string" && ID_PATTERN.test(rule.itemId as unknown as string),
          `rule ${ruleId} requires an itemId with a safe id shape`,
          id,
        );
        governedRule.itemId = rule.itemId as string;
        require(
          rule.contextType === undefined,
          `rule ${ruleId} must not carry contextType when scope is item`,
          id,
        );
      }
      if (scope === "context_type") {
        require(
          typeof rule.contextType === "string" &&
            EXPERIMENTAL_CONTEXT_TYPES.includes(rule.contextType as ExperimentalContextType),
          `rule ${ruleId} requires a contextType in the experimental context types`,
          id,
        );
        governedRule.contextType = rule.contextType as ExperimentalContextType;
        require(
          rule.itemId === undefined,
          `rule ${ruleId} must not carry itemId when scope is context_type`,
          id,
        );
      }
      if (scope === "global") {
        require(rule.itemId === undefined, `rule ${ruleId} must not carry itemId when scope is global`, id);
        require(rule.contextType === undefined, `rule ${ruleId} must not carry contextType when scope is global`, id);
      }
      const allowedKeys = ["ruleId", "priority", "scope", "itemId", "contextType", "action"];
      for (const key of Object.keys(rule)) {
        require(allowedKeys.includes(key), `unknown rule field: ${key}`, id);
      }
      rules.push(governedRule);
    }
  }

  require(raw.checks !== null && typeof raw.checks === "object" && !Array.isArray(raw.checks), "checks must be an object", id);
  const checks = raw.checks as Record<string, unknown>;
  require(Array.isArray(checks.tests), "checks.tests must be an array", id);
  require(Array.isArray(checks.completion), "checks.completion must be an array", id);

  const testRuns: BenchmarkTestDocument[] = [];
  const testIds = new Set<string>();
  for (const entry of checks.tests as unknown[]) {
    require(entry !== null && typeof entry === "object" && !Array.isArray(entry), "test entry must be an object", id);
    const test = entry as Record<string, unknown>;
    const testId = isSafeId(test.id, "test id", id);
    require(!testIds.has(testId), `duplicate test id: ${testId}`, id);
    testIds.add(testId);
    require(
      Array.isArray(test.argv) &&
        test.argv.length >= 2 &&
        test.argv.every((argument) => typeof argument === "string"),
      "test argv must be a non-empty array of strings",
      id,
    );
    const argv = test.argv as unknown as string[];
    require(argv[0] === "node", `test ${testId} argv must start with "node" (argv array only, no shell)`, id);
    for (const argument of argv.slice(1)) {
      require(
        argument === "." || PATH_PATTERN.test(argument as unknown as string),
        `test ${testId} argument ${String(argument)} must be a safe relative path`,
        id,
      );
    }
    let cwd = ".";
    if (test.cwd !== undefined) {
      require(
        test.cwd === "." || PATH_PATTERN.test(test.cwd as unknown as string),
        `test ${testId} cwd must be a safe relative path`,
        id,
      );
      cwd = test.cwd as string;
    }
    const allowedKeys = ["id", "argv", "cwd"];
    for (const key of Object.keys(test)) {
      require(allowedKeys.includes(key), `unknown test field: ${key}`, id);
    }
    testRuns.push({ id: testId, argv, cwd });
  }

  const completionChecks: BenchmarkCompletionDocument[] = [];
  const checkIds = new Set<string>();
  for (const entry of checks.completion as unknown[]) {
    require(entry !== null && typeof entry === "object" && !Array.isArray(entry), "completion entry must be an object", id);
    const check = entry as Record<string, unknown>;
    const kind = check.kind;
    require(kind === "file_contains" || kind === "file_absent", "completion kind must be file_contains or file_absent", id);
    const path = isSafePath(check.path, id);
    if (kind === "file_contains") {
      require(
        typeof check.needle === "string" && (check.needle as string).length > 0,
        `file_contains check for ${path} must carry a non-empty needle`,
        id,
      );
    } else {
      require(check.needle === undefined, "file_absent check must not carry a needle", id);
    }
    const checkId = `${String(kind)}:${path}`;
    require(!checkIds.has(checkId), `duplicate completion check: ${checkId}`, id);
    checkIds.add(checkId);
    const allowedKeys = ["kind", "path", "needle"];
    for (const key of Object.keys(check)) {
      require(allowedKeys.includes(key), `unknown completion field: ${key}`, id);
    }
    completionChecks.push(
      kind === "file_contains"
        ? { kind: "file_contains", path, needle: check.needle as string }
        : { kind: "file_absent", path },
    );
  }

  const workload: BenchmarkWorkload = {
    schemaVersion: "1",
    id,
    category: raw.category as string,
    task: raw.task as string,
    setup,
    solution,
    contextItems,
    rules,
    testRuns,
    completionChecks,
  };
  if (raw.notes !== undefined) {
    require(typeof raw.notes === "string", "notes must be a string", id);
    workload.notes = raw.notes as string;
  }
  const allowedKeys = ["schemaVersion", "id", "category", "task", "setup", "solution", "contextItems", "rules", "checks", "notes"];
  for (const key of Object.keys(raw)) {
    require(allowedKeys.includes(key), `unknown workload field: ${key}`, id);
  }
  return workload;
}

function parseJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidBenchmarkWorkloadError("invalid_json: workload file is not valid JSON", undefined);
  }
}

export async function loadBenchmarkWorkload(filePath: string): Promise<BenchmarkWorkload> {
  const text = await readFile(filePath, "utf8");
  return parseBenchmarkWorkload(parseJsonDocument(text));
}

// Walks the benchmark tree (docs/EVALUATION.md "Benchmark Dataset Structure")
// so category subdirectories group workloads without a loader manifest.
// Determinism: directories and files are visited in name-sorted order.
async function collectWorkloadFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry === null) {
      continue;
    }
    const entryName = entry.name;
    const entryPath = join(directory, entryName);
    if (entry.isDirectory()) {
      paths.push(...await collectWorkloadFiles(entryPath));
    } else if (entry.isFile() && entryName.endsWith(".json")) {
      paths.push(entryPath);
    }
  }
  return paths;
}

export async function loadBenchmarkDataset(datasetDirectory: string): Promise<BenchmarkWorkload[]> {
  const workloadPaths = (await collectWorkloadFiles(datasetDirectory)).sort();
  require(workloadPaths.length > 0, "dataset directory contains no *.json workload files", undefined);
  const workloads: BenchmarkWorkload[] = [];
  const seenIds = new Set<string>();
  for (const workloadPath of workloadPaths) {
    const workload = await loadBenchmarkWorkload(workloadPath);
    require(!seenIds.has(workload.id), `duplicate workload id across dataset: ${workload.id}`, undefined);
    seenIds.add(workload.id);
    workloads.push(workload);
  }
  return workloads;
}

// Projection into the harness contract (evaluation/harness.ts). The same task
// text feeds baselinePrompt and the fixed "user" segment so both modes receive
// the identical objective; contextItems and rules are mode-independent inputs.
export function toEvaluationWorkload(workload: BenchmarkWorkload): EvaluationWorkload {
  return {
    id: workload.id,
    baselinePrompt: workload.task,
    fixedSegments: [{ id: "task-instructions", role: "user", content: workload.task, fixed: true, order: 0 }],
    contextItems: workload.contextItems,
  };
}

// Governed-mode config for the harness: the dataset's KEEP/DROP rules plus an
// optional bounded window. The harness re-spreads enabled itself.
export function toIntegrationConfig(
  workload: BenchmarkWorkload,
  contextWindowTokens?: number,
): ExperimentalIntegrationConfig {
  return {
    ecc_curator: {
      enabled: true,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      rules: workload.rules,
    },
  };
}

function parentDirectory(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator < 0 ? "." : filePath.slice(0, separator);
}

async function writeWorkspaceFile(workspaceDirectory: string, file: BenchmarkFixtureFile): Promise<void> {
  const target = join(workspaceDirectory, file.path);
  const parent = parentDirectory(join(workspaceDirectory, file.path));
  if (parent !== workspaceDirectory) {
    await mkdir(parent, { recursive: true });
  }
  await writeFile(target, file.content, { encoding: "utf8" });
}

// Starting state, materialized byte-for-byte into an isolated workspace
// (callers create the directory; the runner uses os.tmpdir()).
export async function materializeWorkspace(workload: BenchmarkWorkload, workspaceDirectory: string): Promise<void> {
  await mkdir(workspaceDirectory, { recursive: true });
  for (const file of workload.setup) {
    await writeWorkspaceFile(workspaceDirectory, file);
  }
}

// The scripted reference agent: applies the dataset's declared edits, then
// scores completion and test checks. This validates the plumbing only; it is
// not a real coding-agent run and must never be reported as benchmark
// evidence about model behaviour (docs/BENCHMARK_DATASETS.md).
export async function runScriptedAgent(workload: BenchmarkWorkload, workspaceDirectory: string): Promise<EvaluationTaskOutcome> {
  for (const file of workload.solution) {
    await writeWorkspaceFile(workspaceDirectory, file);
  }
  const completionPassed = (await evaluateCompletionChecks(workload, workspaceDirectory)).every((passed) => passed);
  const testResults = await runTestRuns(workload, workspaceDirectory);
  const testsTotal = testResults.length;
  const testsPassed = testResults.filter((result) => result.exitCode === 0).length;
  return {
    taskCompleted: completionPassed && (testsTotal === 0 || testsPassed === testsTotal),
    testsPassed,
    testsTotal,
    retries: 0,
    errors: 0,
  };
}

// Runs the dataset's test invocations in the workspace. argv arrays only,
// argv[0] === "node", bounded by a spawn timeout; no shell, no network.
export async function runTestRuns(
  workload: BenchmarkWorkload,
  workspaceDirectory: string,
  timeoutMs = 30_000,
): Promise<BenchmarkTestResult[]> {
  require(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "timeoutMs must be a positive safe integer",
    undefined,
  );
  const results: BenchmarkTestResult[] = [];
  for (const testRun of workload.testRuns) {
    const cwd = testRun.cwd === "." ? workspaceDirectory : join(workspaceDirectory, testRun.cwd);
    const spawned = spawnSync(testRun.argv[0], testRun.argv.slice(1), { cwd, timeout: timeoutMs });
    results.push({
      id: testRun.id,
      // @types/node names the exit status `status`; a spawn failure or a
      // signal-terminated run has no status and is recorded as -1 (a failure).
      exitCode: spawned.status ?? -1,
      signal: spawned.signal ?? null,
      stdout: String(spawned.stdout ?? ""),
      stderr: String(spawned.stderr ?? ""),
    });
  }
  return results;
}

export interface BenchmarkTestResult {
  id: string;
  exitCode: number; // process exit code; -1 when the spawn produced none
  signal: string | null; // termination signal, if any
  stdout: string;
  stderr: string;
}

export async function evaluateCompletionChecks(
  workload: BenchmarkWorkload,
  workspaceDirectory: string,
): Promise<readonly boolean[]> {
  const results: boolean[] = [];
  for (const check of workload.completionChecks) {
    const target = join(workspaceDirectory, check.path);
    let content: string | null = null;
    try {
      content = await readFile(target, "utf8");
    } catch {
      content = null;
    }
    if (check.kind === "file_absent") {
      results.push(content === null);
      continue;
    }
    results.push(content !== null && check.needle !== undefined && content.includes(check.needle as string));
  }
  return results;
}

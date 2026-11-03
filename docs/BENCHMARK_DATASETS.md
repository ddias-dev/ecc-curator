# Benchmark Datasets

> Datasets and runner plumbing exist and have been exercised offline; no
> outcome-improvement or savings claim is established (see
> [Evaluation Framework](EVALUATION.md)).

This document defines the benchmark dataset format (`evaluation/dataset.ts`
validates it; `evaluation/runner.mjs` runs it) and how paired baseline-versus-
governed comparisons are produced and read.

## Scope

- **Dataset**: small, versioned, reproducible workload documents under
  `benchmarks/` (schemaVersion `"1"`). Each workload specifies a task, bounded
  context inputs, a starting state (`setup`), a scripted reference solution
  (`solution`), and objective completion/test checks (`checks`).
- **Offline and credential-free**: fixture contents are inline in the JSON,
  test invocations are argv arrays restricted to `node`, and no network or
  external service is contacted.
- **Isolation**: workspaces materialize under the OS temp directory
  (`runner.mjs` uses `os.tmpdir()`), never in the repository checkout, so runs
  cannot alter the working tree. Baseline and governed runs get separate fresh
  workspaces.

## Workload document

One JSON file per workload; subdirectories group categories
(`benchmarks/coding/…` today). Unknown fields are rejected rather than ignored.

```json
{
  "schemaVersion": "1",
  "id": "issue-fix-boundary",
  "category": "coding/issue-fix",
  "task": "Fix src/boundary.js so boundarySize returns count + 1.",
  "setup": [{ "path": "src/boundary.js", "content": "..." }],
  "solution": [{ "path": "src/boundary.js", "content": "..." }],
  "contextItems": [
    { "id": "goal-1", "type": "goal", "content": "...", "source": "user_goal", "priority": 1, "pinned": false }
  ],
  "rules": [
    { "ruleId": "drop-terminal-noise", "priority": 10, "scope": "context_type", "contextType": "terminal_output", "action": "DROP" }
  ],
  "checks": {
    "tests": [{ "id": "spec", "argv": ["node", "tests/spec.js"], "cwd": "." }],
    "completion": [{ "kind": "file_contains", "path": "src/boundary.js", "needle": "count + 1" }]
  },
  "notes": "Synthetic fixture; scripted solution validates plumbing only."
}
```

Decisions the loader locks in (documented so runs stay reproducible):

- `contextItems` types are restricted to the experimental adapter allowlist
  (`goal`, `task`, `file`, `diff`, `terminal_output`, `tool_output`,
  `test_result`, `plan`) and are bounded by the adapter's collection limits
  (64 items, 10 000 chars per item, 40 000 total) — inputs that would silently
  truncate or drop are rejected at load time.
- Rule actions are restricted to `KEEP`/`DROP`: the MVP Governor executes only
  those, so `COMPRESS`/`TRANSFORM` rules would be silently unexecuted.
- Test invocations are argv arrays with `argv[0] === "node"` and safe relative
  path arguments, each bounded by a spawn timeout (default 30 s).
- Completion checks are limited to `file_contains`/`file_absent` on safe
  workspace-relative paths.
- Workspace paths are id-shaped segments joined by `/` (no `..`, no leading
  dot, no absolute paths).

## Running a paired comparison

```text
node evaluation/runner.mjs [datasetDir] [outputDir] [resultTag]
# defaults: benchmarks  evaluation  paired
```

For each workload the runner:

1. materializes a fresh isolated workspace under `os.tmpdir()` and applies the
   dataset's scripted `solution`, then scores completion checks and node test
   runs — for **baseline** and **governed** modes separately;
2. feeds the workload into `compareEvaluationWorkload`
   (`evaluation/harness.ts`), which runs baseline first, governed second, over
   the same task and context inputs;
3. writes `evaluation/<workload-id>-<tag>.json` via
   `saveEvaluationComparison` (existing files are never overwritten; re-run
   with a new tag rather than editing a saved result).

Measurements in the saved comparison (prompt/context tokens, items kept/dropped,
test tallies, session durations, utilisation) come from those actual runs.
Record the run tag, Node version, and dataset state alongside any comparison so
it stays reproducible.

## Reading results honestly

The runner's agent is **scripted**: it applies the dataset's declared solution
instead of executing a real coding agent or model. What the current runs
therefore establish:

- the dataset loads and validates, and the harness records real pipeline
  measurements around both modes (bounded inputs, kept/dropped items, prompt and
  context token counts);
- the paired plumbing produces comparable result documents.

What they do **not** establish: anything about model behaviour, task-quality
improvement, token savings, or context-window headroom. Replacing
`runScriptedAgent` with a host-agent callback is the future real-workload path;
Phase 5 measurements (repeated agent runs, resource profiles, provider
comparisons) remain future work.

## Known limitations

- **Nondeterminism**: real agent/model runs are not deterministic; one
  repetition is not comparable across releases. Repeat runs need an agreed
  repetition count and recorded model/runtime settings.
- **Workspace and order effects**: harness runs baseline first and governed
  second; the harness does not randomize order or reset workspaces itself — the
  runner creates fresh workspaces per mode, and any state an agent inherits from
  the environment must be recorded for comparisons to hold.
- **Fixture realism**: current fixtures are synthetic and small; they exercise
  the governed DROP rules, not long-session saturation. Larger 64K/128K and
  local-model workloads remain unrun.
- **Estimator drift**: token figures use the deterministic conservative
  estimator, not model-exact counts.

## Files

- `evaluation/dataset.ts` — loader, validation, harness projections, isolated-
  workspace plumbing (unit tests: `tests/dataset.test.ts`)
- `evaluation/runner.mjs` — paired dataset runner (writes results to
  `evaluation/`)
- `benchmarks/**` — workload documents

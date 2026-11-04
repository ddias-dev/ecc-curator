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
- **Credential-free plumbing**: fixture contents are inline in the JSON and
  test invocations are argv arrays restricted to `node`. Test children are
  spawned with the parent environment replaced (empty `env`, so parent
  credentials like API keys, tokens, proxies, `NODE_OPTIONS`/`NODE_PATH` are
  never inherited; Windows contributes a system-minimal credential-free set
  such as `PATH`/`SYSTEMROOT`), and `argv[0] === "node"` runs as the
  interpreter that loaded the runner (`process.execPath`). The loader and
  runner themselves contact no network.
- **Trust boundary — not a sandbox**: a workload's test scripts are Node
  programs materialized from its `setup` files and executed as written, so
  running a dataset executes arbitrary code supplied by the dataset. There is
  no stable, cross-platform filesystem/network sandbox for child processes
  across supported Node versions (24+), so **datasets and their test scripts
  must be trusted inputs** (reviewed before they enter `benchmarks/`). "Offline"
  here describes the plumbing and the fixtures' intent, not an enforced
  confinement of what a dataset's scripts may do.
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
  path arguments, each bounded by a spawn timeout (default 30 s). `argv[0]`
  "node" executes as the Node binary running the runner (`process.execPath`)
  with an empty child environment; the resulting child process is credential-
  free but not confined (see the trust boundary above).
- Completion checks are limited to `file_contains`/`file_absent` on safe
  workspace-relative paths. A missing path (ENOENT) is the only "absent"
  result; any other read failure (an existing directory, an unreadable entry)
  surfaces as `UnexpectedWorkspaceReadError` instead of counting as absent.
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
improvement, token savings, or context-window headroom. The real-workload path
exists but is strictly opt-in (below, "Real-agent opt-in path"): running a real
agent is the user's decision, and Phase 5 measurements (repeated real-agent
runs, resource profiles, provider comparisons) remain future work.

## Real-agent opt-in path

`evaluation/real-agent.ts` + `evaluation/runner-real.mjs` run the same bounded
workloads with a **user-supplied real coding-agent callback** instead of the
scripted reference agent. Nothing in ECC Curator invokes a model or agent
runtime on its own: the runner refuses to start unless the user passes an
explicit `--agent <path>` naming a module they wrote and reviewed, and the
contract is provider-neutral (no vendor, model, or runtime is imported or
assumed).

```text
node evaluation/runner-real.mjs --agent <agentModulePath> [datasetDir] [outputDir] [resultTag]
# defaults:      (required)      benchmarks  evaluation  real
```

The agent module must export `runAgent`:

```js
// agent.mjs - user-supplied; trusted, NOT sandboxed; review before wiring in.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function runAgent(request) {
  // request = { workloadId, mode: "baseline" | "governed", prompt,
  //             workspaceDirectory }
  // Launch your coding agent against request.workspaceDirectory using
  // request.prompt (raw task prompt in baseline; assembled governed package
  // in governed). Optionally return { retries, errors } counts the agent
  // observed (non-negative integers; the harness validates them).
}
```

Per mode the path guarantees:

- a **fresh, separate workspace** under `os.tmpdir()` (mode-named), holding ONLY
  the dataset's `setup` files; the workload's scripted `solution` is never
  applied in real-agent mode, and the workspace is removed after the run;
- the callback receives the mode-appropriate prompt plus workload id, mode, and
  workspace path, and the **existing** harness (`compareEvaluationWorkload`)
  records prompt/context tokens, items kept/dropped, test tallies, reported
  retries/errors, and durations — no parallel evaluation framework;
- after the callback returns, the SAME objective checks as the scripted path
  (`scoreWorkspace`: completion checks + node test runs) decide task
  completion; the agent's self-report is not trusted for completion or tests;
- a callback exception is recorded as a failed run (one error, `errorStage`
  `agent`) so the paired run continues — consistent with scripted harness
  behaviour; an invalid retries/errors report rejects with
  `InvalidEvaluationOutcomeError`.

Results save as `<workload-id>-<tag>.json` (default tag `real`; scripted runs
use `paired`), so the run mode is identifiable from the filename and results
never overwrite each other.

Interpreting real results honestly:

- Real results measure what the user's callback actually did; scripted results
  measure plumbing only. Never present a real-versus-scripted difference as an
  improvement.
- Record for every real run: agent name/version, runtime, model build and
  settings, dataset state, Node version, run tag, execution order (baseline
  runs first, governed second — the harness does not randomize order), and
  repetition count. One run proves nothing: real agent/model runs are
  nondeterministic, and conclusions need repeated same-configuration samples
  with the sample size reported.
- The callback and the dataset's test scripts execute arbitrary trusted code.
  Replacing child-process environments bounds credential inheritance only; it
  is **not** sandboxing. Never wire in unreviewed callbacks or datasets.

## Known limitations

- **Trusted datasets only / no process isolation**: test runs execute the
  Node scripts dataset `setup` files materialize, i.e. arbitrary dataset-
  supplied code that can read/write the filesystem and contact the network.
  The empty child environment bounds credential inheritance, but nothing
  confines the scripts themselves (Node 24+ offers no stable, cross-platform
  child-process sandbox to claim as secure). Never run unreviewed third-party
  datasets; results from such runs are untrustworthy at best.
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
  workspace plumbing, and the shared check scoring `scoreWorkspace` (unit
  tests: `tests/dataset.test.ts`)
- `evaluation/runner.mjs` — paired dataset runner, scripted reference agent
  (writes results to `evaluation/`)
- `evaluation/real-agent.ts` — opt-in real-agent callback contract and
  harness-compatible execute factory (unit tests:
  `tests/real-agent.test.ts`)
- `evaluation/runner-real.mjs` — opt-in paired runner requiring an explicit
  `--agent` module (never runs a model/runtime by itself)
- `benchmarks/**` — workload documents

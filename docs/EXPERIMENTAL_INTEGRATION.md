# Experimental ECC Curator Integration

> This integration is for local development, validation, benchmarking, research, and dogfooding only. It is not production-ready, is not enabled by default, and does not guarantee improvement.

## Architecture

The Claude Code adapter uses a `UserPromptSubmit` hook to append selected, governed project context to the user's prompt. Claude Code continues to own the conversation and model call; ECC Curator does not replace Claude's prompt, intercept internal agent turns, or change model routing:

```text
Claude Code user prompt
    ↓ UserPromptSubmit hook
Explicit project context sources
    ↓ when .claude/ecc-curator.json enables it
Inventory → Token Estimation → Rule Engine → Scoring → Governor → Prompt Assembler
    ↓ hook additionalContext
Claude Code → configured LLM
```

The global hook registration is in `%USERPROFILE%\.claude\settings.json`; its command points to `experimental/claude-code-hook.mjs` in this checkout. The hook is inert in projects without a `.claude/ecc-curator.json`, or when that file sets `ecc_curator.enabled` to `false`. It reads only the explicitly configured context sources and the current user prompt, runs `src/pipeline/run.ts`, and returns governed context using Claude Code's `UserPromptSubmit` `additionalContext` output.

The pre-existing ECC npm package is not modified. The hook script is stored in this repository; if the checkout moves, update its absolute path in Claude settings.

## Installed setup

1. Register the hook once in `%USERPROFILE%\.claude\settings.json`:

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\ddias-dev\\ecc-curator\\experimental\\claude-code-hook.mjs\"",
               "timeout": 10
             }
           ]
         }
       ],
       "PreCompact": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\ddias-dev\\ecc-curator\\experimental\\claude-code-hook.mjs\"",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

   Merge this into existing settings; do not replace the file. The hook script is a no-op unless a project config enables it.

2. In a project where you want the experiment, create `.claude/ecc-curator.json`:

   ```json
   {
     "ecc_curator": {
       "enabled": true,
       "contextWindowTokens": 65536,
       "outputReserveTokens": 4096,
       "safetyMarginTokens": 512,
       "maxItems": 24,
       "maxCharactersPerItem": 8000,
       "maxTotalCharacters": 16000,
       "rules": []
     },
     "context": {
       "includeGitDiff": true,
       "files": ["README.md", "docs/ARCHITECTURE.md"],
       "items": []
     },
     "logging": {
       "enabled": false
     }
   }
   ```

   Set budgets to the local model's actual limits. `includeGitDiff` adds the current tracked working-tree diff against `HEAD`; `files` is an explicit relative-path allowlist, and `items` can contain selected goals, plans, test results, terminal output, or tool output:

   ```json
   {
     "context": {
       "items": [
         {
           "id": "latest-tests",
           "type": "test_result",
           "content": "npm test: 115 passed, 0 failed",
           "source": "operator"
         }
       ]
     }
   }
   ```

   Files must remain inside the project directory and be no larger than 256 KiB before the adapter applies character limits.

3. Restart Claude Code, run `/hooks` to confirm `UserPromptSubmit` is registered, and send a prompt in the enabled project. The hook appends only context items kept by governance; the user's prompt remains Claude Code's original prompt.

4. To disable the experiment for a project, set `"enabled": false` in its `.claude/ecc-curator.json`. To disable it globally, remove only the ECC Curator `UserPromptSubmit` entry from Claude settings. Preserve the existing model, environment, plugin, and permissions settings.

This checkout has the experiment enabled with a bounded Git diff and two explicitly selected files. Other projects remain unchanged until they add their own config.

## Opt-in metadata log

Logging is separate from context governance and is **off by default**. To enable it in one project, set:

```json
{
  "logging": {
    "enabled": true
  }
}
```

The global `UserPromptSubmit` and `PreCompact` hooks use the same project-local setting. Events append to `.claude/logs/ecc-curator.jsonl`; logs are git-ignored. The active log is capped at 1 MiB and rotates once to `ecc-curator.jsonl.1`, replacing the previous rotated file. Disable logging by setting `enabled` to `false`; remove the two ECC Curator hook entries from personal Claude settings to disable the hook globally.

Each `UserPromptSubmit` event records only timestamp, status, duration, context-type counts, collected/truncated/dropped counts, governance action totals, assembled-item counts, and estimated injected character/byte/token sizes. `PreCompact` records only the event and normalized trigger (`manual`, `auto`, or `unknown`). Hook errors record the stage, not the exception message.

The log does **not** contain prompt text, context or diff contents, item IDs, file paths, rule IDs, session IDs, transcript paths, or raw error details. Metadata can still reveal activity patterns and approximate context size, so keep it local and delete the log when no longer needed. No entries are written while logging is disabled. A log-write failure is reported on stderr and does not suppress otherwise valid governed context.

## Toggle and programmatic adapter

The programmatic adapter takes a TypeScript object:

```ts
const config = { ecc_curator: { enabled: false } };
```

The Claude hook reads JSON from `.claude/ecc-curator.json`; it does not parse YAML or search global config paths. If programmatic limits are omitted, bounded defaults are 64 items, 10,000 characters per item, and 40,000 total characters. The default budget is a 32,768-token window, 2,048 output-reserve tokens, and a 512-token safety margin. The Claude config sets explicit local-model limits. Token counts are estimates, not the local model tokenizer.

## Context collected

The hook treats the current user prompt as a pinned task for budgeting, then processes configured inline items, selected files, and—only when `includeGitDiff` is true—the tracked Git diff. It does not scan the transcript, all files, terminal history, or tool history.

| Context | Type | Source |
|---|---|---|
| Goals | `goal` | Explicit `context.items` |
| Tasks | `task` | Current prompt / explicit `context.items` |
| Files | `file` | Explicit `context.files` |
| Diffs | `diff` | Opt-in `includeGitDiff` |
| Terminal output | `terminal_output` | Explicit `context.items` |
| Tool output | `tool_output` | Explicit `context.items` |
| Test results | `test_result` | Explicit `context.items` |
| Plans | `plan` | Explicit `context.items` |

The current prompt is not echoed in `additionalContext` because Claude already received it. Other context types are excluded. Items are bounded by count and characters; oversized items are truncated, and excessive items are dropped. Avoid secrets and irrelevant content in selected files and diffs.

If configuration or curation fails, the hook writes a diagnostic to stderr and Claude continues with its original prompt and no added context. A Git diff collection error is reported to stderr; other explicitly configured context sources can still be governed.

Collected records are added through the existing Inventory API by `runPipeline`. The deterministic rule, scoring, and Governor path supports `KEEP` and `DROP`; compression and transformation are not executed. The hook appends kept context as JSON `additionalContext`.

## Evaluation workflow

Use `compareEvaluationWorkload` in `evaluation/harness.ts` to run a paired comparison:

```ts
const result = await compareEvaluationWorkload(
  {
    id: "task-001",
    baselinePrompt: hostBuiltPromptWithAllContext,
    fixedSegments,
    contextItems,
  },
  config,
  async (prompt, mode, workloadId) => runAgent(prompt, { mode, workloadId }),
);

await saveEvaluationComparison(result, "task-001-run-001");
```

The harness runs baseline first and governed second, passing the same workload ID and task context to the same callback. The host must build the baseline prompt from the same fixed instructions/task and include the full supplied context; use the same agent/model settings and a clean, equivalent workspace for each run. The harness does not randomize run order or reset workspaces.

Call `saveEvaluationComparison` to write the result to `evaluation/<result-id>.json`. Result IDs are restricted to safe filename characters, existing files are not overwritten, and stored results contain measurements—not prompts or raw context. The harness does not save results unless explicitly called.

## Measurements

Each run records:

- Prompt tokens and context tokens (deterministic estimates)
- Items kept and dropped (baseline retains all supplied items; governed counts items in the assembled package)
- Task completed, tests passed/total, retries, errors, and whether an error occurred in the agent or curator
- End-to-end run duration, including curation and the agent callback
- Prompt and context utilization as token counts divided by configured context-window tokens

Test pass rate is `null` when the run reports zero tests. Agent callback exceptions are recorded as failed runs with one error so the paired run can continue. Curator failures are also recorded; prompt/context/item measurements are `null` when curation fails before a prompt is sent. Detailed exception text and prompts are not persisted. Outcomes are supplied by the host and are not independently verified by the harness.

These are measurements only. A single comparison cannot establish task success rate, productivity, quality, reasoning, or causation. Repeat across identical workloads and report sample size and the exact host/model/runtime configuration before making conclusions.

## Known limitations and exclusions

- Experimental only; disabled by default and not production-ready.
- No general-purpose YAML loader or full Claude Code/ECC Harness replacement.
- The Claude hook runs only at `UserPromptSubmit`; it does not govern autonomous follow-up turns, tool calls, or the complete accumulated conversation context.
- Terminal/tool output and test results are not collected automatically; add only selected results through `context.items`.
- No LiquidAI/d1-2B, Jev, decision providers, compression providers, transformation providers, retrieval, durable memory, agent handoff, or model escalation.
- Inventory is in-memory and scoped to one pipeline invocation.
- The default token estimate is approximate, not a model tokenizer.
- The hook uses Claude Code's `additionalContext` output and does not alter model selection or the local LLM endpoint.
- Truncation and deterministic rules can remove useful information; there is no quality guarantee.
- Baseline/governed execution order effects, model nondeterminism, and workspace differences are not controlled automatically.

# Agent Execution Rules

> Operational guidance for long-running coding agents working on ECC Curator and future ECC ecosystem repositories. These rules describe agent behavior; they are not runtime capabilities implemented by ECC Curator.

This guidance applies to Claude Code, Copilot Agent, OpenCode, Codex, Aider, and future ECC Harness integrations. Adapt the mechanics to the agent's available tools without weakening the context-survival objectives.

## Objective

Prevent context-window saturation and repeated autocompaction while preserving enough information to complete the current work. Token reduction is not the goal; reliable task completion within a finite context budget is.

The working loop is:

```text
Goal
  ↓
Task
  ↓
Micro task
  ↓
Execute
  ↓
Summarise
  ↓
Archive
  ↓
Next micro task
```

Avoid carrying large plans, completed implementation history, raw tool output, and unrelated files into the next micro task.

## Context Retrieval Rule

Prefer retrieving repository context when needed over retaining it indefinitely:

```text
Retrieve
  → Use
  → Summarise
  → Drop
```

Do not use this pattern:

```text
Retrieve
  → Retain Forever
```

Apply these rules:

- The repository is the source of truth for implementation, documentation, and current project state.
- Working memory is temporary and should contain only what is needed for the active micro task.
- Prefer retrieval on demand over retaining large file contents, tool output, or completed-work details.
- Represent completed work through repository state, the progress ledger, and a concise micro-task summary—not conversation history.
- Keep decisions needed for future work in an appropriate repository artifact or ledger; do not rely on conversation history as the only record.

## Repository Navigation

Use progressively broader inspection. Search before reading; inspect symbols before whole files; inspect files before directories; inspect directories before scanning repositories.

Preferred order:

```text
Search
  → Symbol
  → Function
  → Class
  → File Section
  → Full File
```

Rules:

- Search for a symbol, behavior, or relevant term before opening source.
- Read the smallest relevant symbol or bounded section first.
- Expand inspection only when dependencies or behavior require it.
- Avoid full-repository scans whenever a targeted search can answer the question.
- Do not load an entire large file when a relevant function, class, interface, or 100–200 line chunk is sufficient.
- Retrieve additional files on demand instead of keeping them all active.

## Active work limits

### One active goal, task, and micro task

At any time, keep no more than:

```text
1 Goal
1 Task
1 Active Micro Task
```

For example:

```text
Goal: Build the ECC Curator MVP
Task: Implement the Context Inventory
Micro task: Implement ContextInventory.add()
```

Do not keep multiple active tasks such as implementing the inventory, Governor, assembler, tests, and refactoring at once. Decompose work until one micro task can be completed in a focused implementation cycle.

### Micro task size

Before starting, estimate the scope. A micro task may cover at most one:

- File
- Class
- Interface
- Function group

Examples:

```text
Implement ContextInventory.add()
Add InventoryEvent types
```

Tasks such as “implement the Inventory subsystem” or “implement context governance” exceed this limit and must be split before execution.

### Active file limit

Keep at most three source files active at once, normally:

- The file being changed
- A directly required dependency
- An interface or test file needed for the current micro task

Retrieve other files on demand instead of retaining them in the working set.

## Working-set budget

Use the following fixed allocation as an operational planning target:

```yaml
working_set:
  goal:
    max_tokens: 500
  active_task:
    max_tokens: 1000
  active_micro_task:
    max_tokens: 1000
  active_file_context:
    max_tokens: 4000
  progress_ledger:
    max_tokens: 500
  reserve:
    max_tokens: 2000
```

Keep only the current goal, task, micro task, required file context, progress ledger, and reserve in active working context. Summarise, archive, or drop other material. These are working limits, not claims about exact tokenizer accounting or a runtime-enforced quota.

Before adding context, ask:

```text
Do I need this to complete the current micro task?
```

If not, summarise it, archive it for retrieval, or drop it.

## Context Pressure Levels

Estimate working-context usage against the agent's usable context budget. Use the same estimate consistently within a session; exact tokenizer-level measurement is not required.

```yaml
green:
  usage: <60%
yellow:
  usage: 60-80%
orange:
  usage: 80-90%
red:
  usage: >90%
```

Interpret the boundaries as green below 60%, yellow from 60% up to but not including 80%, orange from 80% through 90%, and red above 90%.

Required behavior:

- **Green:** Continue the active micro task. Keep retrieval and summaries focused.
- **Yellow:** Avoid optional file reads and verbose plans. Summarise disposable output promptly and prepare the next ledger update.
- **Orange:** Do not start another micro task. Reduce active file context, drop raw output and superseded planning, and produce a concise progress summary before continuing.
- **Red:** Stop reading files and stop implementation. Summarise active work, update the progress ledger, and reduce the active set. Resume only after cleanup brings estimated usage below the red level; retrieve needed files again on demand.

If usage cannot be estimated reliably, treat repeated compaction or an imminent context limit as orange or red and follow the corresponding cleanup behavior.

## Micro Task Lifecycle

Complete work in short, repeatable cycles:

```text
Select micro task
  ↓
Retrieve required context
  ↓
Implement
  ↓
Validate
  ↓
Summarise
  ↓
Update ledger
  ↓
Discard implementation context
  ↓
Select next micro task
```

After each completed micro task:

1. Verify the change with the smallest relevant check.
2. Record a compact summary of the outcome and decisions.
3. Update the progress ledger.
4. Archive or discard large implementation history, raw tool output, and obsolete planning context.
5. Start the next micro task with only the context it needs.

Target a summary of 100–300 tokens:

```markdown
Micro Task Summary

Completed:
- Implemented `add()`.

Files Changed:
- `inventory.ts`

Decisions:
- Updates are immutable.
- Revision increments on successful mutation.

Next:
- Implement `update()`.
```

Do not retain a full diff or tool transcript when this summary and the repository state are sufficient.

## Progress ledger

Maintain a persistent, concise ledger. It is the authoritative project progress record, not the conversation history.

```markdown
Goal:
ECC Curator MVP

Completed:
- ContextItem
- ContextMetadata
- Inventory.add()
- Inventory.get()

Current:
- Inventory.update()

Next:
- Inventory.archive()
```

Keep the ledger within its 500-token allocation. Update it when work changes state; remove obsolete planning and redundant history.

## Output and planning retention

### Terminal and tool output

Default TTL is one turn:

```yaml
terminal_output:
  ttl_turns: 1
tool_output:
  ttl_turns: 1
build_logs:
  ttl_turns: 1
test_output:
  ttl_turns: 1
```

Extract the relevant result, error, or measurement into a short summary, then drop the raw output. Retain raw output longer only when required to diagnose an unresolved failure.

### Planning

Planning context is temporary. Retain only the current plan, task, and micro task. Archive completed or superseded plans and previous planning iterations; do not carry planning history in the active working set.

## Autocompaction anti-thrashing

If autocompaction triggers twice within ten turns:

1. Stop implementation work.
2. Produce a compact status report and update the progress ledger.
3. Archive completed work and discard obsolete planning and raw output.
4. Reduce active file context to the files required for one micro task.
5. Re-establish one active goal, task, and micro task.
6. Resume only after the working set is reduced.

Do not continue normal execution while context repeatedly exceeds its budget.

## Status report template

Use this when pausing, recovering from repeated autocompaction, or handing work off:

```markdown
Goal:

Task:

Current Micro Task:

Completed:
-

Files Required:
-

Key Decisions:
-

Validation:
-

Next:
-
```

The report should contain only information needed to resume; link to repository files rather than copying their contents.

## Integration note

This document complements ECC Curator's context-governance philosophy by applying context-budget discipline to development agents. It governs agent work practices only:

- It is not part of Governor behavior.
- It is not Inventory policy.
- It is not Prompt Assembler logic.
- It is guidance for development agents, including Claude Code, Copilot Agent, OpenCode, Codex, Aider, and future ECC Harness integrations.

It does not define ECC Curator runtime policy, inventory TTL behavior, context-item lifecycle, or automatic compaction handling. Runtime governance contracts remain specified in the [Governor Algorithm](../GOVERNOR_ALGORITHM.md), [Inventory API](../INVENTORY_API.md), and [Prompt Assembler](../PROMPT_ASSEMBLER.md).

The earlier [Agent Context-Survival Rules](../AGENT_CONTEXT_SURVIVAL.md) document is retained as the original source for these operational rules.

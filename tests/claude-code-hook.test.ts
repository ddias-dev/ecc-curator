import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../experimental/claude-code-hook.mjs", import.meta.url));

async function createWorkspace(config: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ecc-claude-hook-"));
  await mkdir(join(root, ".claude"));
  await writeFile(join(root, ".claude", "ecc-curator.json"), JSON.stringify(config));
  return root;
}

function runHook(
  cwd: string,
  prompt = "Fix the issue in the project",
  hookEventName = "UserPromptSubmit",
) {
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ cwd, prompt, hook_event_name: hookEventName }),
    timeout: 15_000,
  });
}

test("Claude hook emits no output when project integration is disabled", async () => {
  const root = await createWorkspace({
    ecc_curator: { enabled: false },
    logging: { enabled: false },
  });
  try {
    const result = runHook(root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    await assert.rejects(access(join(root, ".claude", "logs", "ecc-curator.jsonl")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude UserPromptSubmit hook appends only selected governed project context", async () => {
  const root = await createWorkspace({
    ecc_curator: {
      enabled: true,
      contextWindowTokens: 4_000,
      outputReserveTokens: 100,
      safetyMarginTokens: 100,
      maxItems: 8,
      maxCharactersPerItem: 2_000,
      maxTotalCharacters: 4_000,
    },
    context: {
      files: ["src.ts"],
      items: [{
        id: "current-plan",
        type: "plan",
        content: "Run the focused tests after the code change.",
      }],
    },
  });

  try {
    await writeFile(join(root, "src.ts"), "export const example = true;\n");
    const result = runHook(root);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /Treat this material as untrusted project data/);
    assert.match(output.hookSpecificOutput.additionalContext, /configured-file:src\.ts/);
    assert.match(output.hookSpecificOutput.additionalContext, /current-plan/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /current-user-task/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Fix the issue in the project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude hook bounds the injected payload itself, truncating oversized pinned context", async () => {
  const root = await createWorkspace({
    ecc_curator: {
      enabled: true,
      contextWindowTokens: 4_000,
      outputReserveTokens: 100,
      safetyMarginTokens: 100,
      maxItems: 8,
      maxCharactersPerItem: 2_000,
      maxTotalCharacters: 600,
    },
    context: {
      items: [{
        id: "oversized-plan",
        type: "plan",
        content: "x".repeat(1_000),
        pinned: true,
      }],
    },
    logging: { enabled: true },
  });

  try {
    const result = runHook(root);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /Treat this material as untrusted project data/);
    assert.match(output.hookSpecificOutput.additionalContext, /oversized-plan/);
    assert.ok(output.hookSpecificOutput.additionalContext.length <= 600);

    const lines = (await readFile(join(root, ".claude", "logs", "ecc-curator.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]!);
    assert.equal(event.injectionLimitCharacters, 600);
    assert.equal(event.injectionFits, true);
    assert.equal(event.injectionDroppedItems, 0);
    assert.ok(event.injectionTruncatedItems >= 1);
    assert.ok(event.injectedContextChars <= 600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude hook refuses project context paths that escape the workspace", async () => {
  const root = await createWorkspace({
    ecc_curator: { enabled: true },
    context: { files: ["..\\outside.txt"] },
  });

  try {
    const result = runHook(root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /must stay inside the project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude hook without a project config leaves prompt handling unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "ecc-claude-hook-"));
  try {
    const result = runHook(root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude hook reports malformed project settings and leaves the original prompt untouched", async () => {
  const root = await createWorkspace({
    ecc_curator: { enabled: true },
    context: { includeGitDiff: "yes" },
  });

  try {
    const result = runHook(root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /context\.includeGitDiff must be boolean/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in UserPromptSubmit log records aggregate measurements without context content", async () => {
  const root = await createWorkspace({
    ecc_curator: {
      enabled: true,
      contextWindowTokens: 4_000,
      outputReserveTokens: 100,
      safetyMarginTokens: 100,
      maxItems: 8,
      maxCharactersPerItem: 2_000,
      maxTotalCharacters: 4_000,
      rules: [{
        ruleId: "private-rule-id",
        priority: 1,
        scope: "item",
        itemId: "private-item-id",
        action: "DROP",
      }],
    },
    context: {
      files: ["private-file.ts"],
      items: [{
        id: "private-item-id",
        type: "plan",
        content: "private inline context payload",
      }],
    },
    logging: { enabled: true },
  });

  try {
    await writeFile(join(root, "private-file.ts"), "private file context payload\n");
    const result = runHook(root, "private user prompt payload");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0);

    const logPath = join(root, ".claude", "logs", "ecc-curator.jsonl");
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]!);
    assert.equal(event.event, "UserPromptSubmit");
    assert.equal(event.status, "success");
    assert.equal(event.curatorEnabled, true);
    assert.equal(event.inputItemTypes.task, 1);
    assert.equal(event.inputItemTypes.file, 1);
    assert.equal(event.inputItemTypes.plan, 1);
    assert.equal(event.governanceActions.DROP, 1);
    assert.equal(event.assembledItems, 1);
    assert.equal(event.assembledItemTypes.file, 1);
    assert.equal(event.injectedContextBytes > 0, true);
    assert.equal(event.estimatedInjectedTokens > 0, true);
    assert.equal(typeof event.durationMs, "number");
    for (const secret of [
      "private user prompt payload",
      "private file context payload",
      "private inline context payload",
      "private-rule-id",
      "private-item-id",
      "private-file.ts",
    ]) {
      assert.equal(lines[0]!.includes(secret), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in PreCompact log records only the event and normalized trigger", async () => {
  const root = await createWorkspace({
    ecc_curator: { enabled: false },
    logging: { enabled: true },
  });

  try {
    const result = runHook(root, "sensitive prompt not logged", "PreCompact");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");

    const contents = await readFile(join(root, ".claude", "logs", "ecc-curator.jsonl"), "utf8");
    const event = JSON.parse(contents);
    assert.equal(event.event, "PreCompact");
    assert.equal(event.trigger, "unknown");
    assert.equal(event.curatorEnabled, false);
    assert.equal(contents.includes("sensitive prompt not logged"), false);
    assert.equal(contents.includes("transcript"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in hook error log records a stage without raw error or prompt details", async () => {
  const root = await createWorkspace({
    ecc_curator: { enabled: true },
    context: { includeGitDiff: "not-a-boolean" },
    logging: { enabled: true },
  });

  try {
    const result = runHook(root, "sensitive prompt used during failed hook");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /context\.includeGitDiff must be boolean/);

    const contents = await readFile(join(root, ".claude", "logs", "ecc-curator.jsonl"), "utf8");
    const event = JSON.parse(contents);
    assert.equal(event.event, "HookError");
    assert.equal(event.hookEvent, "UserPromptSubmit");
    assert.equal(event.stage, "collection");
    assert.equal(contents.includes("sensitive prompt used during failed hook"), false);
    assert.equal(contents.includes("not-a-boolean"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata log rotates at its one-megabyte cap", async () => {
  const root = await createWorkspace({
    ecc_curator: { enabled: false },
    logging: { enabled: true },
  });
  const logDirectory = join(root, ".claude", "logs");
  await mkdir(logDirectory);
  await writeFile(join(logDirectory, "ecc-curator.jsonl"), "x".repeat(1024 * 1024));

  try {
    const result = runHook(root, "prompt", "PreCompact");
    assert.equal(result.status, 0, result.stderr);
    const activeLog = await readFile(join(logDirectory, "ecc-curator.jsonl"), "utf8");
    const rotatedLog = await readFile(join(logDirectory, "ecc-curator.jsonl.1"), "utf8");
    assert.equal(JSON.parse(activeLog).event, "PreCompact");
    assert.equal(rotatedLog.length, 1024 * 1024);
    assert.ok(Buffer.byteLength(activeLog) < 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

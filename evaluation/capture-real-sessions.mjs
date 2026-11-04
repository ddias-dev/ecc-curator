// ECC Curator - real-session capture (Priority 3: collect REAL coding sessions).
//
// Scope and honesty:
// - Captures ONLY genuine Claude Code session transcripts found under the
//   local projects directory (real coding sessions on this repository; no
//   synthetic sessions, no generated examples, no fabricated context
//   pressure). The transcripts on disk are the raw source; this tool derives
//   a bounded, truncated item dataset from them and records the derivation.
// - Items are typed with the EXISTING classifier vocabulary only
//   (src/classify/classify.ts + its signal aliases). Where a real item
//   cannot be typed from honest host signals, it is KEPT as
//   confidence=unrecognized/ambiguous evidence rather than guessed - the
//   classifier's own output decides; nothing is renamed to fit the
//   vocabulary.
// - Content is truncated to MAX_ITEM_CHARS for dataset size; full lengths and
//   truncation flags are recorded so downstream measurements know what they
//   see. Raw transcripts stay on disk; the manifest names them.
// - No model, no network: pure local parsing.
//
// Usage: node evaluation/capture-real-sessions.mjs [sessionsDir] [outDir]

import { readdir, readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";

import { classifyContext } from "../src/classify/classify.ts";
import { estimateTokens } from "../src/token-estimator.ts";

const SESSIONS_DIR = process.argv[2] ?? "C:/Users/ddias/.claude/projects/c--ddias-dev-ecc-curator";
const OUT_DIR = process.argv[3] ?? "datasets/real-sessions";
const MAX_ITEM_CHARS = 1500;
const MAX_ITEMS_PER_SESSION = 300;
const MIN_ITEM_CHARS = 16;

function classifyTool(itemType) {
  // Honest source strings drawn from the classifier's own alias vocabulary.
  if (itemType === "diff") return "patch";
  if (itemType === "terminal_output") return "build_log";
  if (itemType === "test_result") return "test_output";
  if (itemType === "tool_output") return "command_output";
  if (itemType === "retrieved_content") return "search_result";
  if (itemType === "file") return "file";
  if (itemType === "plan") return "plan";
  if (itemType === "task") return "task";
  if (itemType === "goal") return "user_goal";
  return "claude-code:unlabeled";
}

function extractSession(sessionId, lines) {
  const items = [];
  let assistantTurns = 0;
  const usage = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, turns: 0 };
  // second-pass needs turn index per line; first pass assigns order
  let lineIndex = 0;
  const turnIndexOfLine = lines.map((line) => {
    lineIndex += 1;
    const obj = JSON.parse(line);
    return obj;
  });
  const toolNameById = new Map();
  const fileRefs = new Map(); // path/pattern -> Read/Glob/Grep invocations (re-reference proxy)
  const toolPathById = new Map(); // tool_use block id -> file path/pattern for Read/Glob/Grep
  const estContentTokens = []; // reported-free token estimate per extracted item

  let seq = 0;
  let userMessages = 0;
  const usagePerTurn = []; // {atTurn, actual} reported prompt-side tokens per assistant turn

  for (const obj of turnIndexOfLine) {
    const msg = obj.message;
    const role = msg?.role;
    if (role === "assistant") assistantTurns += 1;
    if (role === "user") userMessages += 1;
    if (msg?.usage) {
      usage.input += msg.usage.input_tokens ?? 0;
      usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
      usage.cacheCreation += msg.usage.cache_creation_input_tokens ?? 0;
      usage.output += msg.usage.output_tokens ?? 0;
      usage.turns += 1;
      usagePerTurn.push({
        atTurn: assistantTurns,
        actual: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
      });
    }
    const content = msg?.content;
    if (typeof content === "string") {
      if (content.length >= MIN_ITEM_CHARS) {
        seq += 1;
        items.push({
          id: `${sessionId.slice(0, 8)}-msg-${seq}`,
          content,
          source:
            role === "user" && userMessages === 1
              ? "session opening prompt"
              : role === "user"
                ? "claude-code:user-message"
                : "claude-code:assistant-message",
          atTurn: assistantTurns,
        });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const atTurn = assistantTurns;
      if (block.type === "text") {
        if (typeof block.text !== "string" || block.text.length < MIN_ITEM_CHARS) continue;
        const source =
          role === "user" && userMessages === 1
            ? "session opening prompt"
            : role === "user"
              ? "claude-code:user-message"
              : "claude-code:assistant-message";
        seq += 1;
        items.push({
          id: `${sessionId.slice(0, 8)}-msg-${seq}`,
          content: block.text,
          source,
          atTurn,
        });
        continue;
      }
      if (block.type === "tool_use") {
        const blockName = block.name;
        const input = block.input ?? {};
        toolNameById.set(block.id, blockName);
        if (blockName === "Read" || blockName === "Glob" || blockName === "Grep") {
          const fp = input.file_path ?? input.pattern ?? "";
          if (fp.length > 0) fileRefs.set(fp, (fileRefs.get(fp) ?? 0) + 1);
          toolPathById.set(block.id, fp);
        }
        if (blockName === "Edit" || blockName === "MultiEdit" || blockName === "Write") {
          const diffish =
            (input.old_string !== undefined ? `- ${input.old_string}\n+ ${input.new_string ?? ""}` : `+ ${input.content ?? ""}`) +
            `\n(file: ${input.file_path ?? ""})`;
          seq += 1;
          items.push({
            id: `${sessionId.slice(0, 8)}-edit-${seq}`,
            content: diffish,
            source: classifyTool("diff"),
            atTurn,
          });
        } else if (blockName === "Bash" || blockName === "Terminal") {
          const command = input.command ?? "";
          const isTest = /(?:^|[\s;])(node --test|node .*spec|tests?[\/.]|pytest|vitest|jest|tsc|mocha)(?:[\s;]|$)/i.test(command);
          const isGitDiff = /git\s+diff/.test(command);
          const kind = isGitDiff ? "diff" : isTest ? "test_result" : "terminal_output";
          seq += 1;
          items.push({
            id: `${sessionId.slice(0, 8)}-cmd-${seq}`,
            content: `$ ${command}`,
            source: classifyTool(kind),
            atTurn,
            isCommand: true,
          });
        } else if (blockName === "TodoWrite") {
          seq += 1;
          items.push({
            id: `${sessionId.slice(0, 8)}-plan-${seq}`,
            content: JSON.stringify(input.todos ?? []),
            source: classifyTool("plan"),
            atTurn,
          });
        }
        continue;
      }
      if (block.type === "tool_result") {
        const toolName = toolNameById.get(block.tool_use_id);
        let source;
        let kind;
        if (toolName === "Read") {
          source = "file";
          kind = "file";
        } else if (toolName === "Grep" || toolName === "Glob" || toolName === "LS") {
          source = "search_result";
          kind = "retrieved_content";
        } else if (toolName === "Bash" || toolName === "Terminal") {
          source = "command_output";
          kind = "tool_output";
        } else if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write") {
          source = "patch";
          kind = "diff";
        } else if (toolName === "WebFetch" || toolName === "WebSearch") {
          source = "documentation";
          kind = "retrieved_content";
        } else {
          source = "claude-code:tool-result";
          kind = "unknown";
        }
        const rawContent =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => c?.text ?? "").join("\n")
              : "";
        if (rawContent.length < MIN_ITEM_CHARS) continue;
        seq += 1;
        items.push({
          id: `${sessionId.slice(0, 8)}-res-${seq}`,
          content: rawContent,
          source,
          atTurn,
          kind,
          pathRef: toolPathById.get(block.tool_use_id) ?? "",
        });
        continue;
      }
    }
  }

  const truncatedItems = items.map((item) => {
    const truncated = item.content.length > MAX_ITEM_CHARS;
    const estFull = estimateTokens(item.content);
    const estKept = estimateTokens(truncated ? item.content.slice(0, MAX_ITEM_CHARS) : item.content);
    estContentTokens.push(estFull);
    return {
      id: item.id,
      fullChars: item.content.length,
      content: truncated ? item.content.slice(0, MAX_ITEM_CHARS) : item.content,
      source: item.source,
      truncated,
      estTokensFull: estFull,
      estTokensKept: estKept,
      atTurn: item.atTurn,
      ageTurns: assistantTurns - item.atTurn, // final role-based assistant count (same basis as atTurn)
      pathRef: item.pathRef ?? "",
    };
  });

  // classification via the EXISTING classifier: source string only (content is
  // never inspected by the classifier), honest to the ingestion contract
  const classified = truncatedItems.map((item) => {
    const classification = classifyContext({
      id: item.id,
      content: item.content,
      source: item.source,
    });
    return {
      ...item,
      confidence: classification.confidence,
      knownType: classification.knownType,
      type: classification.type,
      candidates: classification.candidates,
      reasonCode: classification.reasonCode,
    };
  });

  // deterministic cap: keep ALL goal/task/plan/diff/test_result items plus as
  // many remaining items as fit (newest first) within MAX_ITEMS_PER_SESSION
  const priorityKind = new Set(["plan", "diff", "test_result", "task", "goal"]);
  const ordered = classified.sort((a, b) => a.atTurn - b.atTurn);
  const kept = [];
  for (const item of ordered) {
    if (priorityKind.has(item.type)) kept.push(item);
  }
  const rest = ordered.filter((item) => !priorityKind.has(item.type));
  const room = Math.max(0, MAX_ITEMS_PER_SESSION - kept.length);
  if (rest.length > room) {
    // deterministic sample: evenly spaced across the session
    for (let i = 0; i < room; i += 1) {
      kept.push(rest[Math.floor((i * rest.length) / room)]);
    }
  } else {
    for (const item of rest) kept.push(item);
  }
  kept.sort((a, b) => a.atTurn - b.atTurn || (a.id < b.id ? -1 : 1));

  // re-reference proxy: file paths/patterns the session opened repeatedly
  const topFileRefs = [...fileRefs.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([path, reads]) => ({ path, reads }));

  return {
    items: kept,
    totalExtractedItems: classified.length,
    usage,
    usagePerTurn,
    estContentTokens,
    topFileRefs,
    assistantTurns,
    truncatedCount: classified.filter((item) => item.truncated).length,
  };
}

async function main() {
  const dirEntries = await readdir(SESSIONS_DIR);
  const sessionFiles = dirEntries.filter((name) => name.endsWith(".jsonl"));
  sessionFiles.sort();
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = {
    capturedAt: new Date().toISOString(),
    source: "Claude Code session transcripts (local, real coding sessions on this repository)",
    rawSourceDirectory: SESSIONS_DIR,
    sessions: [],
    totals: { sessions: 0, items: 0, truncated: 0 },
    classifierVocabulary: "src/classify/classify.ts signal vocabulary (unchanged)",
  };

  for (const fileName of sessionFiles) {
    const sessionId = fileName.replace(/\.jsonl$/, "");
    const filePath = join(SESSIONS_DIR, fileName);
    const fileStat = await lstat(filePath);
    const text = await readFile(filePath, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    let parsed;
    try {
      parsed = extractSession(sessionId, lines);
    } catch (error) {
      manifest.sessions.push({ sessionId, error: String(error?.message ?? error), skipped: true });
      continue;
    }
    const outSub = join(OUT_DIR, sessionId);
    await mkdir(outSub, { recursive: true });
    const sessionRecord = {
      sessionId,
      rawFile: fileName,
      rawBytes: fileStat.size,
      rawLines: lines.length,
      assistantTurns: parsed.assistantTurns,
      extractedItems: parsed.totalExtractedItems,
      keptItems: parsed.items.length,
      truncatedItems: parsed.truncatedCount,
      tokenUsage: parsed.usage,
      usagePerTurn: parsed.usagePerTurn,
      estContentTokensTotal: parsed.estContentTokens.reduce((a, b) => a + b, 0),
      topFileRefs: parsed.topFileRefs,
      classifierConfidence: {},
    };
    for (const item of parsed.items) {
      const key = `${item.confidence}:${item.reasonCode ?? ""}`;
      sessionRecord.classifierConfidence[key] = (sessionRecord.classifierConfidence[key] ?? 0) + 1;
    }
    await writeFile(join(outSub, "items.json"), JSON.stringify({ sessionId, capturedAt: manifest.capturedAt, items: parsed.items }, null, 1), { encoding: "utf8" });
    manifest.sessions.push(sessionRecord);
    manifest.totals.sessions += 1;
    manifest.totals.items += parsed.items.length;
    manifest.totals.truncated += parsed.truncatedCount;
  }

  await writeFile(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8" });
  console.log(`captured ${manifest.totals.sessions} real sessions -> ${OUT_DIR}`);
}

await main();

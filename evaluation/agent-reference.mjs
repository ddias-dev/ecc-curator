// ECC Curator - deterministic REFERENCE agent callback for fair-runner.
//
// Honesty: this is NOT a model or coding-agent run. It applies the dataset's
// declared `solution` files into the workspace (the same scripted reference as
// evaluation/runner.mjs), so the outcomes it produces exercise the fair-runner
// plumbing (repetitions, alternating order, raw saving) and measure fixture
// plumbing stability ONLY. Identical deterministic runs across repetitions are
// expected; no improvement, savings, or capability claim follows from these
// results. Model runs require the user-supplied real-agent callback
// (evaluation/agent-claude-cli.mjs or the user's own) via the same runner.
//
// Usage: node evaluation/fair-runner.mjs --agent evaluation/agent-reference.mjs ...

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const DATASET_DIR = "benchmarks";

export const AGENT_SETTINGS = {
  agent: "deterministic reference (applies dataset solution)",
  model: "none",
  note: "fixture plumbing evidence only; not model evidence",
};

const index = new Map(); // workloadId -> solution files (loaded once)

async function loadWorkloadDocuments(dir) {
  // recursive readdir returns names that already contain the relative path
  // ("coding\\feature-x.json" on Windows); join(dir, name) resolves them.
  const names = await readdir(dir, { recursive: true });
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const doc = JSON.parse(await readFile(join(dir, name), "utf8"));
    if (typeof doc.id === "string") index.set(doc.id, doc);
  }
}

export async function runAgent(request) {
  if (index.size === 0) await loadWorkloadDocuments(DATASET_DIR);
  const workload = index.get(request.workloadId);
  if (workload === undefined || !Array.isArray(workload.solution)) {
    return { retries: 0, errors: 1 }; // no solution to apply: recorded failure
  }
  for (const entry of workload.solution) {
    const target = join(request.workspaceDirectory, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.content, { encoding: "utf8" });
  }
  return undefined;
}

// ECC Curator - user-supplied real-agent callback: the Claude Code CLI,
// non-interactive (-p) mode. This is TRUSTED user code per docs/BENCHMARK_DATASETS.md
// ("Real-agent opt-in path"): it launches a real coding agent that contacts a
// model endpoint, and it is NOT sandboxed by the harness.
//
// Recorded run settings (the reproducibility list from docs/BENCHMARK_DATASETS.md):
//   agent      = Claude Code CLI (claude.exe resolved from PATH at call time)
//   model      = AGENT_SETTINGS.model (small/fast model chosen for run cost;
//                recorded verbatim so every result names the same configuration)
//   permissions= --permission-mode acceptEdits (file edits auto-accepted inside
//                the fresh os.tmpdir() workspace that is cwd; Bash remains
//                denied — the harness scores objective checks, so the agent
//                never needs shell access). docs/BENCHMARK_DATASETS.md "Trust
//                boundary" still applies to the callback itself.
//   env        = full inheritance from the parent node process (the model
//                endpoint needs the account/auth state; the inherited state is
//                recorded in the fair-runner manifest)
//
// Agent contract note: the callback receives the harness prompt (ungoverned or
// governed serialization) on STDIN and must edit ONLY inside
// request.workspaceDirectory
// (cwd is set there). Outcome is decided by the harness's objective checks, never
// by the agent's own words. A timeout kills the run and reports errors: 1 so the
// harness records a failed run the comparison can continue over.
//
// Usage: never on its own; used via:
//   node evaluation/runner-real.mjs --agent evaluation/agent-claude-cli.mjs ...
//   node evaluation/fair-runner.mjs --agent evaluation/agent-claude-cli.mjs ...

import { execFile } from "node:child_process";
import { promisify } from "node:util";

// child_process.execFile is callback-style: await it only via promisify,
// otherwise the call returns before the agent process has finished.
const execFileAsync = promisify(execFile);

export const AGENT_SETTINGS = {
  agent: "claude-code-cli -p",
  model: "claude-haiku-5-5",
  permissionMode: "acceptEdits (auto-accepts file edits inside cwd; Bash still denied)",
  maxTurns: 25,
  timeoutMs: 240_000,
  promptChannel: "argv (fixture prompts are a few KB; well under the OS argv limit)",
};

export async function runAgent(request) {
  const args = [
    "-p",
    "--model",
    AGENT_SETTINGS.model,
    "--output-format",
    "json",
    "--max-turns",
    String(AGENT_SETTINGS.maxTurns),
    "--permission-mode",
    "acceptEdits",
    request.prompt,
  ];
  try {
    await execFileAsync(
      "claude",
      args,
      {
        cwd: request.workspaceDirectory,
        env: { ...process.env },
        timeout: AGENT_SETTINGS.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        killSignal: "SIGKILL",
      },
    );
    return undefined; // uninstrumented success: harness checks decide the outcome
  } catch (error) {
    const stderr = typeof error === "object" ? String(error.stderr ?? "") : "";
    console.error(
      `runAgent[claude-cli] failure: code=${typeof error === "object" ? error.code ?? "?" : "?"} ` +
      `message=${String(error?.message ?? error).slice(0, 600)} stderr=${stderr.slice(0, 600)}`,
    );
    return { retries: 0, errors: 1 };
  }
}

// ECC Curator - user-supplied real-agent callback: Codex CLI non-interactive
// (`codex exec`). TRUSTED user code per docs/BENCHMARK_DATASETS.md
// ("Real-agent opt-in path"): it launches a real coding agent that contacts a
// model endpoint when credentials exist, and it is NOT sandboxed by the
// harness. Structural mirror of evaluation/agent-claude-cli.mjs (same harness
// path, different runtime); review before wiring in.
//
// Recorded run settings (the reproducibility list from docs/BENCHMARK_DATASETS.md):
//   agent       = Codex CLI `codex exec` (version 0.166.0; absolute vendored
//                 path recorded by `codex doctor` on this platform, overridable
//                 via CODEX_EXE so every run can name the exact binary)
//   model       = AGENT_SETTINGS.model: "account/config default" unless CODEX_MODEL
//                 pins it (see evaluation/agents/codex/environment.md: model is
//                 undetermined until auth exists; pin it before comparing runs)
//   permissions = -s workspace-write + approval_policy=never (non-interactive:
//                 edits inside the fresh os.tmpdir() workspace cwd auto-apply,
//                 approvals never prompt; the harness scores objective checks
//                 so the agent never needs to ask). docs/BENCHMARK_DATASETS.md
//                 "Trust boundary" still applies to the callback itself.
//   env         = full inheritance from the parent node process (Codex
//                 credential state / OSS provider env lives there; the
//                 inherited state is recorded in the fair-runner manifest)
//
// Agent contract note: the callback receives the harness prompt (ungoverned or
// governed serialization) via STDIN with the `-` positional. MEASURED finding
// (results/raw launch records, attempt1): with an argv prompt and an inherited
// open stdin pipe, codex `exec` printed "Reading additional input from
// stdin..." and HUNG until the timeout kill (SIGKILL at 240 s) — the argv
// channel the Claude round proved is NOT safe for Codex; stdin (write + close
// = EOF) is. It must edit ONLY inside request.workspaceDirectory (cwd and -C
// are set there; the workspaces are not git repos, hence --skip-git-repo-
// check). Raw per-run
// JSONL events + last message + launch stderr are saved under
// evaluation/agents/codex/results/raw/ as evidence; the agent's own words
// NEVER decide outcomes (harness checks do). A timeout kills the run and
// reports errors: 1 so the harness records a failed run the comparison can
// continue over.
//
// Usage: never on its own; via
//   node evaluation/fair-runner.mjs --agent evaluation/agents/codex/agent-codex-cli.mjs \
//        benchmarks evaluation/agents/codex/results <repeats> <tag>

import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const CODEX_EXE =
  process.env.CODEX_EXE ??
  join(
    process.cwd(),
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );

export const AGENT_SETTINGS = {
  agent: "codex-cli exec (0.166.0, vendored win32 binary via npm @openai/codex)",
  model: process.env.CODEX_MODEL ?? "account/config default (pin with CODEX_MODEL; undetermined pre-auth, see environment.md)",
  sandbox: "workspace-write (writable inside cwd workspace; approval_policy never in non-interactive exec)",
  approvalPolicy: "never",
  promptChannel: "stdin via `-` positional (write + close; EOF ends input) — argv hangs codex exec, see measured finding above",
  ephemeral: true,
  ignoreUserConfig: true,
  timeoutMs: 240_000,
  rawEvidenceDir: "evaluation/agents/codex/results/raw",
};

const RAW_DIR = join(process.cwd(), AGENT_SETTINGS.rawEvidenceDir);

// Defensive by design: evidence logging must never turn a launch failure into
// a callback exception (the contract wants {retries, errors}, not a throw),
// and file names must be Windows-safe (no colons from ISO timestamps).
async function saveRawEvidence(stem, streams) {
  try {
    await mkdir(RAW_DIR, { recursive: true });
    for (const [label, text] of streams) {
      if (text === null || text === "") continue;
      await appendFile(join(RAW_DIR, `${stem}-${label}.log`), `${text}\n`, { encoding: "utf8" });
    }
  } catch (logError) {
    console.error(`raw-evidence logging failed: ${String(logError?.code ?? logError)} ${String(logError?.message ?? logError)}`);
  }
}

// spawn-based launch (NOT execFile): the child's stdin must be WRITTEN then
// CLOSED. Measured finding (results/raw records): with an argv prompt and an
// inherited open stdin pipe, codex `exec` printed "Reading additional input
// from stdin..." and hung until the timeout kill. This helper never throws:
// spawn errors, exits, and timeout kills all come back as data for the
// contract's {retries, errors} mapping.
async function launchAgent(exe, args, cwd, timeoutMs, stdinText) {
  const child = spawn(exe, args, { cwd, env: { ...process.env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 32 * 1024 * 1024) stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 32 * 1024 * 1024) stderr += String(chunk);
  });
  child.stdin.on("error", () => {}); // swallow EPIPE if the child closes stdin early
  try {
    child.stdin.write(`${stdinText}\n`);
    child.stdin.end(); // EOF: closes the documented stdin channel
  } catch {}
  let killed = false;
  const exitInfo = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL"); // the kill fires an 'exit' event with a signal
      } catch {}
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ error: String(error?.code ?? error?.message ?? error) });
    });
  });
  return { stdout, stderr, exitInfo, killed };
}

export async function runAgent(request) {
  const lastMessageFile = join(RAW_DIR, `${request.workloadId}-${request.mode}-lastmessage.log.txt`);
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ephemeral",
    "-C",
    request.workspaceDirectory,
    "-s",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "--json",
    "-o",
    lastMessageFile,
    // MEASURED finding (results/raw launch records): with an argv prompt Codex
    // `exec` printed "Reading additional input from stdin..." and HUNG on the
    // open stdin pipe until the timeout kill. The documented stdin channel is
    // the safe one: `-` positional + write+close stdin (EOF terminates input).
    "-",
  ];
  if (process.env.CODEX_MODEL) {
    args.splice(1, 0, "-m", process.env.CODEX_MODEL);
  }
  const stem = `${request.workloadId}-${request.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const launch = await launchAgent(
    CODEX_EXE,
    args,
    request.workspaceDirectory,
    AGENT_SETTINGS.timeoutMs,
    request.prompt,
  );
  const clean =
    launch.exitInfo !== null &&
    launch.exitInfo !== undefined &&
    launch.exitInfo.code === 0 &&
    !launch.killed &&
    launch.exitInfo.error === undefined;
  if (clean) {
    await saveRawEvidence(stem, [["stdout-jsonl", launch.stdout], ["stderr", launch.stderr]]);
    return undefined; // uninstrumented success: harness checks decide the outcome
  }
  const exit = launch.exitInfo ?? {};
  const record =
    `exitCode=${exit.code ?? "none"} signal=${exit.signal ?? "none"} killed=${launch.killed} spawnError=${exit.error ?? "none"}\n` +
    `stdout(len ${launch.stdout.length}): ${launch.stdout.slice(0, 3000)}\n` +
    `stderr(len ${launch.stderr.length}): ${launch.stderr.slice(0, 3000)}`;
  await saveRawEvidence(stem, [["launch-error", record]]);
  console.error(
    `runAgent[codex-cli] failure workload=${request.workloadId} mode=${request.mode}: ${record.slice(0, 900)}`,
  );
  return { retries: 0, errors: 1 };
}

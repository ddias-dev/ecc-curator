# Codex CLI Capability Audit (Phase 1)

Audit date: 2026-11-05. Every claim below is from a local command in this
environment; raw outputs are quoted or stored, not paraphrased from memory.

## Audit commands

```text
npm install @openai/codex                 (install record)
node_modules/.bin/codex --version         (version)
node_modules/.bin/codex --help / exec --help  (capability surface)
node_modules/.bin/codex doctor            (runtime/auth health)
node --version                            (harness Node runtime)
```

## Identity

| field | value | evidence |
| --- | --- | --- |
| Codex version | `codex-cli 0.166.0` | `codex --version` |
| Install method | npm package `@openai/codex` in this repo's `node_modules` (adds a `dependencies` entry to `package.json` — recorded so the run is reproducible; tracked by `fair-runner`'s manifest pattern) | npm install output; `git diff package.json` |
| Executable | `node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe` | `codex doctor` runtime row |
| Platform | Windows 10.0.26300 (Windows 11 Core), 64-bit | `codex doctor` environment row |
| Harness Node | `v24.22.1` | `node --version` |

## Model used — UNDETERMINED, and why

`codex doctor` reports (raw):

```text
✗ auth         no Codex credentials were found - Run codex login or provide an API key through a supported auth env var.
```

There is no credential state: `~/.codex/auth.json` is absent and no API-key
environment variable is set (existence checked; values never printed).
Consequently the model that would run is **not determinable at audit time**:

- Default provider is the OpenAI provider; its model comes from account/config
  (`-c model=...` override documented in `exec --help`), none of which exists here.
- Local path: `--oss` + `--local-provider <lmstudio|ollama>` (documented in
  `exec --help`). Requires a running local server — none is reachable:
  probes of `127.0.0.1:11434` (ollama), `:1234` (LM Studio), `:8080`
  (llama-server) all failed with no response (2026-11-05).
- Login routes available: interactive ChatGPT login; `codex login --with-api-key`
  (reads key from stdin); `codex login --with-access-token` (stdin).
  All are the user's decision — not performed by this audit.

**Consequence:** model context window is likewise **model-dependent and
undetermined** at audit time. What is fixed for the evaluation is the
harness-side governance budget: the real-agent runners configure
`contextWindowTokens = 32_768` (`evaluation/fair-runner.mjs` /
`runner-real.mjs` via `toIntegrationConfig`), matching the Claude trial3 runs —
so cross-agent comparability of the governance decisions does not depend on
the agent's own window.

## Tool capabilities (from `exec --help`, verbatim surface)

- Non-interactive `exec` mode with the prompt as positional argv or stdin
  (`-` reads stdin; piped stdin with an argv prompt appends a `<stdin>` block).
- `-C/--cd <DIR>` working root; `--add-dir` additional writable dirs.
- `-s/--sandbox` workspace permission modes: `read-only`,
  `workspace-write`, `danger-full-access`.
- Approval routing: `--approve-for-me` ("route approval requests through
  automatic review using the workspace-write sandbox");
  `--dangerously-bypass-approvals-and-sandbox` (documented as EXTREMELY
  DANGEROUS); `approval_policy` settable via `-c` config override.
- `-m/--model <MODEL>`; `--oss`; `--local-provider`; `--output-schema`;
  `--json` (JSONL events to stdout); `-o/--output-last-message <FILE>`;
  `--ephemeral` (no persisted session files); `--ignore-user-config`
  (skip `$CODEX_HOME/config.toml`); `--ignore-rules` (skip execpolicy `.rules`).
- `-c/--config key=value` TOML overrides (e.g. `sandbox_permissions`,
  `shell_environment_policy.inherit`).
- Bundled search: `codex doctor` reports a bundled `rg.exe` search provider
  present on this platform.
- Windows sandbox helper binaries named by `codex doctor`:
  `codex-windows-sandbox-setup.exe`, `codex-command-runner.exe`,
  `codex-code-mode-host.exe` (native sandboxing exists on this platform).
- Broader CLI surface (from top-level `--help`): `agents`, `review`,
  `app-server`, `mcp`, `plugin`, `sandbox`, `hooks`-related features,
  session `resume/fork/archive` state under `CODEX_HOME`.

## Execution mode chosen for this evaluation (amended post-audit by measurement)

`codex exec` (non-interactive), one process per harness run, prompt via
**STDIN** with the `-` positional (write + close = EOF). At audit time this
read "prompt via argv (the channel the Claude adapter proves)" — a post-audit
run FALSIFIED it: an argv prompt plus the inherited open stdin pipe makes
codex `exec` print `Reading additional input from stdin...` and hang until
the timeout kill (SIGKILL at 240 s; raw record `results/raw/attempt1-*`).
The documented stdin channel launches cleanly (raw `results/raw/attempt2-*`).
cwd pinned to the harness workspace via `-C`,
`--skip-git-repo-check` (harness workspaces under `os.tmpdir()` are not git
repos), `--ignore-user-config` + `--ephemeral` (run reproducibility: no host
config or session state coupling), `--json` captured to raw per-run evidence.

## Auth/runtime health raw record (2026-11-05)

```text
Codex Doctor v0.166.0 · windows-x86_64
  ⚠ security     Microsoft Defender can interfere with Codex. Verify Codex exclusions.
  ⚠ git          this worktree is not on a Windows Dev Drive; ...
  ✗ auth         no Codex credentials were found - Run codex login or provide an API key through a supported auth env var.
  ⚠ websocket    Responses WebSocket failed; HTTPS fallback may still work ...
  ✓ runtime      version 0.166.0 ... executable ...codex.exe
  ✓ search       bundled rg.exe
```

## Blocker summary

The mechanism (binary, exec mode, sandbox modes, JSONL instrumentation) is
**audited as present**. The **live model runs (Phases 4–5) cannot execute**
until the user supplies auth (login, API key via
`codex login --with-api-key`, or a local ollama/LM Studio server for `--oss`).
Measured pre-model auth flow (attempt2, 2026-11-05): the CLI accepts all run
flags, starts a turn, and dies at the wire — Responses-WS `401 Unauthorized:
Missing bearer or basic authentication in header` → documented HTTPS fallback
→ exitCode 1 (~15 s). No credential was materialized or printed by this
audit.

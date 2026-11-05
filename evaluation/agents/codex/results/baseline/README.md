# Baseline evidence index (Phase 4 — Codex WITHOUT governance)

Raw evidence is the comparison JSON (authoritative) and the per-run launch
logs; this index carries the baseline-mode records inline. All runs BLOCKED
PRE-MODEL (auth 401; see `../raw/`). Adapter: stdin channel, attempt2 is the
final wiring.

| workload | raw file | baseline record (verbatim fields) |
| --- | --- | --- |
| feature-work-greeting | `../feature-work-greeting-attempt2-r0.json` | outcome NOT completed; errors 1, errorStage `agent`; tests 0/1 on untouched workspace; promptTokens 368; contextTokens 139; kept 5, dropped 0; runtime 15.18 s (exitCode 1, killed=false) |
| issue-fix-boundary | `../issue-fix-boundary-attempt2-r0.json` | errors 1, errorStage agent; tests 0/1; promptTokens 514; contextTokens 262; kept 7, dropped 0; runtime 15.57 s |
| refactor-rename-helper | `../refactor-rename-helper-attempt2-r0.json` | errors 1, errorStage agent; tests 0/1; promptTokens 535; contextTokens 263; kept 8, dropped 0; runtime 14.70 s |

Per-run launch stderr/JSONL (raw bytes, 401 flow):
`../raw/feature-work-greeting-baseline-2026-11-05T12-28-02-435Z-launch-error.log`,
`../raw/issue-fix-boundary-baseline-2026-11-05T12-28-32-262Z-launch-error.log`,
`../raw/refactor-rename-helper-baseline-2026-11-05T12-29-03-609Z-launch-error.log`
(plus the rejected `attempt1-*` argv-channel probes preserved alongside).

Settings for every row: `../fair-manifest.json` (agent module + AGENT_SETTINGS,
dataset sha-256, node v24.22.1, N=1, order baseline-first).

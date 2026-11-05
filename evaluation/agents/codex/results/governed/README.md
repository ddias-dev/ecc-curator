# Governed evidence index (Phase 5 — Codex WITH governance)

Same raw sources as `../baseline/README.md`; the governed-mode records inline.
All runs BLOCKED PRE-MODEL (auth 401; raw in `../raw/`). Governance DID act
(harness-side): items dropped, package reframed — recorded regardless of the
agent block.

| workload | raw file | governed record (verbatim fields) |
| --- | --- | --- |
| feature-work-greeting | `../feature-work-greeting-attempt2-r0.json` | outcome NOT completed; errors 1, errorStage agent; tests 0/1; promptTokens 613 (LARGER than baseline 368); contextTokens 110; kept 4, dropped 1 (`log-1` rule-DROPped); runtime 14.64 s (exitCode 1, killed=false) |
| issue-fix-boundary | `../issue-fix-boundary-attempt2-r0.json` | errors 1, errorStage agent; tests 0/1; promptTokens 899 (baseline 514); contextTokens 209; kept 6, dropped 1 (`log-1`); runtime 15.78 s |
| refactor-rename-helper | `../refactor-rename-helper-attempt2-r0.json` | errors 1, errorStage agent; tests 0/1; promptTokens 858 (baseline 535); contextTokens 180; kept 6, dropped 2 (`log-1`, `log-2`); runtime 15.54 s |

Per-run launch logs (raw bytes):
`../raw/feature-work-greeting-governed-2026-11-05T12-28-17-621Z-launch-error.log`,
`../raw/issue-fix-boundary-governed-2026-11-05T12-28-47-827Z-launch-error.log`,
`../raw/refactor-rename-helper-governed-2026-11-05T12-29-18-310Z-launch-error.log`
(rejected `attempt1-*` probes preserved alongside).

Settings: `../fair-manifest.json`. Note the governed-prompt-shape numbers are
byte-identical to the Claude round (`evaluation/results-trial3/`) — harness-side
determinism, not agent behaviour (see `../../findings.md`).

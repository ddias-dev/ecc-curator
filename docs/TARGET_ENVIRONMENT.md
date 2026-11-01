# Target Environment

ECC Curator's initial design and evaluation focus is long-running autonomous coding work on local models and commodity hardware. Every environment below is a target for future implementation and testing, not a claim of existing compatibility.

## Intended users

- Developers running local coding models for extended engineering tasks
- Users of coding-agent runtimes who want explicit control over accumulated context
- Contributors implementing agent integrations, governance policies, or optimization providers
- Teams exploring local-first workflows where context use and resource limits matter

The primary workload is a coding agent that continues work across many steps and accumulates plans, memories, diffs, test results, logs, tool output, and conversation history.

## Reference hardware profile

| Resource | Initial target |
|---|---|
| System memory | 32 GB RAM |
| Accelerator memory | 16 GB VRAM |
| Context windows | 64K and 128K tokens |

This is a reference evaluation profile, not a minimum requirement, supported configuration, or performance guarantee. Actual feasibility will depend on the model build, quantization, runtime, operating system, workload, and available memory.

## Initial integrations and models

### Agent runtimes

- Claude Code
- ECC Harness
- Strata

### Local coding models

- Qwen3 Flash Next Coder
- Future local coding models selected as they become relevant to evaluation

No compatibility is implied until an integration is implemented and tested against a documented runtime and version. The model list is an evaluation target, not a supported-model list.

## Local-first philosophy

Local-first is the primary design target, not an exclusion of hosted models. The proposed baseline should:

- Keep governance deterministic and explainable where practical
- Avoid requiring a cloud service or an LLM for basic governance
- Treat finite context and finite hardware as design constraints
- Keep providers and runtime integrations optional and replaceable
- Evaluate task outcomes alongside context use, rather than optimizing token reduction in isolation

## Example workflows

These are intended scenarios, not implemented product workflows:

1. **Long bug-fix session:** The agent carries forward the current goal, active task, relevant files, and unresolved findings; stale command output is considered for transformation or removal.
2. **Test-and-repair loop:** Verbose test output is evaluated for retention, structured failure extraction, compression, or removal before the next model call.
3. **Plan changes during implementation:** The current plan and important decisions remain available while obsolete plan versions and completed work are candidates for reduced retention.
4. **Agent handoff:** A compact, task-relevant working set is prepared for the next session or runtime, subject to future integration and retrieval design.

The examples illustrate the governance problem and possible actions; they do not claim a particular reduction in tokens or an outcome improvement.

## Constraints and non-goals

The initial target profile does not mean ECC Curator will:

- Guarantee task success, prevent all context-window failures, or eliminate model escalation
- Promise a specific token reduction, latency, throughput, or quality improvement
- Require a particular local model, quantization, runtime, or accelerator
- Replace a coding agent, model runtime, orchestration system, or memory store
- Make compression the default answer to context growth
- Provide validated integrations for the named runtimes or optimization projects before implementation and testing

Initial evaluations should record model and runtime versions, model build and quantization, hardware, context-window setting, workload, governance configuration, task completion, test outcomes, retries, context use, and escalation behavior. See [Evaluation Framework](EVALUATION.md).

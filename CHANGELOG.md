# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to Semantic Versioning where practical during pre-release development.

---

## [0.1.0] - 2026-11-01

### Added

#### Deterministic Governance MVP

Implemented the first runnable ECC Curator MVP focused on deterministic context governance.

Core governance pipeline:

```text
Inventory
    ↓
Scoring
    ↓
Governor
    ↓
Prompt Assembler
```

#### Context Inventory

Implemented:

- Context item lifecycle management
- Context inventory snapshots
- Revision tracking
- Event tracking
- Reference tracking
- Archive and drop handling
- Deterministic querying and listing
- Typed inventory contracts

#### Token Estimation

Implemented:

- TokenEstimator interface
- Deterministic token accounting
- Conservative fallback estimation
- Validation and error handling

#### Scoring Engine

Implemented the deterministic scoring model including:

- Priority weighting
- Recency decay
- Reference weighting
- Context-type baselines
- Cost affordability calculations
- Deterministic scoring outputs

#### Rule Engine

Implemented:

- Item-specific rules
- Context-type rules
- Global rules
- Stable precedence ordering
- Policy validation

#### Governor

Implemented:

- Hard constraints
- Pinned-item protection
- Rule evaluation
- Threshold evaluation
- Budget-aware governance
- Decision provenance
- Conflict detection

Current MVP governance outcomes:

```text
KEEP
DROP
```

#### Prompt Assembler

Implemented:

- Deterministic ordering
- Budget enforcement
- Overflow detection
- Stable tie-breaking
- Assembly reports
- Explicit failure modes

#### End-to-End Pipeline

Implemented:

```text
ingest
→ inventory
→ score
→ govern
→ assemble
```

#### Evaluation Harness

Added:

- Deterministic evaluation scenarios
- Governance metrics
- Pipeline validation scenarios
- Reproducible test workloads

---

### Added Documentation

#### Core Architecture

Added or expanded:

- Architecture
- Context Model
- Configuration
- Decision Records
- Evaluation Framework
- Target Environment
- Positioning

#### Implementation Specifications

Added:

- Governor Algorithm
- Scoring Specification
- Inventory API
- Prompt Assembler

These documents define the implementation contracts used by the MVP.

#### Decision Intelligence

Added:

- Decision Intelligence architecture
- Decision Schemas
- Provider model
- Jev integration proposal
- Plugin API

Provider support remains future work.

#### Agent Integration Guidance

Added:

- Agent Execution Rules

Consolidated all agent-operation guidance into a single authoritative specification.

---

### Tested

Current test status:

```text
106 / 106 tests passing
```

Coverage includes:

- Inventory operations
- Lifecycle transitions
- Scoring
- Rule evaluation
- Governor decisions
- Budget handling
- Prompt assembly
- End-to-end pipeline execution

---

### Deferred

The following roadmap areas remain intentionally unimplemented:

#### Decision Providers

- LiquidAI/d1-2B
- Jev
- Custom decision providers

#### Compression Providers

- RTK
- Caveman
- LLMLingua
- Troglodita

#### Transformation Providers

- Structured transformation executors
- Log summarisation providers
- Test result transformers

#### Integrations

- Claude Code
- ECC Harness
- Strata
- OpenCode
- Codex
- Aider

#### Persistence and Retrieval

- Durable storage
- Archive recovery
- Retrieval systems
- Vector search
- Semantic search

---

### Notes

This release establishes the deterministic foundation of ECC Curator.

ECC Curator remains:

- Deterministic-first
- Governance-led
- Local-first
- Provider-neutral
- Model-agnostic

The project is currently suitable for experimentation, architecture validation, benchmarking, and future integration work.

```text
Release: v0.1.0
Status: Pre-release
Maturity: MVP
Production Ready: No
```

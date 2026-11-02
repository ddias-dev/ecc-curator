// ECC Curator — base context contracts.
// Source of truth: docs/CONTEXT_MODEL.md, docs/INVENTORY_API.md.
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums.

export type ContextType =
  | "goal"
  | "task"
  | "plan"
  | "memory"
  | "file"
  | "diff"
  | "tool_output"
  | "terminal_output"
  | "test_result"
  | "retrieved_content"
  | (string & {});

export type ContextLifecycleState =
  "ACTIVE" | "COMPRESSED" | "TRANSFORMED" | "ARCHIVED" | "DROPPED";

export type GovernanceDecision = "KEEP" | "DROP" | "COMPRESS" | "TRANSFORM";

export interface ContextMetadata {
  priority: number; // normalized [0, 1]
  ageTurns: number; // integer >= 0
  references: number; // integer >= 0
  source: string;
  compressed: boolean;
  transformed: boolean;
  pinned: boolean; // pinned-ness per Sprint-1 amendment (Sprint 5 contract)
}

export interface ContextItem {
  id: string;
  type: ContextType;
  content: string;
  tokenCount: number; // integer >= 0; 0 only for DROPPED tombstones
  createdAt: string; // ISO-8601, from injected clock
  updatedAt: string; // ISO-8601, from injected clock
  metadata: ContextMetadata;
  state: ContextLifecycleState;
  revision: number; // integer >= 1; increments on successful mutation
  replacesId?: string;
  tags?: readonly string[];
}

export interface TokenEstimator {
  estimate(text: string, context?: { modelId?: string; encodingId?: string }): number;
}

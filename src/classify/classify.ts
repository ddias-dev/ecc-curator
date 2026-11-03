// src/classify/classify.ts
// ECC Curator - narrow deterministic context classifier (Phase 1 deliverable).
// Contract sources: docs/CONTEXT_CLASSIFIER.md (behaviour and limits) + the
// compiled contracts in src/types/classifier.ts and src/types/context.ts
// (imported, never modified) + docs/INVENTORY_API.md ("Context ingestion")
// for the NewContextItem projection.
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums;
// interface imports are `import type`, runtime values (error classes) are plain
// imports.
//
// Decided (documented choices the docs leave open):
// - Explicit type always wins: an explicitType is honoured even when it is not
//   in the vocabulary (ContextType allows extension strings); knownType=false
//   records that, and the classification is never rewritten to a guessed type.
// - Signal vocabulary is the single source of truth here: the ten ContextType
//   names map to themselves; a small documented alias table maps exact
//   normalized texts (e.g. "git_diff" -> diff). Content is never inspected, so
//   content-based guessing cannot occur.
// - Source normalization: trim + lowercase, split into tokens on whitespace,
//   commas, and semicolons, and fold hyphens to underscores ("Git-Diff" ->
//   git_diff), so "Git Diff ", "git-diff", and "test_output; run 2" produce
//   signal tokens. Tags normalize to trim + lowercase + hyphen fold only
//   (one tag = one signal; tags are exact-match, not token-split).
// - Matching rules: one distinct mapped type across all signals -> certain;
//   two or more -> ambiguous with sorted candidates and no type; zero signals
//   (or signals that match nothing) -> unrecognized. Agreeing source and tag
//   signals collapse to one type.
// - Ambiguity is never broken by preference: docs/CONTEXT_MODEL.md gives no
//   cross-type precedence for e.g. diff vs. file, so any conflict must be
//   resolved by the caller supplying an explicit type.
// - Determinism: no clock, no randomness, no iteration-order dependence;
//   candidates and signals are emitted in stable sorted order.

import type { ContextType } from "../types/context.ts";
import type { NewContextItem } from "../types/inventory.ts";
import type { ContextClassificationInput, ContextClassification, ContextClassificationSignal } from "../types/classifier.ts";
import { InvalidClassifierInputError, UnresolvedContextTypeError } from "../types/classifier.ts";

// Exact context-type vocabulary from src/types/context.ts (the open `(string & {})`
// arm of ContextType admits extensions; membership here only marks known types).
const KNOWN_CONTEXT_TYPES: readonly ContextType[] = [
  "goal",
  "task",
  "plan",
  "memory",
  "file",
  "diff",
  "tool_output",
  "terminal_output",
  "test_result",
  "retrieved_content",
];

// Signal vocabulary (docs/CONTEXT_CLASSIFIER.md "Signal vocabulary"). Identity
// entries let a host use the context-type name itself as its source token or
// tag; aliases are the small documented set below. Unlisted text matches
// nothing - it is never approximated.
const SIGNAL_ALIASES: ReadonlyMap<string, ContextType> = new Map<string, ContextType>([
  ["goal", "goal"],
  ["task", "task"],
  ["plan", "plan"],
  ["memory", "memory"],
  ["file", "file"],
  ["diff", "diff"],
  ["tool_output", "tool_output"],
  ["terminal_output", "terminal_output"],
  ["test_result", "test_result"],
  ["retrieved_content", "retrieved_content"],
  // Documented aliases only (kept deliberately narrow):
  ["user_goal", "goal"],
  ["git_diff", "diff"],
  ["patch", "diff"],
  ["build_log", "terminal_output"],
  ["runtime_log", "terminal_output"],
  ["test_output", "test_result"],
  ["command_output", "tool_output"],
  ["search_result", "retrieved_content"],
  ["documentation", "retrieved_content"],
]);

const KNOWN_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_CONTEXT_TYPES);

// Normalization (Decided): trim + lowercase, split into tokens on whitespace,
// commas, and semicolons, and fold hyphens to underscores so host-style "Git-Diff"
// matches the underscore-spelled context-type vocabulary ("git_diff" -> diff).
function normalizeSourceTokens(source: string): string[] {
  const tokens = source.trim().toLowerCase().split(/[\s,;]+/);
  const matched: string[] = [];
  for (const token of tokens) {
    if (token.length > 0) {
      matched.push(token.replaceAll("-", "_"));
    }
  }
  return matched;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function classifyContext(input: ContextClassificationInput): ContextClassification {
  const itemId = typeof input.id === "string" ? input.id : "";
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new InvalidClassifierInputError("", "invalid_id: context item id must be a non-empty string");
  }
  if (typeof input.content !== "string") {
    throw new InvalidClassifierInputError(itemId, "invalid_content: content must be a string");
  }
  if (typeof input.source !== "string") {
    throw new InvalidClassifierInputError(itemId, "invalid_source: source must be a string (ingestion requires it)");
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new InvalidClassifierInputError(itemId, "invalid_tags: tags must be an array of strings when present");
  }
  if (input.tags !== undefined) {
    for (const tag of input.tags) {
      if (typeof tag !== "string" || tag.trim().length === 0) {
        throw new InvalidClassifierInputError(itemId, "invalid_tag: tags must be non-empty strings");
      }
    }
  }

  // Collect matching explicit signals in stable audit order (source first,
  // then tags in input order), deduplicating repeated (kind,value) pairs.
  const signals: ContextClassificationSignal[] = [];
  const mappedTypes = new Map<ContextType, true>(); // insertion-free; sorted on emit
  for (const token of normalizeSourceTokens(input.source)) {
    const mapped = SIGNAL_ALIASES.get(token);
    if (mapped === undefined) {
      continue;
    }
    const duplicate = signals.some(
      (signal: ContextClassificationSignal) => signal.kind === "source" && signal.value === token,
    );
    if (!duplicate) {
      signals.push({ kind: "source", value: token, mappedType: mapped });
      mappedTypes.set(mapped, true);
    }
  }
  if (input.tags !== undefined) {
    for (const tag of input.tags) {
      const normalized = normalizeTag(tag);
      const mapped = SIGNAL_ALIASES.get(normalized);
      if (mapped === undefined) {
        continue;
      }
      const duplicate = signals.some(
        (signal: ContextClassificationSignal) => signal.kind === "tag" && signal.value === normalized,
      );
      if (!duplicate) {
        signals.push({ kind: "tag", value: normalized, mappedType: mapped });
        mappedTypes.set(mapped, true);
      }
    }
  }
  const candidates = [...mappedTypes.keys()].sort();

  const explicitType = input.explicitType;
  if (explicitType !== undefined) {
    if (typeof explicitType !== "string" || explicitType.length === 0) {
      throw new InvalidClassifierInputError(itemId, "invalid_explicit_type: explicit type must be a non-empty string when present");
    }
    const known = KNOWN_TYPE_SET.has(explicitType);
    const mismatch = candidates.some((candidate: ContextType) => candidate !== explicitType);
    const reasonCode =
      (known ? "EXPLICIT_TYPE_KNOWN" : "EXPLICIT_TYPE_EXTENSION") +
      (candidates.length === 0 ? "" : (mismatch ? "_MISMATCH_WITH_SIGNALS" : "_CONFIRMED_BY_SIGNALS"));
    return {
      itemId,
      type: explicitType,
      confidence: "explicit",
      knownType: known,
      candidates: [], // an explicit type is final; conflicting signals are audit-only
      signals,
      reasonCode,
    };
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    const fromSource = signals.some((signal: ContextClassificationSignal) => signal.mappedType === only && signal.kind === "source");
    const fromTag = signals.some((signal: ContextClassificationSignal) => signal.mappedType === only && signal.kind === "tag");
    const reasonCode = fromSource && fromTag ? "CONFIDING_SIGNALS" : fromSource ? "SINGLE_SOURCE_SIGNAL" : "SINGLE_TAG_SIGNAL";
    return {
      itemId,
      type: only,
      confidence: "certain",
      knownType: true,
      candidates: [],
      signals,
      reasonCode,
    };
  }

  if (candidates.length > 1) {
    return {
      itemId,
      type: undefined,
      confidence: "ambiguous",
      knownType: false,
      candidates,
      signals,
      reasonCode: "CONFLICTING_SIGNALS",
    };
  }

  return {
    itemId,
    type: undefined,
    confidence: "unrecognized",
    knownType: false,
    candidates: [],
    signals,
    reasonCode: "NO_MATCHING_SIGNALS",
  };
}

// Projects a resolved classification into the ingestion shape (docs/INVENTORY_API.md
// "Context ingestion"): source carried through, priority/age/references/flags
// left to the ingestion defaults. Ambiguous or unrecognized results throw
// UnresolvedContextTypeError - there is no default type to hand out.
export function toNewContextItem(input: ContextClassificationInput, classification: ContextClassification): NewContextItem {
  if (classification.confidence === "ambiguous" || classification.confidence === "unrecognized") {
    throw new UnresolvedContextTypeError(input.id, classification.confidence);
  }
  const type = classification.type;
  if (type === undefined) {
    throw new UnresolvedContextTypeError(input.id, "unrecognized");
  }
  return {
    id: input.id,
    type,
    content: input.content,
    metadata: { source: input.source },
  };
}

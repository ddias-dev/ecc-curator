// ECC Curator — context classifier contracts (experimental; see docs/CONTEXT_CLASSIFIER.md).
// Source of truth: docs/CONTEXT_MODEL.md ("Context Types"), docs/INVENTORY_API.md
// ("Context ingestion"), docs/CONTEXT_CLASSIFIER.md.
// Erasable TypeScript only (Node 24 type-stripping): string unions, no enums.
//
// The classifier is the narrow deterministic Phase 1 deliverable: it reads ONLY
// explicit signals (caller-supplied type, normalized source tokens, tags). It
// never guesses from content and never overrides a caller-provided type.
// Ambiguous or unrecognized inputs are surfaced explicitly; they are never
// silently coerced to a type.

import type { ContextType } from "./context.ts";

// One normalized input for classification. `source` is required because the
// ingestion contract (docs/INVENTORY_API.md "Context ingestion") requires
// metadata.source on every NewContextItem; classification happens before
// ingestion and its result feeds that contract unchanged.
export interface ContextClassificationInput {
  id: string; // non-empty string
  content: string; // string (not inspected for classification; size bounds apply)
  explicitType?: ContextType; // when present, wins over every inferred signal
  source: string; // explicit source metadata; signals from normalized tokens
  tags?: readonly string[]; // exact-match signals against the alias vocabulary
}

// "explicit"  : caller-provided type is honoured (knownType marks vocabulary
//               membership; an extension type is kept, never rewritten).
// "certain"   : exactly one context type is supported by the explicit signals.
// "ambiguous" : signals support two or more context types; `type` is undefined.
// "unrecognized": no signal matched; `type` is undefined.
export type ClassificationConfidence =
  | "explicit"
  | "certain"
  | "ambiguous"
  | "unrecognized";

// Audit trail: every explicit signal that matched the alias vocabulary, with
// the normalized matched text and the mapping it proposed (explainability).
export interface ContextClassificationSignal {
  kind: "source" | "tag";
  value: string; // normalized signal text that matched
  mappedType: ContextType;
}

export interface ContextClassification {
  itemId: string;
  type: ContextType | undefined; // defined only for explicit/certain confidence
  confidence: ClassificationConfidence;
  knownType: boolean; // false only for an explicit extension type
  candidates: readonly ContextType[]; // sorted; non-empty only when ambiguous
  signals: readonly ContextClassificationSignal[];
  reasonCode: string; // explicit deterministic reason (e.g. "CONFIDING_SIGNALS")
}

// Thrown when classify() receives malformed input (bad id/content/source/tags
// or an empty-string explicitType). Public classification functions either
// return the documented result or throw one of these typed errors.
export class InvalidClassifierInputError extends Error {
  code: string;
  itemId: string; // offending id, or "" when the id itself is invalid
  reason: string; // explicit validation reason code

  constructor(itemId: string, reason: string, message?: string) {
    super(message ?? `Invalid classifier input ${itemId}: ${reason}`);
    this.code = "INVALID_CLASSIFIER_INPUT";
    this.itemId = itemId;
    this.reason = reason;
  }
}

// Thrown when a caller tries to project an ambiguous/unrecognized classification
// into a NewContextItem. There is no default type: callers must resolve the
// type explicitly (docs/CONTEXT_CLASSIFIER.md, "No silent defaults").
export class UnresolvedContextTypeError extends Error {
  code: string;
  itemId: string;
  confidence: ClassificationConfidence; // the unresolved state ("ambiguous"/"unrecognized")

  constructor(itemId: string, confidence: ClassificationConfidence, message?: string) {
    super(message ?? `Context type unresolved for ${itemId} (confidence: ${confidence})`);
    this.code = "UNRESOLVED_CONTEXT_TYPE";
    this.itemId = itemId;
    this.confidence = confidence;
  }
}

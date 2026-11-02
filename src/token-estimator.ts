// src/token-estimator.ts
// Deterministic, conservative token estimation heuristic (no provider access).
// Contract source: docs/INVENTORY_API.md ("Token estimation is injected..."),
// IMPLEMENTATION_PLAN.md Sprint 1 ("Estimator is injected, conservative,
// never stores 0 for non-empty content; negative/non-finite estimate ->
// TokenEstimationError").

import type { TokenEstimator } from "./types/context.ts";
import { TokenEstimationError } from "./types/inventory.ts";

interface ModelContext {
  modelId?: string;
  encodingId?: string;
}

const ESTIMATOR_ID = "default-conservative";
const ESTIMATOR_VERSION = "1";

function countWordBoundaries(text: string): number {
  let count = 0;
  let inWord = false;
  for (const ch of text) {
    const isWhitespace = ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
    if (isWhitespace) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count += 1;
    }
  }
  return count;
}

function computeEstimate(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  // Conservative baseline: characters at roughly 3 chars per token, rounded up,
  // plus one token per whitespace-delimited word boundary contribution.
  const base = Math.ceil(text.length / 3);
  const wordContribution = countWordBoundaries(text);
  let estimate = base + wordContribution;
  if (base === 0 && text.length > 0) {
    // Never 0 for non-empty content (documented rule).
    estimate = 1;
  }
  return estimate;
}

export function makeDefaultEstimator(): TokenEstimator {
  return {
    estimate: (text: string, _context?: ModelContext): number => {
      const estimate = computeEstimate(text);
      if (!Number.isFinite(estimate) || estimate < 0) {
        throw new TokenEstimationError("negative_or_non_finite_estimate");
      }
      return estimate;
    },
  };
}

export const defaultTokenEstimator: TokenEstimator = makeDefaultEstimator();

export function estimateTokens(text: string): number {
  if (typeof text !== "string") {
    throw new TokenEstimationError("invalid_estimation_input");
  }
  const estimate = computeEstimate(text);
  if (!Number.isFinite(estimate) || estimate < 0) {
    throw new TokenEstimationError("negative_or_non_finite_estimate");
  }
  return estimate;
}

// tests/token-estimator.test.ts
// Runs via `node --test tests/` (Node 24 native TS type-stripping).
// Contracts under test (src/token-estimator.ts + docs):
//   - empty string estimates to 0
//   - non-empty content is never 0 (documented "never stores 0" rule)
//   - estimation is deterministic for identical input
//   - appending content is monotonic non-decreasing: estimate(A+B) >= estimate(A)
//     (the ceil/3 heuristic is NOT subadditive in the other direction, so only
//     the append-monotonic direction is asserted)
//   - conservative-ish for large text (>= ceil(length / 3) baseline)
//   - TokenEstimationError contract shape (code = TOKEN_ESTIMATION_FAILED,
//     reason = explicit failure reason) on invalid input

import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateTokens, defaultTokenEstimator, makeDefaultEstimator } from "../src/token-estimator.ts";
import { TokenEstimationError } from "../src/types/inventory.ts";

test("estimateTokens: empty string -> 0", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(defaultTokenEstimator.estimate(""), 0);
  assert.equal(makeDefaultEstimator().estimate(""), 0);
});

test("estimateTokens: non-empty never 0", () => {
  const samples: readonly string[] = [
    "a",
    " ",
    "\n",
    "hello",
    "hello world, this is a longer sample of text.",
  ];
  for (const sample of samples) {
    const viaFn = estimateTokens(sample);
    const viaDefault = defaultTokenEstimator.estimate(sample);
    assert.equal(viaFn, viaDefault);
    assert.ok(viaFn >= 1);
    assert.ok(Number.isInteger(viaFn));
  }
});

test("estimateTokens: deterministic for identical input", () => {
  const input = "The same input must always produce the same estimate.";
  const first = estimateTokens(input);
  const second = estimateTokens(input);
  const third = defaultTokenEstimator.estimate(input);
  const fourth = makeDefaultEstimator().estimate(input, { modelId: "unknown-model" });
  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(first, fourth);
});

test("estimateTokens: monotonic non-decreasing on append", () => {
  const bases: readonly string[] = ["", "hello", "hello world", "a\nb\tc"];
  const appended: readonly string[] = ["x", " more text", "\n\nnew paragraph here", ""];
  for (const a of bases) {
    for (const b of appended) {
      const estA = estimateTokens(a);
      const estAB = estimateTokens(a + b);
      const estB = estimateTokens(b);
      assert.ok(estAB >= estA);
      assert.ok(estAB >= estB);
    }
  }
});

test("estimateTokens: conservative-ish on large text", () => {
  const large = "lorem ipsum dolor amet " + "x".repeat(3000) + " tail words here";
  const estimate = estimateTokens(large);
  const viaDefault = defaultTokenEstimator.estimate(large);
  assert.equal(estimate, viaDefault);
  assert.ok(estimate >= Math.ceil(large.length / 3));
  assert.ok(estimate >= Math.floor(large.length / 4));
  assert.ok(Number.isFinite(estimate));
});

test("TokenEstimationError: contract shape on invalid input", () => {
  let thrown: TokenEstimationError | undefined = undefined;
  try {
    estimateTokens(42 as unknown as string);
  } catch (error) {
    if (error instanceof TokenEstimationError) {
      thrown = error;
    } else {
      throw error;
    }
  }
  if (thrown === undefined) {
    assert.fail("estimateTokens(non-string) must throw TokenEstimationError");
  }
  assert.equal(thrown.code, "TOKEN_ESTIMATION_FAILED");
  assert.equal(thrown.reason, "invalid_estimation_input");
  assert.ok(thrown instanceof Error);

  const direct = new TokenEstimationError("negative_or_non_finite_estimate");
  assert.equal(direct.code, "TOKEN_ESTIMATION_FAILED");
  assert.equal(direct.reason, "negative_or_non_finite_estimate");
});

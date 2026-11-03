import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyContext, toNewContextItem } from "../src/classify/classify.ts";
import { InvalidClassifierInputError, UnresolvedContextTypeError } from "../src/types/classifier.ts";

import type { ContextClassificationInput } from "../src/types/classifier.ts";

const goalItem: ContextClassificationInput = {
  id: "goal-1",
  content: "Release the boundary fix",
  source: "user_goal",
};

test("explicit type wins and is never rewritten, even when signals disagree", () => {
  const classification = classifyContext({
    id: "ctx-1",
    content: "some content",
    explicitType: "task",
    source: "git_diff",
  });

  assert.equal(classification.confidence, "explicit");
  assert.equal(classification.type, "task");
  assert.equal(classification.knownType, true);
  assert.deepEqual([...classification.candidates], []);
  assert.equal(classification.reasonCode, "EXPLICIT_TYPE_KNOWN_MISMATCH_WITH_SIGNALS");
  assert.deepEqual(
    classification.signals,
    [{ kind: "source", value: "git_diff", mappedType: "diff" }],
  );
});

test("an explicit extension type is honoured and flagged as not in the vocabulary", () => {
  const classification = classifyContext({
    id: "ctx-ext",
    content: "some content",
    explicitType: "conversation_history",
    source: "host-runtime",
  });

  assert.equal(classification.confidence, "explicit");
  assert.equal(classification.type, "conversation_history");
  assert.equal(classification.knownType, false);
  assert.equal(classification.reasonCode, "EXPLICIT_TYPE_EXTENSION");
});

test("source tokens map through the alias vocabulary with normalization", () => {
  const classification = classifyContext({
    id: "diff-1",
    content: "+++ b/src/fizz_buzz.js",
    source: " Git-Diff ",
  });

  assert.equal(classification.confidence, "certain");
  assert.equal(classification.type, "diff");
  assert.equal(classification.reasonCode, "SINGLE_SOURCE_SIGNAL");
  assert.deepEqual(classification.signals, [{ kind: "source", value: "git_diff", mappedType: "diff" }]);
});

test("source tokens split on whitespace, commas, and semicolons", () => {
  const classification = classifyContext({
    id: "test-1",
    content: "FAILED: 2 of 3 tests",
    source: "test_output; run 2027",
  });

  assert.equal(classification.type, "test_result");
  assert.equal(classification.confidence, "certain");
  assert.deepEqual(
    classification.signals,
    [{ kind: "source", value: "test_output", mappedType: "test_result" }],
  );
});

test("source and tag signals that agree collapse to one type", () => {
  const classification = classifyContext({
    id: "file-1",
    content: "export function shout(word) { ... }",
    source: "workspace",
    tags: ["file", "active"],
  });

  assert.equal(classification.confidence, "certain");
  assert.equal(classification.type, "file");
  assert.equal(classification.reasonCode, "SINGLE_TAG_SIGNAL");
  assert.deepEqual(classification.signals, [{ kind: "tag", value: "file", mappedType: "file" }]);
});

test("conflicting signals are ambiguous and resolve to no type", () => {
  const classification = classifyContext({
    id: "ctx-ambig",
    content: "some content",
    source: "git_diff",
    tags: ["file"],
  });

  assert.equal(classification.confidence, "ambiguous");
  assert.equal(classification.type, undefined);
  assert.deepEqual([...classification.candidates], ["diff", "file"]);
  assert.equal(classification.reasonCode, "CONFLICTING_SIGNALS");
  assert.deepEqual(
    classification.signals,
    [
      { kind: "source", value: "git_diff", mappedType: "diff" },
      { kind: "tag", value: "file", mappedType: "file" },
    ],
  );
});

test("no matching signal yields unrecognized, not a default type", () => {
  const classification = classifyContext({
    id: "ctx-unknown",
    content: "some content",
    source: "experimental-agent-runtime",
    tags: ["uncategorized"],
  });

  assert.equal(classification.confidence, "unrecognized");
  assert.equal(classification.type, undefined);
  assert.deepEqual([...classification.candidates], []);
  assert.equal(classification.reasonCode, "NO_MATCHING_SIGNALS");
  assert.deepEqual([...classification.signals], []);
});

test("content is never inspected: identical content classifies by metadata only", () => {
  const viaTag = classifyContext({ id: "a", content: "git diff --stat", source: "host", tags: ["terminal_output"] });
  const viaSource = classifyContext({ id: "b", content: "git diff --stat", source: "git_diff" });

  assert.equal(viaTag.type, "terminal_output");
  assert.equal(viaSource.type, "diff");
});

test("unresolved classifications project to ingestion items only after explicit resolution", () => {
  const input: ContextClassificationInput = { id: "ctx-ambig", content: "x", source: "git_diff", tags: ["file"] };
  const classification = classifyContext(input);

  assert.throws(
    () => toNewContextItem(input, classification),
    (error) => error instanceof UnresolvedContextTypeError,
  );
});

test("resolved classifications project to NewContextItem with the required source", () => {
  const input: ContextClassificationInput = { id: "plan-1", content: "Ship the release", source: "plan; roadmap" };
  const classification = classifyContext(input);
  const item = toNewContextItem(input, classification);

  assert.equal(classification.type, "plan");
  assert.deepEqual(item, {
    id: "plan-1",
    type: "plan",
    content: "Ship the release",
    metadata: { source: "plan; roadmap" },
  });
});

test("empty explicit type fails with an invalid-input error, not a silent classification", () => {
  assert.throws(
    () => classifyContext({ id: "bad-1", content: "x", source: "s", explicitType: "" }),
    InvalidClassifierInputError,
  );
});

test("missing or malformed id/content/source are rejected, not coerced", () => {
  assert.throws(
    () => classifyContext({ id: "", content: "x", source: "s" }),
    InvalidClassifierInputError,
  );
  assert.throws(
    () => classifyContext({ id: "bad", content: 42, source: "s" } as unknown as ContextClassificationInput),
    InvalidClassifierInputError,
  );
  assert.throws(
    () => classifyContext({ id: "bad", content: "x" } as unknown as ContextClassificationInput),
    InvalidClassifierInputError,
  );
});

test("blank and non-string tags are rejected", () => {
  assert.throws(
    () => classifyContext({ id: "bad", content: "x", source: "s", tags: [" "] }),
    InvalidClassifierInputError,
  );
  assert.throws(
    () => classifyContext({ id: "bad", content: "x", source: "s", tags: ["file", 7] as unknown as readonly string[] }),
    InvalidClassifierInputError,
  );
});

# Context Classifier

> Experimental and deliberately narrow. It classifies from explicit metadata
> only; it does not inspect content, use an LLM, or contact any external
> service. Classification is a convenience in front of the existing inventory
> ingestion contract, not a replacement for callers supplying a type.

The classifier is the Phase 1 deliverable behind `src/classify/classify.ts`
(contracts in `src/types/classifier.ts`, tested in `tests/classifier.test.ts`).
It answers one question — "what context type should this item carry?" — from
explicit signals, and refuses to answer when the signals do not support one.

## Inputs and signals

`classifyContext` takes a `ContextClassificationInput`:

- `explicitType` (optional) — caller-provided type. When present it always
  wins: it is honoured even if it is an extension outside the known vocabulary
  (`knownType: false` records that), and conflicting signals never rewrite it.
- `source` (required) — normalized: trimmed, lowercased, hyphens folded to
  underscores, then split on whitespace/commas/semicolons into tokens.
- `tags` (optional) — normalized to trim + lowercase + hyphen fold; tags match
  the vocabulary by exact text, they are not token-split.

Content is never inspected: the classifier cannot and does not guess from
content. Anything not in the signal vocabulary matches nothing.

## Signal vocabulary

The ten `ContextType` names map to themselves, plus a small documented alias
table (e.g. `git_diff`/`patch` → `diff`, `build_log`/`runtime_log` →
`terminal_output`, `test_output` → `test_result`, `command_output` →
`tool_output`, `search_result`/`documentation` → `retrieved_content`,
`user_goal` → `goal`). Unlisted text matches nothing; it is never approximated.
Keeping this list narrow is intentional: hosts add explicit signals, the
classifier does not invent them.

## Outcomes (`confidence`)

- `explicit` — the caller's type, with signals kept only as audit trail
  (`reasonCode` marks confirmation/mismatch/extension).
- `certain` — exactly one context type is supported by the matched signals
  (agreeing source and tag signals collapse to one type).
- `ambiguous` — signals support two or more types; `type` is `undefined` and
  `candidates` lists the sorted candidates. Ambiguity is **never** broken by
  preference: the documented `ContextType` model gives no cross-type
  precedence, so callers resolve it by passing `explicitType`.
- `unrecognized` — no signal matched; `type` is `undefined`. No default type is
  ever assigned.

Every result carries `signals` (the audit trail: matched text and the mapping
it proposed) and a `reasonCode`.

## No silent coercion

`toNewContextItem` projects a resolved classification into the `NewContextItem`
shape that inventory ingestion requires. Ambiguous or unrecognized results throw
`UnresolvedContextTypeError` — callers must resolve the type explicitly.
Malformed inputs (bad id/content/source/tags, empty `explicitType`) throw
`InvalidClassifierInputError` with an explicit reason; nothing is defaulted.

## Limits

- **Vocabulary-bound**: types outside `ContextType` are only accepted as
  explicit extension types (`knownType: false`), never inferred.
- **No automatic classification from content**: a `diff` and a `file` snippet
  with identical metadata classify identically; metadata is the contract.
- **No retrieval, memory, or provider involvement**: the classifier stays
  deterministic and offline; Phase 3+ decision intelligence does not feed it.
- **Experimental status**: classification currently exists as a helper for
  ingestion (benchmark context inputs still carry explicit types). No
  integration governs full conversations or tool turns, and no quality benefit
  from classification has been measured or claimed.

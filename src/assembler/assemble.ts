import type {
  ApprovedContextItem,
  AssemblyBudget,
  AssemblyReport,
  AssemblyRequest,
  AssemblyResult,
  AssemblyItemRecord,
  PromptSegment,
  PromptSerialization,
  PromptTokenEstimator,
} from "../types/assembler.ts";

export class InvalidAssemblyBudgetError extends Error {
  readonly reason = "invalid_budget";

  constructor(detail: string) {
    super(`Invalid assembly budget: ${detail}`);
    this.name = "InvalidAssemblyBudgetError";
  }
}

export class InvalidTokenEstimateError extends Error {
  readonly reason = "invalid_token_estimate";

  constructor(detail: string) {
    super(`Invalid token estimate: ${detail}`);
    this.name = "InvalidTokenEstimateError";
  }
}

const isNonNegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const addTokenCounts = (left: number, right: number, detail: string): number => {
  const total = left + right;
  if (!isNonNegativeSafeInteger(total)) {
    throw new InvalidTokenEstimateError(`${detail} exceeds the safe integer range`);
  }
  return total;
};

export function deriveInputLimit(budget: AssemblyBudget): number {
  const budgetFields: readonly (readonly [string, number | undefined])[] = [
    ["contextWindowTokens", budget.contextWindowTokens],
    ["outputReserveTokens", budget.outputReserveTokens],
    ["safetyMarginTokens", budget.safetyMarginTokens],
    ["maxPromptTokens", budget.maxPromptTokens],
  ];

  for (const [field, value] of budgetFields) {
    if (value !== undefined && !isNonNegativeSafeInteger(value)) {
      throw new InvalidAssemblyBudgetError(`${field} must be a non-negative safe integer`);
    }
  }

  const availableByWindow =
    budget.contextWindowTokens - budget.outputReserveTokens - budget.safetyMarginTokens;
  const inputLimit = budget.maxPromptTokens === undefined
    ? availableByWindow
    : Math.min(availableByWindow, budget.maxPromptTokens);
  if (!isNonNegativeSafeInteger(inputLimit)) {
    throw new InvalidAssemblyBudgetError("reserved tokens exceed the context window");
  }
  return inputLimit;
}

export function countFixedSegments(
  segments: readonly PromptSegment[],
  estimator: PromptTokenEstimator,
): number {
  const seenIds = new Set<string>();
  let tokenCount = 0;

  for (const segment of segments) {
    if (!segment.fixed) {
      throw new InvalidTokenEstimateError(`segment ${segment.id} is not fixed`);
    }
    if (seenIds.has(segment.id)) {
      throw new InvalidTokenEstimateError(`duplicate fixed segment id ${segment.id}`);
    }
    seenIds.add(segment.id);

    const segmentTokens = estimator.countSegment(segment);
    if (!isNonNegativeSafeInteger(segmentTokens)) {
      throw new InvalidTokenEstimateError(
        `fixed segment ${segment.id} estimate must be a non-negative safe integer`,
      );
    }
    tokenCount = addTokenCounts(tokenCount, segmentTokens, "fixed segment token total");
  }

  return tokenCount;
}

export function countCandidateTokens(
  candidate: ApprovedContextItem,
  estimator: PromptTokenEstimator,
): number {
  const tokenCount = estimator.countContextItem(candidate.item);
  if (!isNonNegativeSafeInteger(tokenCount)) {
    throw new InvalidTokenEstimateError(
      `candidate ${candidate.item.id} estimate must be a non-negative safe integer`,
    );
  }
  return tokenCount;
}

const CONTEXT_TYPE_ORDER: Readonly<Record<string, number>> = {
  goal: 0,
  task: 1,
  file: 2,
  diff: 2,
  memory: 3,
  test_result: 4,
  plan: 5,
  retrieved_content: 6,
  tool_output: 7,
  terminal_output: 7,
};

const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function compareCandidates(
  left: ApprovedContextItem,
  right: ApprovedContextItem,
): number {
  const leftPinned = left.item.metadata.pinned ? 1 : 0;
  const rightPinned = right.item.metadata.pinned ? 1 : 0;
  const leftTypeOrder = CONTEXT_TYPE_ORDER[left.item.type] ?? Number.MAX_SAFE_INTEGER;
  const rightTypeOrder = CONTEXT_TYPE_ORDER[right.item.type] ?? Number.MAX_SAFE_INTEGER;

  return rightPinned - leftPinned ||
    right.score - left.score ||
    left.policyPriority - right.policyPriority ||
    leftTypeOrder - rightTypeOrder ||
    left.item.metadata.ageTurns - right.item.metadata.ageTurns ||
    right.item.metadata.references - left.item.metadata.references ||
    left.tokenCount - right.tokenCount ||
    compareOrdinal(left.item.id, right.item.id);
}

export function deriveAllocationCaps(
  allocations: Readonly<Record<string, number>> | undefined,
  candidateBudgetTokens: number,
): Readonly<Record<string, number>> {
  if (!isNonNegativeSafeInteger(candidateBudgetTokens)) {
    throw new InvalidAssemblyBudgetError("candidate budget must be a non-negative safe integer");
  }
  if (allocations === undefined) {
    return Object.freeze({});
  }

  let totalFraction = 0;
  const entries = Object.entries(allocations);
  for (const [category, fraction] of entries) {
    if (category.length === 0 || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw new InvalidAssemblyBudgetError(
        `allocation for ${category || "(empty category)"} must be finite and in [0,1]`,
      );
    }
    totalFraction += fraction;
  }
  if (!Number.isFinite(totalFraction) || totalFraction > 1) {
    throw new InvalidAssemblyBudgetError("allocation fractions must sum to at most 1");
  }

  return Object.freeze(Object.fromEntries(
    entries.map(([category, fraction]) => [
      category,
      Math.floor(candidateBudgetTokens * fraction),
    ]),
  ));
}

interface MeasuredCandidate {
  candidate: ApprovedContextItem;
  tokenCount: number;
}

interface CandidateSelection {
  included: readonly MeasuredCandidate[];
  excluded: readonly MeasuredCandidate[];
  includedTokens: number;
  pinnedOverflow: boolean;
}

export function selectCandidates(
  candidates: readonly ApprovedContextItem[],
  contextBudgetTokens: number,
  estimator: PromptTokenEstimator,
  allocations?: Readonly<Record<string, number>>,
): CandidateSelection {
  if (!isNonNegativeSafeInteger(contextBudgetTokens)) {
    throw new InvalidAssemblyBudgetError("context-item budget must be a non-negative safe integer");
  }

  const seenIds = new Set<string>();
  const measured = candidates.map((candidate): MeasuredCandidate => {
    if (seenIds.has(candidate.item.id)) {
      throw new InvalidTokenEstimateError(`duplicate candidate item id ${candidate.item.id}`);
    }
    seenIds.add(candidate.item.id);
    return { candidate, tokenCount: countCandidateTokens(candidate, estimator) };
  });
  measured.reduce(
    (total, { tokenCount }) => addTokenCounts(total, tokenCount, "candidate token total"),
    0,
  );
  const ordered = [...measured].sort((left, right) =>
    compareCandidates(left.candidate, right.candidate)
  );
  const pinned = ordered.filter(({ candidate }) => candidate.item.metadata.pinned);
  const nonPinned = ordered.filter(({ candidate }) => !candidate.item.metadata.pinned);
  const included = [...pinned];
  const includedIds = new Set(pinned.map(({ candidate }) => candidate.item.id));
  const categoryUse = new Map<string, number>();
  let includedTokens = 0;
  for (const { candidate, tokenCount } of pinned) {
    includedTokens = addTokenCounts(includedTokens, tokenCount, "pinned candidate token total");
    categoryUse.set(
      candidate.category,
      addTokenCounts(
        categoryUse.get(candidate.category) ?? 0,
        tokenCount,
        `pinned category ${candidate.category} token total`,
      ),
    );
  }

  const caps = deriveAllocationCaps(allocations, contextBudgetTokens);
  const allocationLimit = allocations === undefined
    ? contextBudgetTokens
    : Object.values(caps).reduce((sum, cap) => sum + cap, 0);

  for (const measuredCandidate of nonPinned) {
    const { candidate, tokenCount } = measuredCandidate;
    const cap = caps[candidate.category];
    if (
      cap !== undefined &&
      includedTokens + tokenCount <= contextBudgetTokens &&
      (categoryUse.get(candidate.category) ?? 0) + tokenCount <= cap
    ) {
      included.push(measuredCandidate);
      includedTokens = addTokenCounts(includedTokens, tokenCount, "included candidate token total");
      categoryUse.set(candidate.category, addTokenCounts(
        categoryUse.get(candidate.category) ?? 0,
        tokenCount,
        `category ${candidate.category} token total`,
      ));
      includedIds.add(candidate.item.id);
    }
  }

  for (const measuredCandidate of nonPinned) {
    const { candidate, tokenCount } = measuredCandidate;
    if (
      includedIds.has(candidate.item.id) ||
      includedTokens + tokenCount > contextBudgetTokens ||
      includedTokens + tokenCount > allocationLimit
    ) {
      continue;
    }
    included.push(measuredCandidate);
    includedTokens = addTokenCounts(includedTokens, tokenCount, "included candidate token total");
    includedIds.add(candidate.item.id);
  }

  included.sort((left, right) => compareCandidates(left.candidate, right.candidate));
  const excluded = ordered.filter(({ candidate }) => !includedIds.has(candidate.item.id));
  return {
    included,
    excluded,
    includedTokens,
    pinnedOverflow: includedTokens > contextBudgetTokens,
  };
}

const toAssemblyItemRecord = (
  measured: MeasuredCandidate,
  included: boolean,
): AssemblyItemRecord => ({
  itemId: measured.candidate.item.id,
  category: measured.candidate.category,
  tokenCount: measured.tokenCount,
  score: measured.candidate.score,
  reasonCode: included ? "ASSEMBLY_INCLUDED" : "ASSEMBLY_BUDGET_OVERFLOW",
});

export function createAssemblyReport(
  selection: CandidateSelection,
  fixedSegmentTokens: number,
  serializedPackageTokens: number,
  overflow?: AssemblyReport["overflow"],
): AssemblyReport {
  if (
    !isNonNegativeSafeInteger(fixedSegmentTokens) ||
    !isNonNegativeSafeInteger(serializedPackageTokens)
  ) {
    throw new InvalidTokenEstimateError("report token counts must be non-negative safe integers");
  }

  const allocationUse: Record<string, number> = {};
  for (const { candidate, tokenCount } of selection.included) {
    allocationUse[candidate.category] = addTokenCounts(
      allocationUse[candidate.category] ?? 0,
      tokenCount,
      `reported category ${candidate.category} token total`,
    );
  }

  return Object.freeze({
    included: Object.freeze(selection.included.map((measured) => toAssemblyItemRecord(measured, true))),
    excluded: Object.freeze(selection.excluded.map((measured) => toAssemblyItemRecord(measured, false))),
    tokenCounts: Object.freeze({
      fixedSegments: fixedSegmentTokens,
      contextItems: selection.includedTokens,
      serializedPackage: serializedPackageTokens,
    }),
    allocationUse: Object.freeze(allocationUse),
    ...(overflow === undefined ? {} : { overflow: Object.freeze({
      ...overflow,
      pinnedItemIds: Object.freeze([...overflow.pinnedItemIds]),
    }) }),
  });
}

export function fixedPromptOverflowResult(
  fixedSegmentTokens: number,
  inputLimitTokens: number,
): AssemblyResult {
  const report = createAssemblyReport(
    { included: [], excluded: [], includedTokens: 0, pinnedOverflow: false },
    fixedSegmentTokens,
    fixedSegmentTokens,
    {
      requiredTokens: fixedSegmentTokens,
      availableTokens: inputLimitTokens,
      pinnedItemIds: [],
    },
  );
  return Object.freeze({ ok: false, error: "FixedPromptOverflow", report });
}

export function pinnedContextOverflowResult(
  selection: CandidateSelection,
  fixedSegmentTokens: number,
  inputLimitTokens: number,
): AssemblyResult {
  const pinnedItems = selection.included.filter(
    ({ candidate }) => candidate.item.metadata.pinned,
  );
  const pinnedTokens = pinnedItems.reduce(
    (sum, { tokenCount }) => addTokenCounts(sum, tokenCount, "pinned candidate token total"),
    0,
  );
  const requiredTokens = addTokenCounts(
    fixedSegmentTokens,
    pinnedTokens,
    "fixed and pinned token total",
  );
  const baseReport = createAssemblyReport(
    {
      ...selection,
      included: pinnedItems,
      excluded: [
        ...selection.excluded,
        ...selection.included.filter(({ candidate }) => !candidate.item.metadata.pinned),
      ],
      includedTokens: pinnedTokens,
    },
    fixedSegmentTokens,
    requiredTokens,
    {
      requiredTokens,
      availableTokens: inputLimitTokens,
      pinnedItemIds: pinnedItems.map(({ candidate }) => candidate.item.id),
    },
  );
  const report = Object.freeze({
    ...baseReport,
    included: Object.freeze(baseReport.included.map((record) => Object.freeze({
      ...record,
      reasonCode: "ASSEMBLY_PINNED_OVERFLOW",
    }))),
  });
  return Object.freeze({ ok: false, error: "PinnedContextOverflow", report });
}

interface SerializedPrompt {
  segments: readonly PromptSegment[];
  contextItems: readonly ApprovedContextItem["item"][];
  serializedInput: string;
  tokenCount: number;
}

export function serializeSelection(
  fixedSegments: readonly PromptSegment[],
  selection: CandidateSelection,
  serialization: PromptSerialization,
  estimator: PromptTokenEstimator,
): SerializedPrompt {
  const segments = [...fixedSegments].sort((left, right) =>
    left.order - right.order || compareOrdinal(left.id, right.id)
  );
  const contextItems = selection.included.map(({ candidate }) => candidate.item);
  const serializedInput = serialization.serialize(segments, contextItems);
  if (typeof serializedInput !== "string") {
    throw new InvalidTokenEstimateError("serializer must return a string");
  }
  const tokenCount = estimator.countSerialized(serializedInput);
  if (!isNonNegativeSafeInteger(tokenCount)) {
    throw new InvalidTokenEstimateError("serialized prompt estimate must be a non-negative safe integer");
  }

  return {
    segments,
    contextItems,
    serializedInput,
    tokenCount,
  };
}

interface SerializationFit {
  selection: CandidateSelection;
  serialized: SerializedPrompt;
  failure?: AssemblyResult;
}

function serializationOverflowResult(
  error: "FixedPromptOverflow" | "PinnedContextOverflow" | "UnresolvableOverflow",
  selection: CandidateSelection,
  fixedSegmentTokens: number,
  serializedTokens: number,
  inputLimitTokens: number,
): AssemblyResult {
  const pinnedItems = selection.included.filter(
    ({ candidate }) => candidate.item.metadata.pinned,
  );
  const report = createAssemblyReport(
    selection,
    fixedSegmentTokens,
    serializedTokens,
    {
      requiredTokens: serializedTokens,
      availableTokens: inputLimitTokens,
      pinnedItemIds: pinnedItems.map(({ candidate }) => candidate.item.id),
    },
  );
  return Object.freeze({ ok: false, error, report });
}

export function fitSerializedBudget(
  fixedSegments: readonly PromptSegment[],
  selection: CandidateSelection,
  serialization: PromptSerialization,
  estimator: PromptTokenEstimator,
  fixedSegmentTokens: number,
  inputLimitTokens: number,
  overflowPolicy: AssemblyRequest["overflowPolicy"] = "exclude-lowest-ranked",
): SerializationFit {
  let currentSelection = selection;
  let serialized = serializeSelection(fixedSegments, currentSelection, serialization, estimator);
  if (serialized.tokenCount <= inputLimitTokens) {
    return { selection: currentSelection, serialized };
  }

  if (overflowPolicy === "error" && currentSelection.included.some(
    ({ candidate }) => !candidate.item.metadata.pinned,
  )) {
    return {
      selection: currentSelection,
      serialized,
      failure: serializationOverflowResult(
        "UnresolvableOverflow",
        currentSelection,
        fixedSegmentTokens,
        serialized.tokenCount,
        inputLimitTokens,
      ),
    };
  }

  while (serialized.tokenCount > inputLimitTokens) {
    let removableIndex = -1;
    for (let index = currentSelection.included.length - 1; index >= 0; index -= 1) {
      if (!currentSelection.included[index]?.candidate.item.metadata.pinned) {
        removableIndex = index;
        break;
      }
    }

    if (removableIndex < 0) {
      const hasPins = currentSelection.included.some(
        ({ candidate }) => candidate.item.metadata.pinned,
      );
      return {
        selection: currentSelection,
        serialized,
        failure: serializationOverflowResult(
          hasPins ? "PinnedContextOverflow" : "FixedPromptOverflow",
          currentSelection,
          fixedSegmentTokens,
          serialized.tokenCount,
          inputLimitTokens,
        ),
      };
    }

    const removed = currentSelection.included[removableIndex];
    if (removed === undefined) {
      throw new Error("Assembler selection changed during overflow handling");
    }
    currentSelection = {
      ...currentSelection,
      included: currentSelection.included.filter((_, index) => index !== removableIndex),
      excluded: [...currentSelection.excluded, removed].sort((left, right) =>
        compareCandidates(left.candidate, right.candidate)
      ),
      includedTokens: currentSelection.includedTokens - removed.tokenCount,
    };
    serialized = serializeSelection(fixedSegments, currentSelection, serialization, estimator);
  }

  return { selection: currentSelection, serialized };
}

const emptyReport = (): AssemblyReport => Object.freeze({
  included: Object.freeze([]),
  excluded: Object.freeze([]),
  tokenCounts: Object.freeze({
    fixedSegments: 0,
    contextItems: 0,
    serializedPackage: 0,
  }),
  allocationUse: Object.freeze({}),
});

const invalidBudgetResult = (): AssemblyResult => ({
  ok: false,
  error: "InvalidBudget",
  report: emptyReport(),
});

const invalidTokenEstimateResult = (): AssemblyResult => ({
  ok: false,
  error: "InvalidTokenEstimate",
  report: emptyReport(),
});

export function assemble(request: AssemblyRequest): AssemblyResult {
  let inputLimitTokens: number;
  try {
    inputLimitTokens = deriveInputLimit(request.budget);
  } catch (error) {
    if (error instanceof InvalidAssemblyBudgetError) {
      return invalidBudgetResult();
    }
    throw error;
  }

  let fixedSegmentTokens: number;
  try {
    fixedSegmentTokens = countFixedSegments(request.fixedSegments, request.estimator);
  } catch (error) {
    if (error instanceof InvalidTokenEstimateError) {
      return invalidTokenEstimateResult();
    }
    throw error;
  }
  if (fixedSegmentTokens > inputLimitTokens) {
    return fixedPromptOverflowResult(fixedSegmentTokens, inputLimitTokens);
  }

  let selection: CandidateSelection;
  try {
    selection = selectCandidates(
      request.candidates,
      inputLimitTokens - fixedSegmentTokens,
      request.estimator,
      request.allocations,
    );
  } catch (error) {
    if (error instanceof InvalidAssemblyBudgetError) {
      return invalidBudgetResult();
    }
    if (error instanceof InvalidTokenEstimateError) {
      return invalidTokenEstimateResult();
    }
    throw error;
  }

  if (selection.pinnedOverflow) {
    try {
      return pinnedContextOverflowResult(selection, fixedSegmentTokens, inputLimitTokens);
    } catch (error) {
      if (error instanceof InvalidTokenEstimateError) {
        return invalidTokenEstimateResult();
      }
      throw error;
    }
  }

  let fit: SerializationFit;
  try {
    fit = fitSerializedBudget(
      request.fixedSegments,
      selection,
      request.serialization,
      request.estimator,
      fixedSegmentTokens,
      inputLimitTokens,
      request.overflowPolicy,
    );
  } catch (error) {
    if (error instanceof InvalidTokenEstimateError) {
      return invalidTokenEstimateResult();
    }
    throw error;
  }
  if (fit.failure !== undefined) {
    return fit.failure;
  }

  let requiredTokens: number;
  try {
    const allCandidateTokens = [...fit.selection.included, ...fit.selection.excluded]
      .reduce(
        (sum, candidate) => addTokenCounts(sum, candidate.tokenCount, "candidate token total"),
        0,
      );
    requiredTokens = addTokenCounts(
      fixedSegmentTokens,
      allCandidateTokens,
      "required prompt token total",
    );
  } catch (error) {
    if (error instanceof InvalidTokenEstimateError) {
      return invalidTokenEstimateResult();
    }
    throw error;
  }
  const pinnedItemIds = fit.selection.included
    .filter(({ candidate }) => candidate.item.metadata.pinned)
    .map(({ candidate }) => candidate.item.id);
  const report = createAssemblyReport(
    fit.selection,
    fixedSegmentTokens,
    fit.serialized.tokenCount,
    fit.selection.excluded.length === 0
      ? undefined
      : {
        requiredTokens,
        availableTokens: inputLimitTokens,
        pinnedItemIds,
      },
  );
  const promptPackage = Object.freeze({
    schemaVersion: "1" as const,
    segments: Object.freeze([...fit.serialized.segments]),
    contextItems: Object.freeze([...fit.serialized.contextItems]),
    serializedInput: fit.serialized.serializedInput,
    tokenCount: fit.serialized.tokenCount,
    budget: Object.freeze({
      contextWindowTokens: request.budget.contextWindowTokens,
      outputReserveTokens: request.budget.outputReserveTokens,
      safetyMarginTokens: request.budget.safetyMarginTokens,
      inputLimitTokens,
      remainingTokens: inputLimitTokens - fit.serialized.tokenCount,
    }),
    report,
  });
  return Object.freeze({ ok: true, package: promptPackage });
}

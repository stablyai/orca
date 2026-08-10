/**
 * Sampled byte hypotheses for large top-level state collections.
 * Sampling and object-cost assumptions can under- or over-estimate.
 */

const SAMPLE_TARGET = 16
const SAMPLE_WINDOW = 1024
const NODE_BUDGET_PER_SLICE = 4096
const ENTRY_SCAN_BUDGET_PER_SLICE = 4096
const ENTRY_DESCENT_RESERVE = 1024
const MAX_DEPTH = 12

const BYTES_STRING_BASE = 16
const BYTES_PER_CHAR = 2
const BYTES_NUMBER = 16
const BYTES_PRIMITIVE = 8
const BYTES_FUNCTION = 64
const BYTES_OBJECT_BASE = 32
const BYTES_ENTRY_OVERHEAD = 16
const BYTES_ARRAY_SLOT = 8
const BYTES_PER_KILOBYTE = 1024

type EstimateContext = {
  nodesLeft: number
  entriesLeft: number
  budgetHit: boolean
  externalBytes: number
  seen: WeakSet<object>
  seenExternal: WeakSet<object>
}

export type StateCollectionMemoryEstimate = {
  counts: Record<string, number>
  heuristicOnHeapKB: number
  heuristicExternalKB: number
}

export function estimateStateCollectionMemoryKB(
  state: unknown,
  limit: number
): StateCollectionMemoryEstimate {
  if (typeof state !== 'object' || state === null) {
    return { counts: {}, heuristicOnHeapKB: 0, heuristicExternalKB: 0 }
  }
  const onHeapSizes: [string, number][] = []
  let onHeapBytes = 0
  let externalBytes = 0
  let successfulSlices = 0
  let budgetHitSlices = 0
  for (const key in state) {
    if (!Object.hasOwn(state, key)) {
      continue
    }
    try {
      const context: EstimateContext = {
        nodesLeft: NODE_BUDGET_PER_SLICE,
        entriesLeft: ENTRY_SCAN_BUDGET_PER_SLICE + ENTRY_DESCENT_RESERVE,
        budgetHit: false,
        externalBytes: 0,
        seen: new WeakSet(),
        seenExternal: new WeakSet()
      }
      const sliceBytes = estimateValueBytes((state as Record<string, unknown>)[key], 0, context)
      onHeapBytes += sliceBytes
      externalBytes += context.externalBytes
      successfulSlices += 1
      if (context.budgetHit) {
        budgetHitSlices += 1
      }
      const sliceKB = Math.round(sliceBytes / BYTES_PER_KILOBYTE)
      if (sliceKB > 0) {
        onHeapSizes.push([key, sliceKB])
      }
    } catch {
      continue
    }
  }
  if (successfulSlices === 0) {
    return { counts: {}, heuristicOnHeapKB: 0, heuristicExternalKB: 0 }
  }
  const heuristicOnHeapKB = Math.round(onHeapBytes / BYTES_PER_KILOBYTE)
  const heuristicExternalKB = Math.round(externalBytes / BYTES_PER_KILOBYTE)
  onHeapSizes.sort((left, right) => right[1] - left[1])
  return {
    counts: {
      ...(budgetHitSlices > 0 ? { __budgetHitSlices: budgetHitSlices } : {}),
      ...Object.fromEntries(
        onHeapSizes.slice(0, limit).map(([key, value]) => [`onHeap.${key}`, value])
      )
    },
    heuristicOnHeapKB,
    heuristicExternalKB
  }
}

export function estimateStateCollectionKB(state: unknown, limit: number): Record<string, number> {
  return estimateStateCollectionMemoryKB(state, limit).counts
}

function estimateValueBytes(value: unknown, depth: number, context: EstimateContext): number {
  if (context.nodesLeft <= 0) {
    context.budgetHit = true
    return 0
  }
  context.nodesLeft -= 1
  switch (typeof value) {
    case 'string':
      return BYTES_STRING_BASE + value.length * BYTES_PER_CHAR
    case 'number':
      return BYTES_NUMBER
    case 'function':
      return BYTES_FUNCTION
    case 'object':
      break
    case 'bigint':
    case 'boolean':
    case 'symbol':
    case 'undefined':
      return BYTES_PRIMITIVE
  }
  if (value === null) {
    return BYTES_PRIMITIVE
  }
  if (context.seen.has(value)) {
    return 0
  }
  context.seen.add(value)
  if (depth >= MAX_DEPTH) {
    context.budgetHit = true
    return BYTES_OBJECT_BASE
  }
  if (Array.isArray(value)) {
    return (
      BYTES_OBJECT_BASE +
      value.length * BYTES_ARRAY_SLOT +
      estimateArrayElements(value, depth, context)
    )
  }
  if (value instanceof Map) {
    return (
      BYTES_OBJECT_BASE + estimateIterableEntries(value.size, value.entries(), depth, context, true)
    )
  }
  if (value instanceof Set) {
    return (
      BYTES_OBJECT_BASE + estimateIterableEntries(value.size, value.values(), depth, context, false)
    )
  }
  if (ArrayBuffer.isView(value)) {
    countExternalBytes(value.buffer, value.buffer.byteLength, context)
    return BYTES_OBJECT_BASE
  }
  if (value instanceof ArrayBuffer) {
    countExternalBytes(value, value.byteLength, context)
    return BYTES_OBJECT_BASE
  }
  return BYTES_OBJECT_BASE + estimatePlainObjectEntries(value, depth, context)
}

function countExternalBytes(identity: object, bytes: number, context: EstimateContext): void {
  if (context.seenExternal.has(identity)) {
    return
  }
  context.seenExternal.add(identity)
  context.externalBytes += bytes
}

function estimateArrayElements(value: unknown[], depth: number, context: EstimateContext): number {
  const windowLength = Math.min(value.length, SAMPLE_WINDOW)
  if (windowLength === 0) {
    return 0
  }
  const stride = Math.max(1, Math.floor(windowLength / SAMPLE_TARGET))
  let sampledBytes = 0
  let sampledCount = 0
  for (let index = 0; index < windowLength; index += stride) {
    sampledBytes += estimateValueBytes(value[index], depth + 1, context)
    sampledCount += 1
  }
  return sampledCount === 0 ? 0 : Math.round((sampledBytes / sampledCount) * value.length)
}

function estimateIterableEntries(
  size: number,
  entries: IterableIterator<unknown>,
  depth: number,
  context: EstimateContext,
  isKeyValuePair: boolean
): number {
  if (size === 0) {
    return 0
  }
  const windowLength = Math.min(size, SAMPLE_WINDOW)
  const stride = Math.max(1, Math.floor(windowLength / SAMPLE_TARGET))
  let sampledBytes = 0
  let sampledCount = 0
  let index = 0
  for (const entry of entries) {
    if (index >= windowLength) {
      break
    }
    if (context.entriesLeft <= 0) {
      context.budgetHit = true
      break
    }
    context.entriesLeft -= 1
    if (index % stride === 0) {
      if (isKeyValuePair) {
        const [entryKey, entryValue] = entry as [unknown, unknown]
        sampledBytes += estimateValueBytes(entryKey, depth + 1, context)
        sampledBytes += estimateValueBytes(entryValue, depth + 1, context)
      } else {
        sampledBytes += estimateValueBytes(entry, depth + 1, context)
      }
      sampledCount += 1
    }
    index += 1
  }
  return sampledCount === 0
    ? 0
    : Math.round((sampledBytes / sampledCount + BYTES_ENTRY_OVERHEAD) * size)
}

function estimatePlainObjectEntries(
  value: object,
  depth: number,
  context: EstimateContext
): number {
  let ownCount = 0
  const sampledKeys: string[] = []
  const entryFloor = depth === 0 ? ENTRY_DESCENT_RESERVE : 0
  for (const key in value) {
    if (context.entriesLeft <= entryFloor) {
      context.budgetHit = true
      break
    }
    context.entriesLeft -= 1
    if (Object.hasOwn(value, key)) {
      ownCount += 1
      if (sampledKeys.length < SAMPLE_TARGET) {
        sampledKeys.push(key)
      }
    }
  }
  if (ownCount === 0) {
    return 0
  }
  let sampledBytes = 0
  for (const key of sampledKeys) {
    sampledBytes += BYTES_STRING_BASE + key.length * BYTES_PER_CHAR
    sampledBytes += estimateValueBytes((value as Record<string, unknown>)[key], depth + 1, context)
  }
  return sampledKeys.length === 0
    ? 0
    : Math.round((sampledBytes / sampledKeys.length + BYTES_ENTRY_OVERHEAD) * ownCount)
}

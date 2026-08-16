/**
 * Sampled byte estimates for the largest top-level collections in a state
 * object, for renderer_memory_highwater breadcrumbs.
 *
 * Why bytes when summarizeStateCollectionSizes already reports counts: entry
 * counts stay flat when a slice grows by VALUE weight — the 97b9e86d OOM leaked
 * ~700MB while its biggest slice grew by 4 entries. Counts name what got LONG;
 * these estimates name what got FAT.
 *
 * Estimates are heuristic (sampled, extrapolated, shared references counted
 * per slice). __budgetHitSlices marks totals that saturated the scan budget.
 */

// Why sampling is capped and first-window biased: this runs at >=60% heap
// pressure, so bounded work beats unbiased coverage. Iteration allocates
// nothing beyond the sample window; there is no stringify.
const SAMPLE_TARGET = 16
const SAMPLE_WINDOW = 1024
const NODE_BUDGET_PER_SLICE = 4096
const ENTRY_SCAN_BUDGET_PER_SLICE = 4096
const ENTRY_DESCENT_RESERVE = 1024
const MAX_DEPTH = 12

// Rough V8 object costs; absolute accuracy doesn't matter, stable ranking does.
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
  seen: WeakSet<object>
}

export function estimateStateCollectionKB(state: unknown, limit: number): Record<string, number> {
  if (typeof state !== 'object' || state === null) {
    return {}
  }
  const sizes: [string, number][] = []
  let totalBytes = 0
  let successfulSlices = 0
  let budgetHitSlices = 0
  for (const key in state) {
    if (!Object.hasOwn(state, key)) {
      continue
    }
    let kb = 0
    // Why: one exotic slice (throwing getter, revoked proxy) must not sink the
    // whole census; the registry only sees the surviving slices.
    try {
      const ctx: EstimateContext = {
        nodesLeft: NODE_BUDGET_PER_SLICE,
        entriesLeft: ENTRY_SCAN_BUDGET_PER_SLICE + ENTRY_DESCENT_RESERVE,
        budgetHit: false,
        seen: new WeakSet()
      }
      const bytes = estimateValueBytes((state as Record<string, unknown>)[key], 0, ctx)
      totalBytes += bytes
      successfulSlices += 1
      if (ctx.budgetHit) {
        budgetHitSlices += 1
      }
      kb = Math.round(bytes / BYTES_PER_KILOBYTE)
    } catch {
      continue
    }
    if (kb > 0) {
      sizes.push([key, kb])
    }
  }
  const totalKB = Math.round(totalBytes / BYTES_PER_KILOBYTE)
  if (sizes.length === 0) {
    const total: Record<string, number> = {}
    if (successfulSlices > 0) {
      total.__totalKB = totalKB
    }
    if (budgetHitSlices > 0) {
      total.__budgetHitSlices = budgetHitSlices
    }
    return total
  }
  sizes.sort((a, b) => b[1] - a[1])
  const top = Object.fromEntries(sizes.slice(0, limit))
  // Why __totalKB: a small unsaturated total can exonerate the whole state
  // object and redirect investigation without a local repro.
  top.__totalKB = totalKB
  if (budgetHitSlices > 0) {
    top.__budgetHitSlices = budgetHitSlices
  }
  return top
}

function estimateValueBytes(value: unknown, depth: number, ctx: EstimateContext): number {
  if (ctx.nodesLeft <= 0) {
    ctx.budgetHit = true
    return 0
  }
  ctx.nodesLeft -= 1
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
  // Why: cycles and intra-slice shared references count once — retained-size
  // semantics are out of scope for a breadcrumb heuristic.
  if (ctx.seen.has(value)) {
    return 0
  }
  ctx.seen.add(value)
  if (depth >= MAX_DEPTH) {
    ctx.budgetHit = true
    return BYTES_OBJECT_BASE
  }
  if (Array.isArray(value)) {
    return (
      BYTES_OBJECT_BASE + value.length * BYTES_ARRAY_SLOT + estimateArrayElements(value, depth, ctx)
    )
  }
  if (value instanceof Map) {
    return (
      BYTES_OBJECT_BASE + estimateIterableEntries(value.size, value.entries(), depth, ctx, true)
    )
  }
  if (value instanceof Set) {
    return (
      BYTES_OBJECT_BASE + estimateIterableEntries(value.size, value.values(), depth, ctx, false)
    )
  }
  if (ArrayBuffer.isView(value)) {
    return BYTES_OBJECT_BASE + value.byteLength
  }
  return BYTES_OBJECT_BASE + estimatePlainObjectEntries(value, depth, ctx)
}

function estimateArrayElements(value: unknown[], depth: number, ctx: EstimateContext): number {
  const windowLength = Math.min(value.length, SAMPLE_WINDOW)
  if (windowLength === 0) {
    return 0
  }
  const stride = Math.max(1, Math.floor(windowLength / SAMPLE_TARGET))
  let sampledBytes = 0
  let sampledCount = 0
  for (let index = 0; index < windowLength; index += stride) {
    sampledBytes += estimateValueBytes(value[index], depth + 1, ctx)
    sampledCount += 1
  }
  return sampledCount === 0 ? 0 : Math.round((sampledBytes / sampledCount) * value.length)
}

function estimateIterableEntries(
  size: number,
  entries: IterableIterator<unknown>,
  depth: number,
  ctx: EstimateContext,
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
    if (ctx.entriesLeft <= 0) {
      ctx.budgetHit = true
      break
    }
    ctx.entriesLeft -= 1
    if (index % stride === 0) {
      if (isKeyValuePair) {
        const [entryKey, entryValue] = entry as [unknown, unknown]
        sampledBytes += estimateValueBytes(entryKey, depth + 1, ctx)
        sampledBytes += estimateValueBytes(entryValue, depth + 1, ctx)
      } else {
        sampledBytes += estimateValueBytes(entry, depth + 1, ctx)
      }
      sampledCount += 1
    }
    index += 1
  }
  return sampledCount === 0
    ? 0
    : Math.round((sampledBytes / sampledCount + BYTES_ENTRY_OVERHEAD) * size)
}

function estimatePlainObjectEntries(value: object, depth: number, ctx: EstimateContext): number {
  let ownCount = 0
  const sampledKeys: string[] = []
  const entryFloor = depth === 0 ? ENTRY_DESCENT_RESERVE : 0
  // Why: a leaking record must not turn a near-OOM breadcrumb into a full scan.
  for (const key in value) {
    if (ctx.entriesLeft <= entryFloor) {
      ctx.budgetHit = true
      break
    }
    ctx.entriesLeft -= 1
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
    sampledBytes += estimateValueBytes((value as Record<string, unknown>)[key], depth + 1, ctx)
  }
  return sampledKeys.length === 0
    ? 0
    : Math.round((sampledBytes / sampledKeys.length + BYTES_ENTRY_OVERHEAD) * ownCount)
}

/**
 * Bounded subsystem hypotheses for renderer_memory_highwater breadcrumbs.
 * Subsystems push aggregate counts in so crash-diagnostics stays a leaf.
 */

export type RendererMemoryProfileCounts = Record<string, number>

export type RendererMemoryProfileContribution = {
  counts: RendererMemoryProfileCounts
  heuristicOnHeapKB?: number
  heuristicExternalKB?: number
  soundOnHeapBoundKB?: number
}

export type RendererMemoryProfile = {
  counts: RendererMemoryProfileCounts
  onHeapHeuristicByCategoryKB: RendererMemoryProfileCounts
  externalHeuristicByCategoryKB: RendererMemoryProfileCounts
  onHeapHeuristicSumKB: number
  soundOnHeapBoundContributorCount: number
  soundOnHeapBoundSumKB: number
}

type RendererMemoryProfileContributor = () =>
  | RendererMemoryProfileCounts
  | RendererMemoryProfileContribution

type ContributionEntries = {
  name: string
  metadata: [string, number][]
  details: [string, number][]
}

type CollectionScanBudget = { remaining: number; hit: boolean }

const contributors = new Map<string, RendererMemoryProfileContributor>()
let nextContributorStart = 0

const MAX_COUNTS_PER_CONTRIBUTOR = 32
const MAX_PROFILE_COUNTS = 64
const MAX_PROFILE_CONTRIBUTORS = 64
export const MAX_PROFILE_CONTRIBUTOR_INVOCATIONS = 8
const MAX_CONTRIBUTOR_NAME_LENGTH = 64
const MAX_COUNT_KEY_LENGTH = 80
const MAX_STATE_FIELDS_TO_SCAN = 256
const MAX_COLLECTION_KEYS_TO_SCAN = 4096

export function registerRendererMemoryProfileContributor(
  name: string,
  contributor: RendererMemoryProfileContributor
): () => void {
  if (
    name.length === 0 ||
    name.length > MAX_CONTRIBUTOR_NAME_LENGTH ||
    (!contributors.has(name) && contributors.size >= MAX_PROFILE_CONTRIBUTORS)
  ) {
    return () => undefined
  }
  contributors.set(name, contributor)
  return () => {
    if (contributors.get(name) === contributor) {
      contributors.delete(name)
      if (contributors.size === 0) {
        nextContributorStart = 0
      }
    }
  }
}

export function collectRendererMemoryProfile(): RendererMemoryProfile {
  const registered = [...contributors]
  const contributions: ContributionEntries[] = []
  const onHeapHeuristicByCategoryKB: RendererMemoryProfileCounts = {}
  const externalHeuristicByCategoryKB: RendererMemoryProfileCounts = {}
  let onHeapHeuristicSumKB = 0
  let soundOnHeapBoundContributorCount = 0
  let soundOnHeapBoundSumKB = 0
  let availableEntries = 0
  let invoked = 0
  while (
    invoked < registered.length &&
    invoked < MAX_PROFILE_CONTRIBUTOR_INVOCATIONS &&
    availableEntries < MAX_PROFILE_COUNTS
  ) {
    const [name, contributor] = registered[(nextContributorStart + invoked) % registered.length]
    try {
      const contribution = normalizeContribution(contributor())
      const entries = readFiniteEntries(contribution.counts)
      contributions.push({ name, ...entries })
      availableEntries += entries.metadata.length + entries.details.length

      const onHeap = finiteNonnegative(contribution.heuristicOnHeapKB)
      const external = finiteNonnegative(contribution.heuristicExternalKB)
      const soundBound = finiteNonnegative(contribution.soundOnHeapBoundKB)
      if (onHeap !== undefined) {
        onHeapHeuristicByCategoryKB[`${name}.onHeapHeuristicKB`] = Math.round(onHeap)
        onHeapHeuristicSumKB += onHeap
      }
      if (external !== undefined) {
        externalHeuristicByCategoryKB[`${name}.externalHeuristicKB`] = Math.round(external)
      }
      if (soundBound !== undefined) {
        soundOnHeapBoundContributorCount += 1
        soundOnHeapBoundSumKB += soundBound
      }
    } catch {
      contributions.push({ name, metadata: [], details: [['error', 1]] })
      availableEntries += 1
    }
    invoked += 1
  }
  if (registered.length > 0) {
    nextContributorStart = (nextContributorStart + invoked) % registered.length
  }

  const counts: RendererMemoryProfileCounts = {}
  const metadataCount = collectRoundRobin(counts, contributions, 'metadata', MAX_PROFILE_COUNTS)
  collectRoundRobin(counts, contributions, 'details', MAX_PROFILE_COUNTS - metadataCount)
  return {
    counts,
    onHeapHeuristicByCategoryKB,
    externalHeuristicByCategoryKB,
    onHeapHeuristicSumKB: Math.round(onHeapHeuristicSumKB),
    soundOnHeapBoundContributorCount,
    soundOnHeapBoundSumKB: Math.round(soundOnHeapBoundSumKB)
  }
}

export function collectRendererMemoryProfileCounts(): RendererMemoryProfileCounts {
  return collectRendererMemoryProfile().counts
}

function collectRoundRobin(
  output: RendererMemoryProfileCounts,
  contributions: ContributionEntries[],
  kind: 'metadata' | 'details',
  limit: number
): number {
  const positions = contributions.map(() => 0)
  let collected = 0
  let found = true
  while (found && collected < limit) {
    found = false
    for (let index = 0; index < contributions.length && collected < limit; index += 1) {
      const entry = contributions[index][kind][positions[index]]
      if (!entry) {
        continue
      }
      found = true
      positions[index] += 1
      output[`${contributions[index].name}.${entry[0]}`] = entry[1]
      collected += 1
    }
  }
  return collected
}

function normalizeContribution(
  value: RendererMemoryProfileCounts | RendererMemoryProfileContribution
): RendererMemoryProfileContribution {
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, 'counts') &&
    typeof (value as RendererMemoryProfileContribution).counts === 'object'
  ) {
    return value as RendererMemoryProfileContribution
  }
  return { counts: value as RendererMemoryProfileCounts }
}

function readFiniteEntries(counts: RendererMemoryProfileCounts): {
  metadata: [string, number][]
  details: [string, number][]
} {
  const metadata: [string, number][] = []
  const details: [string, number][] = []
  let inspected = 0
  for (const key in counts) {
    if (inspected >= MAX_COUNTS_PER_CONTRIBUTOR) {
      break
    }
    inspected += 1
    if (!Object.hasOwn(counts, key) || key.length === 0 || key.length > MAX_COUNT_KEY_LENGTH) {
      continue
    }
    const value = counts[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      continue
    }
    const destination = key.startsWith('__') ? metadata : details
    destination.push([key, value])
  }
  return { metadata, details }
}

function finiteNonnegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Sizes of the largest top-level collections in a state object. */
export function summarizeStateCollectionSizes(
  state: unknown,
  limit: number
): RendererMemoryProfileCounts {
  if (typeof state !== 'object' || state === null) {
    return {}
  }
  const sizes: [string, number][] = []
  const budget: CollectionScanBudget = { remaining: MAX_COLLECTION_KEYS_TO_SCAN, hit: false }
  let stateFields = 0
  for (const key in state) {
    if (stateFields >= MAX_STATE_FIELDS_TO_SCAN) {
      budget.hit = true
      break
    }
    stateFields += 1
    if (!Object.hasOwn(state, key)) {
      continue
    }
    const size = collectionSize((state as Record<string, unknown>)[key], budget)
    if (size > 0) {
      sizes.push([key, size])
    }
  }
  sizes.sort((left, right) => right[1] - left[1])
  return {
    ...(budget.hit ? { __scanBudgetHit: 1 } : {}),
    ...Object.fromEntries(sizes.slice(0, limit))
  }
}

function collectionSize(value: unknown, budget: CollectionScanBudget): number {
  if (Array.isArray(value)) {
    return value.length
  }
  if (value instanceof Map || value instanceof Set) {
    return value.size
  }
  if (typeof value !== 'object' || value === null) {
    return 0
  }
  let size = 0
  for (const key in value) {
    if (budget.remaining <= 0) {
      budget.hit = true
      break
    }
    budget.remaining -= 1
    if (Object.hasOwn(value, key)) {
      size += 1
    }
  }
  return size
}

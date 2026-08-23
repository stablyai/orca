/**
 * Leak-diagnosis counts for renderer_memory_highwater breadcrumbs.
 *
 * Why a contributor registry: crash-diagnostics must stay a leaf module, so
 * subsystems (store, terminals) push their counters in instead of being
 * imported. Counts only — never raw buffers — per the diagnostics budget.
 */

export type RendererMemoryProfileCounts = Record<string, number>

type RendererMemoryProfileContributor = () => RendererMemoryProfileCounts

type RendererMemoryProfileOptions = {
  /** Heaviest keys to also carry on the routine renderer_memory breadcrumb. */
  trendLimit?: number
}

type RegisteredContributor = {
  collect: RendererMemoryProfileContributor
  trendLimit: number
}

/**
 * Per-sample memo shared by the trend and profile censuses.
 *
 * Why: crossing 90%/95% runs both in one pass, and the storeKB contributor walks
 * every top-level store slice with a transient allocation the size of what it
 * measures — exactly when the heap has no headroom to walk it twice.
 */
export type RendererMemoryCensus = Map<string, RendererMemoryProfileCounts | null>

export function createRendererMemoryCensus(): RendererMemoryCensus {
  return new Map()
}

const contributors = new Map<string, RegisteredContributor>()

// Why: breadcrumbs are retained per session; a misbehaving contributor must not
// bloat every crash report. 32 counts is plenty to name a leaking subsystem.
const MAX_COUNTS_PER_CONTRIBUTOR = 32
// Why: individually bounded contributors can still create unbounded near-OOM work in aggregate.
export const MAX_PROFILE_COUNTS = 64
// Why: empty contributors do not consume the count budget but must not make collection unbounded.
const MAX_PROFILE_CONTRIBUTORS = 64
const MAX_CONTRIBUTOR_NAME_LENGTH = 64
const MAX_COUNT_KEY_LENGTH = 80
// Why far below MAX_PROFILE_COUNTS: this rides every 60s sample, not just the
// near-OOM ones, and every retained breadcrumb pays for it.
export const MAX_TREND_COUNTS = 8

export function registerRendererMemoryProfileContributor(
  name: string,
  contributor: RendererMemoryProfileContributor,
  options?: RendererMemoryProfileOptions
): () => void {
  if (
    name.length === 0 ||
    name.length > MAX_CONTRIBUTOR_NAME_LENGTH ||
    (!contributors.has(name) && contributors.size >= MAX_PROFILE_CONTRIBUTORS)
  ) {
    return () => undefined
  }
  contributors.set(name, { collect: contributor, trendLimit: options?.trendLimit ?? 0 })
  return () => {
    if (contributors.get(name)?.collect === contributor) {
      contributors.delete(name)
    }
  }
}

/**
 * Heaviest keys of trend-tagged contributors, for the routine renderer_memory
 * breadcrumb.
 *
 * Why: highwater profiles are two isolated snapshots. A crash report can only
 * name a retainer if the byte attribution appears as a ramp across the whole
 * session, so a truncated slice of it rides every sample.
 */
export function collectRendererMemoryTrendCounts(
  census?: RendererMemoryCensus
): RendererMemoryProfileCounts {
  const counts: RendererMemoryProfileCounts = {}
  let collected = 0
  for (const [name, entry] of contributors) {
    if (entry.trendLimit <= 0 || collected >= MAX_TREND_COUNTS) {
      continue
    }
    try {
      const ranked = rankContributorCounts(readContribution(name, entry, census))
      const keep = Math.min(entry.trendLimit, MAX_TREND_COUNTS - collected)
      for (const [key, value] of ranked.slice(0, keep)) {
        counts[`${name}.${key}`] = value
        collected += 1
      }
    } catch {
      counts[`${name}.error`] = 1
      collected += 1
    }
  }
  return counts
}

/** Throws on failure so both censuses keep funnelling it into `${name}.error`. */
function readContribution(
  name: string,
  entry: RegisteredContributor,
  census?: RendererMemoryCensus
): RendererMemoryProfileCounts {
  const memoized = census?.get(name)
  if (memoized) {
    return memoized
  }
  if (memoized === null) {
    throw new Error(`renderer memory contributor failed: ${name}`)
  }
  try {
    const contribution = entry.collect()
    census?.set(name, contribution)
    return contribution
  } catch (error) {
    census?.set(name, null)
    throw error
  }
}

function rankContributorCounts(contribution: RendererMemoryProfileCounts): [string, number][] {
  const ranked: [string, number][] = []
  let inspected = 0
  for (const key in contribution) {
    if (inspected >= MAX_COUNTS_PER_CONTRIBUTOR) {
      break
    }
    inspected += 1
    if (
      !Object.hasOwn(contribution, key) ||
      key.length === 0 ||
      key.length > MAX_COUNT_KEY_LENGTH
    ) {
      continue
    }
    const value = contribution[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      ranked.push([key, value])
    }
  }
  return ranked.sort((a, b) => b[1] - a[1])
}

export function collectRendererMemoryProfileCounts(
  census?: RendererMemoryCensus
): RendererMemoryProfileCounts {
  const counts: RendererMemoryProfileCounts = {}
  let collected = 0
  let visited = 0
  for (const [name, entry] of contributors) {
    if (collected >= MAX_PROFILE_COUNTS || visited >= MAX_PROFILE_CONTRIBUTORS) {
      break
    }
    visited += 1
    // Why: a broken contributor must never take down memory reporting itself.
    try {
      const contribution = readContribution(name, entry, census)
      let inspected = 0
      for (const key in contribution) {
        if (inspected >= MAX_COUNTS_PER_CONTRIBUTOR || collected >= MAX_PROFILE_COUNTS) {
          break
        }
        inspected += 1
        if (!Object.hasOwn(contribution, key)) {
          continue
        }
        if (key.length === 0 || key.length > MAX_COUNT_KEY_LENGTH) {
          continue
        }
        const value = contribution[key]
        if (typeof value === 'number' && Number.isFinite(value)) {
          counts[`${name}.${key}`] = value
          collected += 1
        }
      }
    } catch {
      if (collected < MAX_PROFILE_COUNTS) {
        counts[`${name}.error`] = 1
        collected += 1
      }
    }
  }
  return counts
}

/**
 * Sizes of the largest top-level collections in a state object, for spotting
 * which slice grew when the heap high-water mark trips.
 */
export function summarizeStateCollectionSizes(
  state: unknown,
  limit: number
): RendererMemoryProfileCounts {
  if (typeof state !== 'object' || state === null) {
    return {}
  }
  const sizes: [string, number][] = []
  for (const [key, value] of Object.entries(state)) {
    const size = collectionSize(value)
    if (size !== null && size > 0) {
      sizes.push([key, size])
    }
  }
  sizes.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(sizes.slice(0, limit))
}

function collectionSize(value: unknown): number | null {
  if (Array.isArray(value)) {
    return value.length
  }
  if (value instanceof Map || value instanceof Set) {
    return value.size
  }
  if (typeof value === 'object' && value !== null) {
    let size = 0
    // Why: Object.keys allocates an array proportional to the leaking collection.
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        size += 1
      }
    }
    return size
  }
  return null
}

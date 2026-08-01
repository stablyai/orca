/**
 * Leak-diagnosis counts for renderer_memory_highwater breadcrumbs.
 *
 * Why a contributor registry: crash-diagnostics must stay a leaf module, so
 * subsystems (store, terminals) push their counters in instead of being
 * imported. Counts only — never raw buffers — per the diagnostics budget.
 */

export type RendererMemoryProfileCounts = Record<string, number>

type RendererMemoryProfileContributor = () => RendererMemoryProfileCounts

const contributors = new Map<string, RendererMemoryProfileContributor>()

// Why: breadcrumbs are retained per session; a misbehaving contributor must not
// bloat every crash report. 32 counts is plenty to name a leaking subsystem.
const MAX_COUNTS_PER_CONTRIBUTOR = 32
// Why: individually bounded contributors can still create unbounded near-OOM work in aggregate.
const MAX_PROFILE_COUNTS = 64
// Why enforced at registration and not at collection: empty contributors consume no
// count budget, so registration is the only place the walk can be bounded.
const MAX_PROFILE_CONTRIBUTORS = 64
const MAX_CONTRIBUTOR_NAME_LENGTH = 64
const MAX_COUNT_KEY_LENGTH = 80

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
    }
  }
}

export function collectRendererMemoryProfileCounts(): RendererMemoryProfileCounts {
  const counts: RendererMemoryProfileCounts = {}
  let collected = 0
  let truncated = false
  for (const [name, contributor] of contributors) {
    if (collected >= MAX_PROFILE_COUNTS) {
      truncated = true
      break
    }
    // Why: a broken contributor must never take down memory reporting itself.
    try {
      const contribution = contributor()
      let inspected = 0
      for (const key in contribution) {
        if (inspected >= MAX_COUNTS_PER_CONTRIBUTOR || collected >= MAX_PROFILE_COUNTS) {
          truncated = true
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
      } else {
        truncated = true
      }
    }
  }
  // Why one key over budget rather than dropping it: contributors are visited in
  // registration order, which is module-import order, so a budget overrun silently
  // omits whichever subsystem happens to load last. Without this marker a reader
  // scanning an OOM report for monacoModels.* and finding nothing concludes "measured,
  // not leaking" — the exact opposite of the truth — and rules out the real culprit.
  if (truncated) {
    counts['profile.truncated'] = 1
  }
  return counts
}

/**
 * Sizes of the largest top-level collections in a state object, for spotting
 * which slice grew when the heap high-water mark trips.
 *
 * Reports `unreportedCollections` when the limit hides some: without it the OOM
 * report shows 20 slices and no sign that a 21st exists, which reads as "those are
 * all of them". Deliberately does not set `profile.truncated` — a real session sits
 * on this limit routinely, and a flag that is always 1 cannot still mean "a whole
 * contributor is missing".
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
  const reported = Object.fromEntries(sizes.slice(0, limit))
  const unreportedCollections = Math.max(sizes.length - limit, 0)
  return unreportedCollections === 0 ? reported : { ...reported, unreportedCollections }
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
    // This is not cheaper than Object.keys: V8 materializes a key array for for...in
    // too, and measured slower on a 1M-entry Record (139ms vs 104ms). What makes it
    // survivable on the OOM path is frequency — collection runs at most twice per
    // renderer session, on the 0.6 and 0.8 highwater thresholds. Not per interaction.
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        size += 1
      }
    }
    return size
  }
  return null
}

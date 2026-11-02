/** Subsystems push count-only memory census into a registry so crash-diagnostics remains a leaf; never include raw buffers. */

export type RendererMemoryProfileCounts = Record<string, number>

type RendererMemoryProfileContributor = () => RendererMemoryProfileCounts

const contributors = new Map<string, RendererMemoryProfileContributor>()

// Cap retained breadcrumb counts at 32 so a faulty contributor cannot bloat every crash report.
const MAX_COUNTS_PER_CONTRIBUTOR = 32
// Why: individually bounded contributors can still create unbounded near-OOM work in aggregate.
const MAX_PROFILE_COUNTS = 64
// Why: empty contributors do not consume the count budget but must not make collection unbounded.
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
  let visited = 0
  for (const [name, contributor] of contributors) {
    if (collected >= MAX_PROFILE_COUNTS || visited >= MAX_PROFILE_CONTRIBUTORS) {
      break
    }
    visited += 1
    // A broken contributor must not disable memory reporting.
    try {
      const contribution = contributor()
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

/** Report largest top-level state collections to locate slice growth at heap high-water marks. */
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

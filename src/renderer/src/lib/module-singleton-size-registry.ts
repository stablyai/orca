/**
 * Self-reported sizes for long-lived module-level containers.
 *
 * Why: the Zustand store is only part of the renderer's retained graph. Module
 * scope holds Maps/Sets that live for the whole session and are invisible to any
 * store walk, so a leak there names nothing in a crash report. Registering one
 * is a single call next to the declaration and costs a `.size` read per memory
 * breadcrumb — no timer, no subscription, no retention of the values.
 *
 * Opt-in on purpose: only containers whose growth would be a real leak signal
 * belong here. Diagnostics-only; nothing reads these counts to make decisions.
 */

type SizedContainer = { readonly size: number }

type SingletonSizeSource = SizedContainer | (() => number)

const sources = new Map<string, SingletonSizeSource>()

// Why: these bound the breadcrumb, not the renderer — one misfiled registration
// must not crowd out the store counts that share the profile budget.
const MAX_SINGLETONS = 32
const MAX_NAME_LENGTH = 48

/**
 * Registers a module-level container to report its entry count in memory
 * breadcrumbs. Call once at module scope; `name` becomes the breadcrumb key.
 * The returned disposer exists for tests and HMR.
 */
export function registerModuleSingletonSize(name: string, source: SingletonSizeSource): () => void {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return () => undefined
  }
  if (!sources.has(name) && sources.size >= MAX_SINGLETONS) {
    return () => undefined
  }
  sources.set(name, source)
  return () => {
    if (sources.get(name) === source) {
      sources.delete(name)
    }
  }
}

/** Current entry count of every registered singleton; skips empty and broken ones. */
export function collectModuleSingletonSizes(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [name, source] of sources) {
    // Why: a container with a throwing accessor must not lose the other counts.
    try {
      const size = typeof source === 'function' ? source() : source.size
      // Why skip zero: an idle registration should not spend a breadcrumb slot.
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
        counts[name] = Math.round(size)
      }
    } catch {
      counts[`${name}.error`] = 1
    }
  }
  return counts
}

export function _resetModuleSingletonSizesForTests(): void {
  sources.clear()
}

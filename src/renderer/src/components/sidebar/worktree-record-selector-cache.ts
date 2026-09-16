import { shallow } from 'zustand/shallow'

type WorktreeRecordGeneration<TValue> = {
  sources: readonly unknown[]
  carried: ReadonlyMap<string, TValue> | null
  byWorktreeId: Map<string, TValue>
}

function sameSources(previous: readonly unknown[], next: readonly unknown[]): boolean {
  if (previous.length !== next.length) {
    return false
  }
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false
    }
  }
  return true
}

/**
 * Wraps a per-worktree record selector in a store-identity-keyed cache.
 *
 * Zustand re-runs every mounted subscriber's selector on every store write, so
 * an unmemoized build allocates one record per visible card per write even when
 * nothing it reads changed. Gating on the source slice identities collapses that
 * to one build per worktree per generation; carrying the previous generation
 * forward keeps the reference stable when a rebuild produces equal contents, so
 * downstream `useShallow`/`useMemo` gates short-circuit on identity.
 *
 * The returned records are shared by every caller and must never be mutated.
 */
export function createWorktreeRecordSelector<TState, TValue extends object>(options: {
  readSources: (state: TState) => readonly unknown[]
  build: (state: TState, worktreeId: string) => TValue
  empty: TValue
}): (state: TState, worktreeId: string) => TValue {
  let generation: WorktreeRecordGeneration<TValue> | null = null
  return (state, worktreeId) => {
    const sources = options.readSources(state)
    if (!generation || !sameSources(generation.sources, sources)) {
      generation = {
        sources,
        carried: generation?.byWorktreeId ?? null,
        byWorktreeId: new Map()
      }
    }
    const cached = generation.byWorktreeId.get(worktreeId)
    if (cached !== undefined) {
      return cached
    }
    const built = options.build(state, worktreeId)
    const carried = generation.carried?.get(worktreeId)
    let value = built
    if (Object.keys(built).length === 0) {
      value = options.empty
    } else if (carried && shallow(carried, built)) {
      value = carried
    }
    generation.byWorktreeId.set(worktreeId, value)
    return value
  }
}

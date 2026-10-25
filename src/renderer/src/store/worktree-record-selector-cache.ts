import { shallow } from 'zustand/shallow'

type WorktreeRecordGeneration<TValue> = {
  sources: readonly unknown[]
  carried: ReadonlyMap<string, TValue> | null
  byWorktreeId: Map<string, TValue>
}

/** Why not `Object.keys`: a `Set`/`Map` value has none, so the default check
 *  would collapse every non-empty one onto the shared empty identity. */
function isEmptyValue<TValue extends object>(value: TValue): boolean {
  return value instanceof Set || value instanceof Map
    ? value.size === 0
    : Object.keys(value).length === 0
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

/** Cache by source identity: Zustand runs each mounted selector on every write. Reuse equal records across generations so downstream memo gates hold. Returned records are shared; never mutate them. */
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
    if (isEmptyValue(built)) {
      value = options.empty
    } else if (carried && shallow(carried, built)) {
      value = carried
    }
    generation.byWorktreeId.set(worktreeId, value)
    return value
  }
}

import { useAppStore } from '@/store/index'

/** Per-tab-group state that outlives a mounted view and is disposed when its group or workspace is removed. */
export type TabGroupScopedState<T> = {
  get(worktreeId: string, groupId: string): T | undefined
  /** Ignored for a group that is already gone, so nothing outlives its owner. */
  set(worktreeId: string, groupId: string, value: T): void
  take(worktreeId: string, groupId: string): T | undefined
}

type Registry = {
  worktreeIds(): string[]
  retire(worktreeId: string, openGroupIds: ReadonlySet<string> | null): void
}

const registries = new Set<Registry>()
let subscribed = false

function isGroupOpen(worktreeId: string, groupId: string): boolean {
  return useAppStore.getState().groupsByWorktree[worktreeId]?.some((g) => g.id === groupId) ?? false
}

// One subscription for every registry; a write that leaves groupsByWorktree unchanged costs one reference compare.
function ensureRemovalSubscription(): void {
  if (subscribed) {
    return
  }
  subscribed = true
  useAppStore.subscribe((state, previous) => {
    const next = state.groupsByWorktree
    const before = previous.groupsByWorktree
    if (next === before) {
      return
    }
    for (const registry of registries) {
      for (const worktreeId of registry.worktreeIds()) {
        const groups = next[worktreeId]
        if (groups === before[worktreeId]) {
          continue
        }
        registry.retire(worktreeId, groups ? new Set(groups.map((g) => g.id)) : null)
      }
    }
  })
}

export function createTabGroupScopedState<T>(
  onDispose?: (value: T) => void
): TabGroupScopedState<T> {
  const valuesByWorktree = new Map<string, Map<string, T>>()
  const take = (worktreeId: string, groupId: string): T | undefined => {
    const values = valuesByWorktree.get(worktreeId)
    const value = values?.get(groupId)
    if (values && value !== undefined) {
      values.delete(groupId)
      if (values.size === 0) {
        valuesByWorktree.delete(worktreeId)
      }
    }
    return value
  }
  registries.add({
    worktreeIds: () => [...valuesByWorktree.keys()],
    retire: (worktreeId, openGroupIds) => {
      const values = valuesByWorktree.get(worktreeId)
      if (!values) {
        return
      }
      for (const groupId of values.keys()) {
        if (!openGroupIds?.has(groupId)) {
          const value = take(worktreeId, groupId)
          if (value !== undefined) {
            onDispose?.(value)
          }
        }
      }
    }
  })
  return {
    get: (worktreeId, groupId) => valuesByWorktree.get(worktreeId)?.get(groupId),
    set: (worktreeId, groupId, value) => {
      if (!isGroupOpen(worktreeId, groupId)) {
        return
      }
      ensureRemovalSubscription()
      const previous = take(worktreeId, groupId)
      if (previous !== undefined && previous !== value) {
        onDispose?.(previous)
      }
      const values = valuesByWorktree.get(worktreeId) ?? new Map<string, T>()
      values.set(groupId, value)
      valuesByWorktree.set(worktreeId, values)
    },
    take
  }
}

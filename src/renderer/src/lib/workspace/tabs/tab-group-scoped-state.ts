import type { AppState } from '@/store/types'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'

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

type GroupsStore = {
  getState: () => Pick<AppState, 'groupsByWorktree'>
  subscribe: (
    listener: (
      state: Pick<AppState, 'groupsByWorktree'>,
      previous: Pick<AppState, 'groupsByWorktree'>
    ) => void
  ) => () => void
}

const registries = new Set<Registry>()
// Installed by the store at creation (store-observer-installers.ts); importing the store here would be a cycle.
let groupsStore: GroupsStore | null = null

function isGroupOpen(worktreeId: string, groupId: string): boolean {
  return (
    groupsStore?.getState().groupsByWorktree[worktreeId]?.some((g) => g.id === groupId) ?? false
  )
}

/** One subscription for every registry; a write that leaves groupsByWorktree unchanged costs one reference compare. */
export function installTabGroupScopedStateRetirement(store: GroupsStore): void {
  groupsStore = store
  store.subscribe((state, previous) => {
    const next = state.groupsByWorktree
    const before = previous.groupsByWorktree
    if (next === before || registries.size === 0) {
      return
    }
    const changes = readRecordChanges(next, before)
    // Addressed writes (every tab activation) name their workspaces; only a resync visits every remembered one.
    const changed =
      changes?.kind === 'addressed'
        ? changes.keys
        : new Set([...registries].flatMap((registry) => registry.worktreeIds()))
    for (const worktreeId of changed) {
      const groups = next[worktreeId]
      if (groups === before[worktreeId]) {
        continue
      }
      const openGroupIds = groups ? new Set(groups.map((g) => g.id)) : null
      for (const registry of registries) {
        registry.retire(worktreeId, openGroupIds)
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

import { useCallback, useSyncExternalStore } from 'react'
import type { TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { useAppStore } from '../../../store/index'
import type { AppState } from '../../../store/types'
import { readRecordChanges } from '../../../store/record-transitions/keyed-record-change-reads'

type Inputs = Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>

const listenersByWorktree = new Map<string, Set<() => void>>()
let unsubscribeStore: (() => void) | null = null

function changedWorktreeIds(
  next: Inputs[keyof Inputs],
  previous: Inputs[keyof Inputs]
): Iterable<string> {
  if (next === previous) {
    return []
  }
  const changes = readRecordChanges(next, previous)
  return changes?.kind === 'addressed' ? changes.keys : listenersByWorktree.keys()
}

function onStoreChange(state: Inputs, previous: Inputs): void {
  // Writes that leave both records alone (editor input, terminal output) stop at two compares.
  if (
    state.groupsByWorktree === previous.groupsByWorktree &&
    state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree
  ) {
    return
  }
  const notified = new Set<() => void>()
  const visit = (ids: Iterable<string>, key: keyof Inputs): void => {
    for (const id of ids) {
      if (state[key][id] === previous[key][id]) {
        continue
      }
      listenersByWorktree.get(id)?.forEach((listener) => notified.add(listener))
    }
  }
  visit(changedWorktreeIds(state.groupsByWorktree, previous.groupsByWorktree), 'groupsByWorktree')
  visit(
    changedWorktreeIds(state.unifiedTabsByWorktree, previous.unifiedTabsByWorktree),
    'unifiedTabsByWorktree'
  )
  notified.forEach((listener) => listener())
}

/** One store subscription for every parked surface, so a write costs O(changed workspaces), not O(retained layouts). */
export function subscribeReleasedLayoutInputs(
  worktreeId: string,
  listener: () => void
): () => void {
  const listeners = listenersByWorktree.get(worktreeId) ?? new Set()
  listeners.add(listener)
  listenersByWorktree.set(worktreeId, listeners)
  unsubscribeStore ??= useAppStore.subscribe(onStoreChange)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByWorktree.delete(worktreeId)
    }
    if (listenersByWorktree.size === 0) {
      unsubscribeStore?.()
      unsubscribeStore = null
    }
  }
}

/** Subscribes only while release is possible; a closed gate's surface never watches the store. */
export function useReleasedLayoutInputs(
  worktreeId: string,
  enabled: boolean
): { tabCount: number; groups: TabGroup[] | undefined } {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeReleasedLayoutInputs(worktreeId, listener) : () => {},
    [enabled, worktreeId]
  )
  const tabCount = useSyncExternalStore(
    subscribe,
    () => useAppStore.getState().unifiedTabsByWorktree[worktreeId]?.length ?? 0
  )
  const groups = useSyncExternalStore(
    subscribe,
    () => useAppStore.getState().groupsByWorktree[worktreeId]
  )
  return { tabCount, groups }
}

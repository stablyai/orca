import { useCallback, useSyncExternalStore } from 'react'
import type { TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { useAppStore } from '../../../store/index'
import type { AppState } from '../../../store/types'
import { readRecordChanges } from '../../../store/record-transitions/keyed-record-change-reads'

type Inputs = Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>

const listenersByWorktree = new Map<string, Set<() => void>>()
let unsubscribeStore: (() => void) | null = null

type WorktreeRecord = Readonly<Record<string, unknown>>

function changedWorktreeIds(next: WorktreeRecord, previous: WorktreeRecord): Iterable<string> {
  if (next === previous) {
    return []
  }
  const changes = readRecordChanges(next, previous)
  return changes?.kind === 'addressed' ? changes.keys : listenersByWorktree.keys()
}

function collectListeners(
  next: WorktreeRecord,
  previous: WorktreeRecord,
  notified: Set<() => void>
): void {
  for (const id of changedWorktreeIds(next, previous)) {
    if (next[id] !== previous[id]) {
      listenersByWorktree.get(id)?.forEach((listener) => notified.add(listener))
    }
  }
}

function onStoreChange(state: Inputs, previous: Inputs): void {
  const groups = state.groupsByWorktree
  const tabs = state.unifiedTabsByWorktree
  // Writes that leave both records alone (editor input, terminal output) stop at two compares.
  if (groups === previous.groupsByWorktree && tabs === previous.unifiedTabsByWorktree) {
    return
  }
  const notified = new Set<() => void>()
  collectListeners(groups, previous.groupsByWorktree, notified)
  collectListeners(tabs, previous.unifiedTabsByWorktree, notified)
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
  // A closed gate reads constants: nothing notifies React, so a live read could tear.
  const tabCount = useSyncExternalStore(subscribe, () =>
    enabled ? (useAppStore.getState().unifiedTabsByWorktree[worktreeId]?.length ?? 0) : 0
  )
  const groups = useSyncExternalStore(subscribe, () =>
    enabled ? useAppStore.getState().groupsByWorktree[worktreeId] : undefined
  )
  return { tabCount, groups }
}

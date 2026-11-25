import { useCallback, useEffect, useSyncExternalStore } from 'react'

// The add/edit dialog keeps its unsaved text in component state, so its workspace keeps the layout mounted.
const openEditorCountByWorktree = new Map<string, number>()
const listenersByWorktree = new Map<string, Set<() => void>>()

function notify(worktreeId: string): void {
  listenersByWorktree.get(worktreeId)?.forEach((listener) => listener())
}

function subscribe(worktreeId: string, listener: () => void): () => void {
  const listeners = listenersByWorktree.get(worktreeId) ?? new Set()
  listeners.add(listener)
  listenersByWorktree.set(worktreeId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByWorktree.delete(worktreeId)
    }
  }
}

export function isQuickCommandEditorOpen(worktreeId: string): boolean {
  return openEditorCountByWorktree.has(worktreeId)
}

/** Returns the matching close; counts per workspace so split groups' dialogs don't clear each other. */
export function markQuickCommandEditorOpen(worktreeId: string): () => void {
  const opened = !openEditorCountByWorktree.has(worktreeId)
  openEditorCountByWorktree.set(worktreeId, (openEditorCountByWorktree.get(worktreeId) ?? 0) + 1)
  if (opened) {
    notify(worktreeId)
  }
  let closed = false
  return () => {
    if (closed) {
      return
    }
    closed = true
    const count = (openEditorCountByWorktree.get(worktreeId) ?? 1) - 1
    if (count > 0) {
      openEditorCountByWorktree.set(worktreeId, count)
    } else {
      openEditorCountByWorktree.delete(worktreeId)
      notify(worktreeId)
    }
  }
}

/** Re-renders only when this workspace's first dialog opens or its last one closes. */
export function useIsQuickCommandEditorOpen(worktreeId: string): boolean {
  const subscribeWorktree = useCallback(
    (listener: () => void) => subscribe(worktreeId, listener),
    [worktreeId]
  )
  return useSyncExternalStore(subscribeWorktree, () => isQuickCommandEditorOpen(worktreeId))
}

export function useQuickCommandEditorPresence(worktreeId: string, open: boolean): void {
  useEffect(() => (open ? markQuickCommandEditorOpen(worktreeId) : undefined), [worktreeId, open])
}

import { useEffect } from 'react'

// The add/edit dialog keeps its unsaved text in component state, so its workspace keeps the layout mounted.
const openEditorCountByWorktree = new Map<string, number>()

export function isQuickCommandEditorOpen(worktreeId: string): boolean {
  return openEditorCountByWorktree.has(worktreeId)
}

/** Returns the matching close; counts per workspace so split groups' dialogs don't clear each other. */
export function markQuickCommandEditorOpen(worktreeId: string): () => void {
  openEditorCountByWorktree.set(worktreeId, (openEditorCountByWorktree.get(worktreeId) ?? 0) + 1)
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
    }
  }
}

export function useQuickCommandEditorPresence(worktreeId: string, open: boolean): void {
  useEffect(() => (open ? markQuickCommandEditorOpen(worktreeId) : undefined), [worktreeId, open])
}

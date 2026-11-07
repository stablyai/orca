import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

const STORAGE_KEY = 'orca.sourceControl.linkedWorktrees.v1'
const EMPTY: readonly string[] = []

/** Linked worktree ids, linked by hand with +, keyed by the workspace they show in. */
type LinkedWorktreesState = { byWorktreeId: Record<string, readonly string[]> }

function readPersisted(): LinkedWorktreesState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const byWorktreeId: Record<string, readonly string[]> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) {
          byWorktreeId[key] = value.filter((id): id is string => typeof id === 'string')
        }
      }
      return { byWorktreeId }
    }
  } catch {
    // Storage can be blocked or corrupt; links are a convenience, so start empty.
  }
  return { byWorktreeId: {} }
}

const linkedWorktreesStore = createStore<LinkedWorktreesState>(() =>
  typeof window === 'undefined' ? { byWorktreeId: {} } : readPersisted()
)

linkedWorktreesStore.subscribe((state) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.byWorktreeId))
  } catch {
    // Best effort only.
  }
})

function update(worktreeId: string, next: (ids: readonly string[]) => readonly string[]): void {
  const { byWorktreeId } = linkedWorktreesStore.getState()
  const current = byWorktreeId[worktreeId] ?? EMPTY
  const updated = next(current)
  if (updated === current) {
    return
  }
  const copy = { ...byWorktreeId }
  if (updated.length === 0) {
    delete copy[worktreeId]
  } else {
    copy[worktreeId] = updated
  }
  linkedWorktreesStore.setState({ byWorktreeId: copy })
}

export function linkWorktree(worktreeId: string, linkedWorktreeId: string): void {
  if (worktreeId === linkedWorktreeId) {
    return
  }
  update(worktreeId, (ids) => (ids.includes(linkedWorktreeId) ? ids : [...ids, linkedWorktreeId]))
}

export function unlinkWorktree(worktreeId: string, linkedWorktreeId: string): void {
  update(worktreeId, (ids) =>
    ids.includes(linkedWorktreeId) ? ids.filter((id) => id !== linkedWorktreeId) : ids
  )
}

export function useLinkedWorktreeIds(worktreeId: string | null): readonly string[] {
  return useStore(linkedWorktreesStore, (state) =>
    worktreeId ? (state.byWorktreeId[worktreeId] ?? EMPTY) : EMPTY
  )
}

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { findWorktreeById } from './worktree-helpers'

// Why: cap the per-session history so a long-lived workspace with many
// worktree jumps cannot grow the array unbounded. 50 is generous enough
// that the cap is never visible in normal use but small enough that the
// linear skip-deleted scan in goBack/goForward stays trivially cheap.
const MAX_HISTORY = 50

export type WorktreeNavHistorySlice = {
  // Linear history, oldest -> newest.
  worktreeNavHistory: string[]
  // Index into worktreeNavHistory; points at the currently-active entry.
  // -1 means empty (no worktree ever activated this session).
  worktreeNavHistoryIndex: number
  // Why: set while goBack/goForward are calling activateAndRevealWorktree so
  // the activation path's recordWorktreeVisit step can skip re-recording a
  // history-driven navigation. Kept in-store (rather than as a module-level
  // mutable) so tests can drive the slice in isolation.
  isNavigatingHistory: boolean

  recordWorktreeVisit: (worktreeId: string) => void
  goBackWorktree: () => void
  goForwardWorktree: () => void
}

type ActivateFn = (worktreeId: string) => unknown

// Why: the slice must call activateAndRevealWorktree from goBack/goForward, but
// importing it directly would create a cycle (activation imports the store).
// Install the reference at module init via setWorktreeNavActivator and keep
// the slice itself unaware of the activation module.
let activator: ActivateFn | null = null

export function setWorktreeNavActivator(fn: ActivateFn | null): void {
  activator = fn
}

export function findPrevLiveWorktreeHistoryIndex(state: AppState): number | null {
  for (let i = state.worktreeNavHistoryIndex - 1; i >= 0; i--) {
    const id = state.worktreeNavHistory[i]
    if (findWorktreeById(state.worktreesByRepo, id)) {
      return i
    }
  }
  return null
}

export function findNextLiveWorktreeHistoryIndex(state: AppState): number | null {
  for (let i = state.worktreeNavHistoryIndex + 1; i < state.worktreeNavHistory.length; i++) {
    const id = state.worktreeNavHistory[i]
    if (findWorktreeById(state.worktreesByRepo, id)) {
      return i
    }
  }
  return null
}

export function canGoBackWorktreeHistory(state: AppState): boolean {
  return findPrevLiveWorktreeHistoryIndex(state) !== null
}

export function canGoForwardWorktreeHistory(state: AppState): boolean {
  return findNextLiveWorktreeHistoryIndex(state) !== null
}

export const createWorktreeNavHistorySlice: StateCreator<
  AppState,
  [],
  [],
  WorktreeNavHistorySlice
> = (set, get) => ({
  worktreeNavHistory: [],
  worktreeNavHistoryIndex: -1,
  isNavigatingHistory: false,

  recordWorktreeVisit: (worktreeId) => {
    set((s) => {
      // Why: re-activating the same worktree must not pollute history. The
      // de-dup applies only to the current entry so that A -> B -> A remains
      // a valid stack (user left B, returned to A via the sidebar).
      if (s.worktreeNavHistory[s.worktreeNavHistoryIndex] === worktreeId) {
        return s
      }

      // Truncate any forward entries, then append and advance the index.
      const truncated = s.worktreeNavHistory.slice(0, s.worktreeNavHistoryIndex + 1)
      truncated.push(worktreeId)
      let nextIndex = s.worktreeNavHistoryIndex + 1

      // Why: cap eviction drops the oldest entries. The index must shift left
      // by the same count so it still points at the just-appended current entry.
      if (truncated.length > MAX_HISTORY) {
        const evict = truncated.length - MAX_HISTORY
        truncated.splice(0, evict)
        nextIndex = Math.max(0, nextIndex - evict)
      }

      return {
        worktreeNavHistory: truncated,
        worktreeNavHistoryIndex: nextIndex
      }
    })
  },

  goBackWorktree: () => {
    const state = get()
    if (state.worktreeNavHistoryIndex <= 0) {
      return
    }
    const targetIndex = findPrevLiveWorktreeHistoryIndex(state)
    if (targetIndex === null) {
      return
    }
    if (!activator) {
      // Why: a silent no-op here would mean the back/forward chord simply
      // does nothing with no diagnostic. The activator is registered at
      // module init by worktree-activation.ts, so a missing activator means
      // either test setup forgot to install one or the production import
      // graph regressed.
      console.warn('goBackWorktree called before worktree activator was registered')
      return
    }
    const targetId = state.worktreeNavHistory[targetIndex]
    // Why: capture-and-restore (not force false) so re-entrant navigation
    // (e.g. a store subscriber synchronously triggers another goBack) does
    // not race on the boolean — the outer call's `finally` restores its own
    // prior value rather than clobbering state set by an inner call.
    const prevNavigating = get().isNavigatingHistory
    set({ isNavigatingHistory: true })
    try {
      // Why: activateAndRevealWorktree returns `ActivateAndRevealResult | false`;
      // `false` is the only observable failure signal. Advance the index only on
      // success so the slice stays consistent with what the user actually sees.
      const result = activator(targetId)
      if (result !== false) {
        set({ worktreeNavHistoryIndex: targetIndex })
      }
    } finally {
      set({ isNavigatingHistory: prevNavigating })
    }
  },

  goForwardWorktree: () => {
    const state = get()
    if (state.worktreeNavHistoryIndex >= state.worktreeNavHistory.length - 1) {
      return
    }
    const targetIndex = findNextLiveWorktreeHistoryIndex(state)
    if (targetIndex === null) {
      return
    }
    if (!activator) {
      console.warn('goForwardWorktree called before worktree activator was registered')
      return
    }
    const targetId = state.worktreeNavHistory[targetIndex]
    const prevNavigating = get().isNavigatingHistory
    set({ isNavigatingHistory: true })
    try {
      const result = activator(targetId)
      if (result !== false) {
        set({ worktreeNavHistoryIndex: targetIndex })
      }
    } finally {
      set({ isNavigatingHistory: prevNavigating })
    }
  }
})

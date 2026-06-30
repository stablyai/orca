import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

// Why: a single multiplex runtime can flap the WS many times in seconds. The
// 30s window collapses repeats into one row with a rising count, and the 5-row
// cap is what a user can actually scan in a banner.
export const ERROR_DEDUP_WINDOW_MS = 30_000
export const ERROR_TABLE_MAX_ENTRIES = 5

export type TerminalErrorEntry = {
  message: string
  count: number
  lastSeenAt: number
}

export type TerminalErrorsSlice = {
  terminalErrorsByWorktreeId: Record<string, TerminalErrorEntry[]>
  pushTerminalError: (worktreeId: string, message: string, now?: number) => void
  clearTerminalErrors: (worktreeId: string) => void
}

export const createTerminalErrorsSlice: StateCreator<AppState, [], [], TerminalErrorsSlice> = (
  set
) => ({
  terminalErrorsByWorktreeId: {},
  pushTerminalError: (worktreeId, message, now) => {
    set((state) => {
      const ts = now ?? Date.now()
      const prev = state.terminalErrorsByWorktreeId[worktreeId] ?? []
      const kept = prev.filter((entry) => ts - entry.lastSeenAt < ERROR_DEDUP_WINDOW_MS)
      const existing = kept.find((entry) => entry.message === message)
      const next = existing
        ? kept.map((entry) =>
            entry === existing ? { ...entry, count: entry.count + 1, lastSeenAt: ts } : entry
          )
        : [...kept, { message, count: 1, lastSeenAt: ts }].slice(-ERROR_TABLE_MAX_ENTRIES)
      return {
        terminalErrorsByWorktreeId: {
          ...state.terminalErrorsByWorktreeId,
          [worktreeId]: next
        }
      }
    })
  },
  clearTerminalErrors: (worktreeId) => {
    set((state) => ({
      terminalErrorsByWorktreeId: {
        ...state.terminalErrorsByWorktreeId,
        [worktreeId]: []
      }
    }))
  }
})

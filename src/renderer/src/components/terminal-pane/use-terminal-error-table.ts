import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { TerminalErrorEntry } from '@/store/slices/terminal-errors'

export type { TerminalErrorEntry }

const EMPTY: TerminalErrorEntry[] = []

export type TerminalErrorTable = {
  errors: TerminalErrorEntry[]
  push: (message: string) => void
  clear: () => void
}

// Why: per-worktree keyed reads so split panes sharing the same multiplex
// runtime coalesce to one banner instead of fanning out redundant toasts.
// The store-backed push/clear actions are stable references, so callers can
// pass them through refs without useLayoutEffect bookkeeping.
export function useTerminalErrorTable(
  worktreeId: string,
  options: { now?: () => number } = {}
): TerminalErrorTable {
  const now = options.now
  const errors = useAppStore((s) => s.terminalErrorsByWorktreeId[worktreeId] ?? EMPTY)
  const push = useCallback(
    (message: string) => {
      useAppStore.getState().pushTerminalError(worktreeId, message, now?.())
    },
    [worktreeId, now]
  )
  const clear = useCallback(() => {
    useAppStore.getState().clearTerminalErrors(worktreeId)
  }, [worktreeId])
  return { errors, push, clear }
}

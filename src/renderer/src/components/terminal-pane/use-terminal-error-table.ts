import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { TerminalErrorEntry } from '@/store/slices/terminal-errors'

export type { TerminalErrorEntry }

const EMPTY: TerminalErrorEntry[] = []

export type TerminalErrorActions = {
  push: (message: string) => void
  clear: () => void
}

/**
 * Why: TerminalPane consumes push/clear for dispatch handlers but does not
 * render the banner. Subscribing to terminalErrorsByWorktreeId here would
 * force every pane in the worktree to re-render on each push, even though
 * only the workspace-level overlay reads the entries. Use this hook when
 * you only need to write to the slice.
 */
export function useTerminalErrorActions(
  worktreeId: string,
  options: { now?: () => number } = {}
): TerminalErrorActions {
  const now = options.now
  const push = useCallback(
    (message: string) => {
      useAppStore.getState().pushTerminalError(worktreeId, message, now?.())
    },
    [worktreeId, now]
  )
  const clear = useCallback(() => {
    useAppStore.getState().clearTerminalErrors(worktreeId)
  }, [worktreeId])
  return { push, clear }
}

/**
 * Why: TerminalErrorBannerOverlayLayer reads the slice and re-renders only
 * when this worktree's entries change. The selector is intentionally
 * shallow — referential equality of the array reference is what makes
 * React.memo on TerminalErrorBanner short-circuit on every push that
 * doesn't touch this worktree.
 */
export function useTerminalErrorTable(worktreeId: string): TerminalErrorEntry[] {
  return useAppStore((s) => s.terminalErrorsByWorktreeId[worktreeId] ?? EMPTY)
}

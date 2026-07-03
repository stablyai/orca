import { useEffect, useState } from 'react'
import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'

export const TERMINAL_WORKTREE_RENDER_DELAY_MS = 180
export const TERMINAL_WORKTREE_RENDER_INPUT_QUIET_MS = 120
export const TERMINAL_WORKTREE_RENDER_IDLE_TIMEOUT_MS = 500

export function useDeferredTerminalWorktreeRender(activeWorktreeId: string | null): string | null {
  const [renderedWorktreeId, setRenderedWorktreeId] = useState(activeWorktreeId)

  useEffect(() => {
    if (renderedWorktreeId === activeWorktreeId) {
      return
    }
    if (!renderedWorktreeId || !activeWorktreeId) {
      setRenderedWorktreeId(activeWorktreeId)
      return
    }

    // Why: mounting/refitting terminal panes can create a long renderer task.
    // Keep sidebar selection instant, and cancel the intermediate shell render
    // if the user clicks back before input has been quiet.
    return scheduleAfterInputQuiet(() => setRenderedWorktreeId(activeWorktreeId), {
      delayMs: TERMINAL_WORKTREE_RENDER_DELAY_MS,
      quietMs: TERMINAL_WORKTREE_RENDER_INPUT_QUIET_MS,
      idleTimeoutMs: TERMINAL_WORKTREE_RENDER_IDLE_TIMEOUT_MS
    })
  }, [activeWorktreeId, renderedWorktreeId])

  return renderedWorktreeId
}

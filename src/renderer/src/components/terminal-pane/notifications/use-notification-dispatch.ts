import type { TerminalNotificationEvent } from './dispatch-terminal-notification'
import { dispatchTerminalNotification } from './dispatch-terminal-notification'
import { useCallback } from 'react'

export function useNotificationDispatch(
  worktreeId: string
): (event: TerminalNotificationEvent) => void {
  return useCallback(
    (event: TerminalNotificationEvent) => {
      dispatchTerminalNotification(worktreeId, event)
    },
    [worktreeId]
  )
}

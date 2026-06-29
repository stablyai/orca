import { useLayoutEffect } from 'react'
import { registerVisibleTerminalTab } from '@/lib/foreground-terminal-tabs'

type VisibleTerminalTabClaimOptions = {
  isVisible: boolean
  tabId: string
}

export function useVisibleTerminalTabClaim({
  isVisible,
  tabId
}: VisibleTerminalTabClaimOptions): void {
  useLayoutEffect(() => {
    if (!isVisible) {
      return
    }
    // Why: agent sleep must fail closed before paint for any pane the user can
    // see, even when global active-worktree state is between views.
    return registerVisibleTerminalTab(tabId)
  }, [isVisible, tabId])
}

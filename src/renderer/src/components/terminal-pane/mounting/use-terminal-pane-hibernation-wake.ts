import { useEffect } from 'react'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import { listenForHibernatedAgentWake } from './hibernated-agent-wake-listener'

export function useTerminalPaneHibernationWake(
  deps: Pick<UseTerminalPaneLifecycleDeps, 'worktreeId' | 'tabId' | 'panePtyBindingsRef'>
): void {
  useEffect(
    () =>
      listenForHibernatedAgentWake(deps.worktreeId, deps.tabId, () =>
        deps.panePtyBindingsRef.current.values()
      ),
    [deps.worktreeId, deps.tabId, deps.panePtyBindingsRef]
  )
}

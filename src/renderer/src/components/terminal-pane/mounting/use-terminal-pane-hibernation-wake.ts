import { useEffect } from 'react'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import { listenForHibernatedAgentWake } from './hibernated-agent-wake-listener'

export function useTerminalPaneHibernationWake(
  deps: Pick<UseTerminalPaneLifecycleDeps, 'worktreeId' | 'panePtyBindingsRef'>
): void {
  useEffect(
    () =>
      listenForHibernatedAgentWake(deps.worktreeId, () => deps.panePtyBindingsRef.current.values()),
    [deps.worktreeId, deps.panePtyBindingsRef]
  )
}

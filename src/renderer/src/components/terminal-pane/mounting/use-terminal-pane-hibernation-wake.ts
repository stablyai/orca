import { useEffect } from 'react'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import { listenForHibernatedAgentWake } from './hibernated-agent-wake-listener'

export function useTerminalPaneHibernationWake(
  deps: Pick<
    UseTerminalPaneLifecycleDeps,
    'worktreeId' | 'tabId' | 'panePtyBindingsRef' | 'managerRef'
  >
): void {
  useEffect(
    () =>
      listenForHibernatedAgentWake(
        deps.worktreeId,
        deps.tabId,
        () => deps.panePtyBindingsRef.current.values(),
        (leafId) => {
          const paneId = deps.managerRef.current?.getNumericIdForLeaf(leafId)
          return paneId === null || paneId === undefined
            ? undefined
            : deps.panePtyBindingsRef.current.get(paneId)
        }
      ),
    [deps.worktreeId, deps.tabId, deps.panePtyBindingsRef, deps.managerRef]
  )
}

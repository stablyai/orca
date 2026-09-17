import { useCallback, useLayoutEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { applyAgentPaneRimToManager, subscribeAgentPaneRim } from './agent-pane-rim-subscriptions'

export function useTerminalPaneAgentRim(context: {
  managerRef: React.MutableRefObject<PaneManager | null>
  tabId: string
  cwd: string | undefined
  paneCount: number
}): void {
  const { managerRef, tabId, cwd, paneCount } = context
  const applyAgentPaneRim = useCallback(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    applyAgentPaneRimToManager(manager, tabId)
  }, [managerRef, tabId])

  // Why: layout effect so the rim lands before paint when panes are added or swapped.
  // Why cwd: a same-tab cwd change rebuilds the pane manager, so re-apply onto the replacement.
  useLayoutEffect(() => {
    applyAgentPaneRim()
    return subscribeAgentPaneRim(tabId, applyAgentPaneRim)
  }, [tabId, cwd, paneCount, applyAgentPaneRim])
}

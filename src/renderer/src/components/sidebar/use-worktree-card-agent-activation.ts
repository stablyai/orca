import { useCallback } from 'react'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { dismissStaleAgentRowByKey } from '../terminal-pane/stale-agent-row'

type WorktreeCardAgentActivationArgs = {
  worktreeId: string
}

export function useWorktreeCardAgentActivation({ worktreeId }: WorktreeCardAgentActivationArgs): {
  handleActivateAgentTab: (tabId: string, paneKey: string) => void
  handleActivateRetainedAgent: (tabId: string, paneKey: string) => void
} {
  const handleActivateAgentTab = useCallback(
    (tabId: string, paneKey: string) => {
      const parsed = parsePaneKey(paneKey)
      if (!parsed) {
        console.warn('[WorktreeCardAgents] malformed paneKey, skipping pane focus', paneKey)
        dismissStaleAgentRowByKey(paneKey)
        return
      }
      if (parsed.tabId !== tabId) {
        console.warn('[WorktreeCardAgents] paneKey tabId mismatch, dismissing row', {
          tabId,
          paneKey
        })
        dismissStaleAgentRowByKey(paneKey)
        return
      }
      // Why: all user-initiated worktree switches must preserve cross-repo activation and nav history.
      activateAndRevealWorktree(worktreeId)
      const state = useAppStore.getState()
      const tabs = state.tabsByWorktree[worktreeId] ?? []
      if (tabs.some((tab) => tab.id === tabId)) {
        activateTabAndFocusPane(tabId, parsed.leafId, {
          ackPaneKeyOnSuccess: paneKey,
          flashFocusedPane: true,
          scrollToBottomIfOutputSinceLastView: true
        })
        return
      }
      const liveEntry = state.agentStatusByPaneKey[paneKey]
      if (liveEntry?.worktreeId === worktreeId) {
        // Why: orchestration status can be worktree-attributed before its tab reaches this renderer.
        return
      }
      dismissStaleAgentRowByKey(paneKey)
    },
    [worktreeId]
  )

  const handleActivateRetainedAgent = useCallback(() => {
    // Why: retained rows must stay inert so a sleeping session is never resumed.
  }, [])

  return { handleActivateAgentTab, handleActivateRetainedAgent }
}

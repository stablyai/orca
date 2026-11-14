import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { activateTerminalTabOnOwner } from '@/lib/workspace/tabs/terminal-tab-owner-activation'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { dismissStaleAgentRowByKey } from '../../../terminal-pane/agent-status/stale-agent-row'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export function useWorktreeAgentActivation(worktreeId: string, executionHostId?: ExecutionHostId) {
  return useCallback(
    (tabId: string, paneKey: string) =>
      activateWorktreeAgentPane(worktreeId, tabId, paneKey, executionHostId),
    [executionHostId, worktreeId]
  )
}

/** Open an agent's pane the way its sidebar row does, including before its tab hydrates. */
export function activateWorktreeAgentPane(
  worktreeId: string,
  tabId: string,
  paneKey: string,
  executionHostId?: ExecutionHostId
): void {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    // Legacy/malformed pane keys cannot resolve after replay; discard stale rows rather than guessing.
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
  // Use the workspace dispatcher for cross-repo reveal, navigation history and folder path gates.
  if (
    activateAndRevealWorkspace(worktreeId, executionHostId ? { executionHostId } : undefined) ===
    false
  ) {
    return
  }
  const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
  if (tabs.some((t) => t.id === tabId)) {
    activateTabAndFocusPane(tabId, parsed.leafId, {
      ackPaneKeyOnSuccess: paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    activateTerminalTabOnOwner(worktreeId, tabId, parsed.leafId)
  } else if (!activateStructuredAgentSessionTab({ worktreeId, tabId })) {
    const liveEntry = useAppStore.getState().agentStatusByPaneKey[paneKey]
    if (liveEntry?.worktreeId === worktreeId) {
      // Live worker status can precede tab hydration; retain the row and activate its owning terminal.
      activateTerminalTabOnOwner(worktreeId, tabId, parsed.leafId)
      return
    }
    dismissStaleAgentRowByKey(paneKey)
  }
}

import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { activateTerminalTabOnOwner } from '@/lib/workspace/tabs/terminal-tab-owner-activation'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForTab
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { stablePaneHasLivePty } from '@/lib/agent-session/resume/sleeping-agent-pane-ownership'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { getPtyExecutionHost } from '../../../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import { isExecutionHostForWorktree } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'

export function activateRetainedAgentRow(
  worktreeId: string,
  tabId: string,
  paneKey: string,
  executionHostId?: ExecutionHostId
): void {
  const parsed = parsePaneKey(paneKey)
  const state = useAppStore.getState()
  const nativeTab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) =>
      tab.id === tabId && tab.worktreeId === worktreeId && tab.contentType === 'agent-session'
  )
  if (
    parsed
      ? parsed.tabId !== tabId
      : !nativeTab || structuredAgentSessionPaneKey(nativeTab.id, nativeTab.entityId) !== paneKey
  ) {
    return
  }
  const target = nativeTab ? structuredAgentSessionTargetForTab(state, nativeTab) : null
  const layout = state.terminalLayoutsByTabId[tabId]
  const hasLiveTerminal =
    parsed &&
    state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId) &&
    stablePaneHasLivePty(tabId, parsed.leafId, state.ptyIdsByTabId, layout)
  const owner = nativeTab
    ? structuredAgentSessionOwnerForTab(state, nativeTab)
    : getPtyExecutionHost(
        (parsed && layout?.ptyIdsByLeafId?.[parsed.leafId]) ?? state.ptyIdsByTabId[tabId]?.[0]
      )
  if (
    (nativeTab ? !target : !hasLiveTerminal) ||
    owner === 'foreign' ||
    (executionHostId &&
      owner &&
      !isExecutionHostForWorktree(state, worktreeId, executionHostId, owner))
  ) {
    return
  }
  // Verify an existing destination before workspace activation can resume sleeping panes.
  if (
    activateAndRevealWorkspace(worktreeId, {
      executionHostId: executionHostId ?? owner ?? undefined
    }) === false
  ) {
    return
  }
  if (nativeTab && target) {
    activateStructuredAgentSessionTab({ worktreeId, tabId, target })
  } else if (parsed) {
    activateTabAndFocusPane(tabId, parsed.leafId, {
      ackPaneKeyOnSuccess: paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    activateTerminalTabOnOwner(worktreeId, tabId, parsed.leafId)
  }
}

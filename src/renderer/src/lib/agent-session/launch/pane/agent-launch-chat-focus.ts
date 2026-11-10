import type { AgentLaunchChatFocus } from '../../../../../../shared/agent-launch/contracts/agent-launch-tab-publication'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/native-chat/local-sessions/local-structured-session-owner'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import {
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import { useAppStore } from '../../../../store/index'
import { getExecutionHostIdForWorktree } from '../../../workspace/ownership/worktree-runtime-owner'
import { revealWorkspaceSurface } from '../../../workspace/activation/workspace-surface-reveal'
import { findStructuredAgentSessionTab } from '../../structured-agent-session-tab-activation'

/** Selects a focused host launch's chat, or has its tab selected when the host's listing brings it. */
export function focusAgentLaunchChat({
  worktreeId,
  sessionId,
  revealWorkspace
}: AgentLaunchChatFocus): void {
  // The chat runs on this machine; a shown same-ID copy elsewhere would keep its listing out.
  const showedOtherCopy =
    getExecutionHostIdForWorktree(useAppStore.getState(), worktreeId) !== LOCAL_EXECUTION_HOST_ID
  if (revealWorkspace) {
    revealWorkspaceSurface(
      useAppStore.getState(),
      worktreeId,
      undefined,
      showedOtherCopy ? LOCAL_EXECUTION_HOST_ID : undefined
    )
  }
  const state = useAppStore.getState()
  const tab = findStructuredAgentSessionTab(state.unifiedTabsByWorktree, {
    workspaceId: worktreeId,
    sessionId,
    target: { kind: 'local' }
  })
  if (!tab) {
    // A populated workspace keeps the user's later tab choice; an empty one is still being provisioned.
    const populated = (state.unifiedTabsByWorktree[worktreeId] ?? []).length > 0
    recordWebSessionFocusIntent(
      { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
      worktreeId,
      `agent-session:${sessionId}`,
      undefined,
      populated ? resolveWebSessionVisibleTabId(state, worktreeId) : undefined
    )
    if (revealWorkspace && showedOtherCopy) {
      // Its listing was skipped while the other copy was shown.
      void refreshLocalStructuredSessionWorktreeTabs(worktreeId).catch(() => {})
    }
    return
  }
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId })
  state.setActiveTabType('agent-session', worktreeId)
}

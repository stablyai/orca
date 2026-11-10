import type { AgentLaunchChatFocus } from '../../../../../../shared/agent-launch/contracts/agent-launch-tab-publication'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/native-chat/local-sessions/local-structured-session-owner'
import { recordWebSessionFocusIntent } from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import { useAppStore } from '../../../../store/index'
import { revealWorkspaceSurface } from '../../../workspace/activation/workspace-surface-reveal'
import { findStructuredAgentSessionTab } from '../../structured-agent-session-tab-activation'

/** Selects a focused host launch's chat, or has its tab selected when the host's listing brings it. */
export function focusAgentLaunchChat({
  worktreeId,
  sessionId,
  revealWorkspace
}: AgentLaunchChatFocus): void {
  if (revealWorkspace) {
    revealWorkspaceSurface(useAppStore.getState(), worktreeId)
  }
  const state = useAppStore.getState()
  const tab = findStructuredAgentSessionTab(state.unifiedTabsByWorktree, {
    workspaceId: worktreeId,
    sessionId
  })
  if (!tab) {
    recordWebSessionFocusIntent(
      { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
      worktreeId,
      `agent-session:${sessionId}`
    )
    return
  }
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId })
  state.setActiveTabType('agent-session', worktreeId)
}

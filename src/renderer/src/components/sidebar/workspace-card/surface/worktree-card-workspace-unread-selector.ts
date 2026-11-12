import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import {
  completionPaneKeysByTabId,
  workspaceMarkerTabs
} from '@/store/slices/workspace-attention/workspace-live-markers'
import { markerTabPaneKey } from '@/store/slices/workspace-attention/workspace-marker-host'
import {
  workspaceUnreadTarget,
  workspaceUnreadTargetsOutsideAgentRows,
  type SlotTarget
} from '../../worktree-card-slot-targets'

/**
 * Exactly what `workspaceUnreadTargetsOutsideAgentRows` reads for this workspace, so an agent
 * update, marker or layout change in another workspace does not re-resolve this card. O(tabs
 * in this workspace); completion markers come from the shared per-snapshot tab index.
 */
export function workspaceUnreadInputs(state: AppState, worktree: Worktree): unknown[] {
  const identity = composeWorktreeHostIdentity(worktree.hostId ?? 'local', worktree.id)
  const inputs: unknown[] = [
    state.workspacesMarkedUnreadByUser[identity],
    state.tabsByWorktree[worktree.id],
    state.unifiedTabsByWorktree[worktree.id]
  ]
  const completions = completionPaneKeysByTabId(state.unreadAgentCompletionPanes)
  let hasStructuredTab = false
  for (const tab of workspaceMarkerTabs(state, worktree.id)) {
    hasStructuredTab ||= tab.sessionId !== null
    inputs.push(
      state.unreadTerminalTabs[tab.id],
      completions.get(tab.id),
      // Host resolution for this tab: its layout, pty ids, and status entry.
      state.terminalLayoutsByTabId[tab.id],
      state.ptyIdsByTabId[tab.id],
      state.agentStatusByPaneKey[markerTabPaneKey(state, tab)]
    )
  }
  if (hasStructuredTab) {
    // Chat ownership can fall back to workspace and runtime state when a tab has no stamped host.
    inputs.push(...structuredAgentSessionOwnerInputs(state))
  }
  return inputs
}

/** Whether the card's workspace unread has a source its visible agent rows don't already show. */
export function createWorkspaceUnreadSelector(
  worktree: Worktree,
  visibleAgents: readonly SlotTarget[]
) {
  const target = workspaceUnreadTarget(
    worktree.id,
    worktree.lastActivityAt || null,
    worktree.hostId
  )
  let inputs: readonly unknown[] | null = null
  let unread = false
  return (state: AppState) => {
    if (!worktree.isUnread) {
      return false
    }
    const next = workspaceUnreadInputs(state, worktree)
    if (
      inputs === null ||
      next.length !== inputs.length ||
      !next.every((value, index) => value === inputs![index])
    ) {
      inputs = next
      unread = workspaceUnreadTargetsOutsideAgentRows(state, target, visibleAgents).length > 0
    }
    return unread
  }
}

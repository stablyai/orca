/** `agent launch --split`: move a launched chat into a new pane beside its caller once this window lists it. */

import type { StoreApi } from 'zustand'
import type { AppState } from '../../../../store/types'
import type { AgentLaunchPlacementReceipt } from '../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { AgentLaunchSplitRequest } from '../../../../../../shared/agent-launch/contracts/agent-launch-split'
import { isPaneColumnSplitDropNoOp } from '../../../../../../shared/workspace-layout/tab-groups/pane-column-split-drop-no-op'

const chatTab = (state: AppState, worktreeId: string, sessionId: string | undefined) =>
  state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
  )

function place(
  store: StoreApi<AppState>,
  request: AgentLaunchSplitRequest,
  tab: { id: string; groupId: string }
): AgentLaunchPlacementReceipt {
  const { worktreeId, split } = request
  const state = store.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const focusedGroupId = state.activeGroupIdByWorktree[worktreeId]
  // Resolved now, not when main asked: the caller's pane may have moved or closed since.
  const target = [chatTab(state, worktreeId, split.fromSessionId)?.groupId, focusedGroupId].find(
    (id) => groups.some((group) => group.id === id)
  )
  const notSplit = { groupId: tab.groupId, fallback: 'not-split' as const }
  if (!target || Date.now() >= request.expiresAt) {
    return notSplit
  }
  const drop = {
    sourceGroupId: tab.groupId,
    targetGroupId: target,
    splitDirection: split.direction,
    sourceTabCount: groups.find((group) => group.id === tab.groupId)?.tabOrder.length ?? 0,
    layout: state.layoutByWorktree[worktreeId]
  }
  // Already alone on that side of the caller (a repeated request), or the caller's only tab.
  if (isPaneColumnSplitDropNoOp(drop)) {
    return tab.groupId === target ? notSplit : { groupId: tab.groupId }
  }
  if (!state.dropUnifiedTab(tab.id, { groupId: target, splitDirection: split.direction })) {
    return notSplit
  }
  const after = store.getState()
  // A background launch leaves the user in the pane they were in.
  if (
    !request.activate &&
    focusedGroupId &&
    after.groupsByWorktree[worktreeId]?.some((g) => g.id === focusedGroupId)
  ) {
    after.focusGroup(worktreeId, focusedGroupId)
  }
  return { groupId: chatTab(after, worktreeId, request.sessionId)?.groupId ?? tab.groupId }
}

/** Places the chat once it is listed, until the request expires. */
export function placeAgentLaunchSplit(
  store: StoreApi<AppState>,
  request: AgentLaunchSplitRequest
): Promise<AgentLaunchPlacementReceipt> {
  return new Promise((resolve) => {
    const settle = (): void => {
      const tab = chatTab(store.getState(), request.worktreeId, request.sessionId)
      const expired = Date.now() >= request.expiresAt
      if (!tab && !expired) {
        return
      }
      // Stop listening before the move writes to the store.
      unsubscribe()
      clearTimeout(timer)
      resolve(tab ? place(store, request, tab) : { groupId: '', fallback: 'not-split' })
    }
    const unsubscribe = store.subscribe(settle)
    const timer = setTimeout(settle, Math.max(0, request.expiresAt - Date.now()))
    settle()
  })
}

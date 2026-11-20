import { useShallow } from 'zustand/react/shallow'
import { useMemo } from 'react'
import {
  runtimeTargetEnvironmentId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store/index'
import { structuredAgentSessionTargetForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { nativeChatAuxiliaryParentKey } from '@/store/slices/right-sidebar/native-chat-auxiliary-state'
import type { AppState } from '@/store/types'
import type { NativeChatAuxiliaryParent } from '@/store/slices/right-sidebar/native-chat-auxiliary-state'

/**
 * The standalone chat in the focused pane: follow the active group, not a recent chat elsewhere.
 * A side-chat source is only this tab; switching panes or tabs must not retarget a stale one.
 */
export function readActiveNativeChatAuxiliaryParent(
  state: AppState
): NativeChatAuxiliaryParent | null {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const groups = state.groupsByWorktree[worktreeId]
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  const group = groups?.find((entry) => entry.id === groupId)
  const tabId = group?.activeTabId
  if (!tabId) {
    return null
  }
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
  if (tab?.contentType !== 'agent-session' || !tab.agentSessionAgent) {
    return null
  }
  const target = structuredAgentSessionTargetForTab(state, tab)
  if (!target) {
    return null
  }
  return {
    sessionId: tab.entityId,
    tabId: tab.id,
    worktreeId,
    target,
    agent: tab.agentSessionAgent
  }
}

/** Reuses the current selection so a hidden pane receives no subscription until it becomes the source. */
export function useActiveNativeChatAuxiliaryParent(): NativeChatAuxiliaryParent | null {
  // Target lookup creates a new object. Compare its identity, not the object, in the store snapshot.
  const parent = useAppStore(
    useShallow((state: AppState) => {
      const active = readActiveNativeChatAuxiliaryParent(state)
      if (!active) {
        return null
      }
      const { target, ...source } = active
      return { ...source, environmentId: runtimeTargetEnvironmentId(target) }
    })
  )
  return useMemo(() => {
    if (!parent) {
      return null
    }
    const { environmentId, ...source } = parent
    return { ...source, target: runtimeTargetForOwnerEnvironment(environmentId) }
  }, [parent])
}

/** Whether the descriptor still names the focused pane's own standalone chat, on the same host. */
export function nativeChatAuxiliaryParentSelected(
  state: AppState,
  parent: NativeChatAuxiliaryParent
): boolean {
  const active = readActiveNativeChatAuxiliaryParent(state)
  return (
    active !== null &&
    active.tabId === parent.tabId &&
    active.worktreeId === parent.worktreeId &&
    nativeChatAuxiliaryParentKey(active) === nativeChatAuxiliaryParentKey(parent)
  )
}

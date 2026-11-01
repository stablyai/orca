import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../worktree-runtime-owner'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { useAppStore } from '@/store/index'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionOwnerForTab
} from '@/runtime/structured-agent-session-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { Tab } from '../../../../shared/tab-types'

export function findStructuredAgentSessionTab(
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>,
  args: { sessionId: string } & (
    | { workspaceId: string; target?: RuntimeClientTarget }
    | { workspaceId?: undefined; target: RuntimeClientTarget }
  )
): Tab | null {
  const workspaceIds =
    args.workspaceId === undefined ? Object.keys(unifiedTabsByWorktree) : [args.workspaceId]
  for (const workspaceId of workspaceIds) {
    const tab = unifiedTabsByWorktree[workspaceId]?.find(
      (candidate) =>
        candidate.worktreeId === workspaceId &&
        candidate.contentType === 'agent-session' &&
        candidate.entityId === args.sessionId &&
        (!args.target ||
          structuredAgentSessionOwnerForTab(useAppStore.getState(), candidate) ===
            executionHostIdForStructuredTarget(args.target))
    )
    if (tab) {
      return tab
    }
  }
  return null
}

export function activateStructuredAgentSessionTab(args: {
  worktreeId: string
  tabId: string
  target?: RuntimeClientTarget
  callerOnly?: boolean
}): boolean {
  const state = useAppStore.getState()
  const tab = (state.unifiedTabsByWorktree[args.worktreeId] ?? []).find(
    (candidate) =>
      candidate.id === args.tabId &&
      candidate.contentType === 'agent-session' &&
      (!args.target ||
        structuredAgentSessionOwnerForTab(state, candidate) ===
          executionHostIdForStructuredTarget(args.target))
  )
  if (!tab) {
    return false
  }
  state.focusGroup(args.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: args.worktreeId })
  state.setActiveTabType('agent-session', args.worktreeId)
  requestNativeChatComposerFocus(tab.id)
  activateStructuredAgentSessionTabOnOwner(args.worktreeId, tab.entityId, args.target, {
    callerOnly: args.callerOnly
  })
  return true
}

/** The chat's host keeps this client's tab selection; every local activation must reach it. */
export function activateStructuredAgentSessionTabOnOwner(
  worktreeId: string,
  sessionId: string,
  target?: RuntimeClientTarget,
  options?: { callerOnly?: boolean }
): void {
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
  void callRuntimeRpc(
    target ?? runtimeTargetForOwnerEnvironment(environmentId),
    'session.tabs.activate',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      tabId: `agent-session:${sessionId}`,
      // Why both: navigation scopes new hosts to this client; notifyClients:false protects old hosts.
      ...(options?.callerOnly ? { notifyClients: false, navigation: 'caller' as const } : {})
    }
  )
}

export function activateStructuredAgentSessionById(args: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
  callerOnly?: boolean
}): boolean {
  const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
    workspaceId: args.worktreeId,
    sessionId: args.sessionId,
    target: args.target
  })
  return tab
    ? activateStructuredAgentSessionTab({
        worktreeId: args.worktreeId,
        tabId: tab.id,
        target: args.target,
        callerOnly: args.callerOnly
      })
    : false
}

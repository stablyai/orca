import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../workspace/ownership/worktree-runtime-owner'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { useAppStore } from '@/store/index'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionOwnerForTab
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'

export function findStructuredAgentSessionTab(
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>,
  args: { workspaceId: string; sessionId: string; target?: RuntimeClientTarget }
): Tab | null {
  return (
    unifiedTabsByWorktree[args.workspaceId]?.find(
      (candidate) =>
        candidate.worktreeId === args.workspaceId &&
        candidate.contentType === 'agent-session' &&
        candidate.entityId === args.sessionId &&
        (!args.target ||
          structuredAgentSessionOwnerForTab(useAppStore.getState(), candidate) ===
            executionHostIdForStructuredTarget(args.target))
    ) ?? null
  )
}

export function activateStructuredAgentSessionTab(args: {
  worktreeId: string
  tabId: string
  target?: RuntimeClientTarget
  windowOnly?: boolean
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
  activateStructuredAgentSessionTabOnOwner(args.worktreeId, tab.entityId, args.target, args)
  return true
}

/** The chat's host keeps this client's tab selection; every local activation must reach it. */
export function activateStructuredAgentSessionTabOnOwner(
  worktreeId: string,
  sessionId: string,
  target?: RuntimeClientTarget,
  options?: { callerOnly?: boolean; windowOnly?: boolean }
): void {
  const owner =
    target ??
    runtimeTargetForOwnerEnvironment(
      runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
    )
  const activation = callRuntimeRpc(owner, 'session.tabs.activate', {
    worktree: toRuntimeWorktreeSelector(worktreeId),
    tabId: `agent-session:${sessionId}`,
    // Older hosts rely on notifyClients to keep the activation in the requesting window.
    ...(options?.windowOnly || options?.callerOnly
      ? {
          notifyClients: false,
          navigation: options.windowOnly && owner.kind === 'local' ? 'host' : 'caller'
        }
      : {})
  })
  if (options?.windowOnly) {
    // A chat may have ended since a workspace link was made. The workspace is already open.
    void activation.catch((error: unknown) => console.warn('Failed to open linked agent:', error))
  }
}

export function activateStructuredAgentSessionById(args: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
  windowOnly?: boolean
}): boolean {
  const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
    workspaceId: args.worktreeId,
    sessionId: args.sessionId,
    target: args.target
  })
  return tab ? activateStructuredAgentSessionTab({ ...args, tabId: tab.id }) : false
}

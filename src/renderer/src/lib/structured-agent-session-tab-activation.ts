import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

export function activateStructuredAgentSessionTab(args: {
  worktreeId: string
  tabId: string
}): boolean {
  const state = useAppStore.getState()
  const tab = (state.unifiedTabsByWorktree[args.worktreeId] ?? []).find(
    (candidate) => candidate.id === args.tabId && candidate.contentType === 'agent-session'
  )
  if (!tab) {
    return false
  }
  state.focusGroup(args.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: args.worktreeId })
  state.setActiveTabType('agent-session', args.worktreeId)
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, args.worktreeId)
  void callRuntimeRpc(
    getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    'session.tabs.activate',
    {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: `agent-session:${tab.entityId}`
    }
  )
  return true
}

export function activateStructuredAgentSessionById(args: {
  worktreeId: string
  sessionId: string
}): boolean {
  const tab = (useAppStore.getState().unifiedTabsByWorktree[args.worktreeId] ?? []).find(
    (candidate) =>
      candidate.contentType === 'agent-session' && candidate.entityId === args.sessionId
  )
  return tab
    ? activateStructuredAgentSessionTab({ worktreeId: args.worktreeId, tabId: tab.id })
    : false
}

import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { structuredAgentSessionOwnerCallFence } from '@/runtime/structured-agent-session-owner'
import { structuredTabOwnerBinding } from '@/runtime/structured-tab-owner'
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
  // The host this tab was stamped for, fenced on the revision it was stamped at: a re-pair must
  // fail the call rather than activate a same-id tab on the machine that replaced it.
  const binding = structuredTabOwnerBinding(
    tab,
    getRuntimeEnvironmentIdForWorktree(state, args.worktreeId)
  )
  void callRuntimeRpc(
    binding.target,
    'session.tabs.activate',
    {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: `agent-session:${tab.entityId}`
    },
    structuredAgentSessionOwnerCallFence(binding.owner)
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

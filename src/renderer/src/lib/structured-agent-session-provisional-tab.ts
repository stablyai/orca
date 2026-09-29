import type { Tab } from '../../../shared/tab-types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { defaultAgentChatLabel } from '../../../shared/agent-session-chat-label'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import type {
  AgentSessionLaunchPlan,
  AgentSessionLaunchTarget
} from '@/lib/agent-session-launch-plan'
import type {
  StructuredAgentLaunchHandle,
  StructuredAgentLaunchHooks
} from '@/lib/structured-agent-launch-settlement'
import { useAppStore } from '@/store'

export type StructuredAgentSessionProvisionalLaunch = StructuredAgentLaunchHandle & { tab: Tab }

export function openStructuredAgentSessionProvisionalTab(args: {
  worktreeId: string
  sessionId: string
  agent: 'claude' | 'codex'
  targetGroupId?: string
  activate?: boolean
}): Tab {
  const state = useAppStore.getState()
  const tabId = structuredAgentSessionTabId(args.sessionId)
  const existing = (state.unifiedTabsByWorktree[args.worktreeId] ?? []).find(
    (candidate) =>
      candidate.id === tabId &&
      candidate.contentType === 'agent-session' &&
      candidate.entityId === args.sessionId
  )
  if (existing) {
    if (args.activate !== false) {
      state.focusGroup(args.worktreeId, existing.groupId)
      state.activateTab(existing.id, { worktreeId: args.worktreeId })
      state.setActiveTabType('agent-session', args.worktreeId)
    }
    return existing
  }
  const tab = state.createUnifiedTab(args.worktreeId, 'agent-session', {
    id: tabId,
    entityId: args.sessionId,
    executionHostId: getExecutionHostIdForWorktree(state, args.worktreeId),
    agentSessionAgent: args.agent,
    label: defaultAgentChatLabel(args.agent),
    ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
    activate: args.activate !== false
  })
  if (args.activate !== false) {
    state.setActiveTabType('agent-session', args.worktreeId)
  }
  return tab
}

/** Binds the synchronous launch identity to a chat tab before the caller yields. */
export function beginStructuredAgentSessionProvisionalLaunch(args: {
  plan: AgentSessionLaunchPlan
  hooks: StructuredAgentLaunchHooks
  target?: AgentSessionLaunchTarget
  targetGroupId?: string
  activate?: boolean
  /** Lets workspace flows reveal between final identity allocation and tab ownership. */
  beforeOpen?: (sessionId: string) => boolean | void
}): StructuredAgentSessionProvisionalLaunch | null {
  const handle = args.plan.begin(args.hooks, args.target)
  if (!handle) {
    return null
  }
  const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
  if (!worktreeId || (args.plan.agent !== 'claude' && args.plan.agent !== 'codex')) {
    throw new Error('A provisional structured launch needs its workspace and provider.')
  }
  try {
    if (args.beforeOpen?.(handle.sessionId) === false) {
      handle.cancel()
      return null
    }
    return {
      ...handle,
      tab: openStructuredAgentSessionProvisionalTab({
        worktreeId,
        sessionId: handle.sessionId,
        agent: args.plan.agent,
        ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
        ...(args.activate !== undefined ? { activate: args.activate } : {})
      })
    }
  } catch (error) {
    // Why: a launch without its owning surface would strand a late publication.
    handle.cancel()
    throw error
  }
}

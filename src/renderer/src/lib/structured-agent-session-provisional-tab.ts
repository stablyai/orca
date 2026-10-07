import type { Tab } from '../../../shared/tab-types'
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
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  beginPairedStructuredLaunch,
  openDeclinedStructuredLaunchTerminal,
  type DeclinedStructuredLaunchTerminalOptions,
  type PairedStructuredLaunch,
  type StructuredLaunchTerminal
} from '@/lib/structured-agent-session-paired-admission'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

type LocalProvisionalLaunch = StructuredAgentLaunchHandle & { tab: Tab }

/** A local chat has its tab at once; a paired server's has none until the server admits it. */
export type StructuredAgentSessionProvisionalLaunch =
  | LocalProvisionalLaunch
  | PairedStructuredLaunch

export function openStructuredAgentSessionProvisionalTab(args: {
  worktreeId: string
  /** The host the chat is created on; every later operation on the tab reads it. */
  executionHostId: ExecutionHostId
  sessionId: string
  agent: TuiAgent
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
    executionHostId: args.executionHostId,
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

/** The paired server a structured launch would run on, which admits the chat before it exists. */
export function structuredLaunchPairedOwner(
  plan: Pick<AgentSessionLaunchPlan, 'route' | 'executionHostId'>,
  worktreeId: string,
  target?: AgentSessionLaunchTarget
): { executionHostId: ExecutionHostId; target: RuntimeClientTarget } | null {
  if (plan.route !== 'structured-native-chat') {
    return null
  }
  const executionHostId =
    target?.executionHostId ??
    plan.executionHostId ??
    resolveStructuredAgentSessionOwner(useAppStore.getState(), worktreeId)
  const hostTarget = structuredAgentSessionTargetForHost(executionHostId)
  return executionHostId && hostTarget?.kind === 'environment'
    ? { executionHostId, target: hostTarget }
    : null
}

type ProvisionalLaunchArgs = {
  plan: AgentSessionLaunchPlan
  hooks: StructuredAgentLaunchHooks
  target?: AgentSessionLaunchTarget
  targetGroupId?: string
  activate?: boolean
  /** Lets workspace flows reveal before the chat's tab is owned; a paired launch reveals before its
   *  server is asked, when no session id exists yet. */
  beforeOpen?: (sessionId?: string) => boolean | void
  /** The terminal a paired server's "no" opens; a caller without one gets a new agent tab's. */
  onHostDeclined?: () => Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal
  /** What that default terminal carries from the caller, e.g. a recipe's saved CLI arguments. */
  declinedTerminal?: DeclinedStructuredLaunchTerminalOptions
}

/** Binds the launch to a chat tab: at once locally, after the server admits it on a paired host. */
export function beginStructuredAgentSessionProvisionalLaunch(
  args: ProvisionalLaunchArgs
): StructuredAgentSessionProvisionalLaunch | null {
  const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
  const paired = worktreeId ? structuredLaunchPairedOwner(args.plan, worktreeId, args.target) : null
  if (!paired || !worktreeId) {
    return beginLocalProvisionalLaunch(args)
  }
  if (args.beforeOpen?.() === false) {
    return null
  }
  return beginPairedStructuredLaunch({
    plan: args.plan,
    hooks: args.hooks,
    worktreeId,
    executionHostId: paired.executionHostId,
    target: paired.target,
    openAdmitted: (seedOptions) =>
      beginLocalProvisionalLaunch({
        ...args,
        target: {
          ...args.target,
          worktreeId,
          executionHostId: paired.executionHostId,
          ...(seedOptions ? { seedOptions } : {})
        },
        beforeOpen: undefined
      }),
    onHostDeclined:
      args.onHostDeclined ??
      (() =>
        openDeclinedStructuredLaunchTerminal({
          plan: args.plan,
          worktreeId,
          ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
          ...(args.declinedTerminal ? { terminal: args.declinedTerminal } : {})
        }))
  })
}

function beginLocalProvisionalLaunch(args: ProvisionalLaunchArgs): LocalProvisionalLaunch | null {
  const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
  // The group the tab opens in: the caller's, else the workspace's active one.
  const groupId =
    args.targetGroupId ??
    (worktreeId ? useAppStore.getState().activeGroupIdByWorktree[worktreeId] : undefined)
  const handle = args.plan.begin(args.hooks, groupId ? { ...args.target, groupId } : args.target)
  if (!handle) {
    return null
  }
  if (!worktreeId) {
    throw new Error('A provisional structured launch needs its workspace.')
  }
  try {
    if (args.beforeOpen?.(handle.sessionId) === false) {
      handle.cancel()
      return null
    }
    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId,
      executionHostId: handle.executionHostId,
      sessionId: handle.sessionId,
      agent: args.plan.agent,
      ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
      ...(args.activate !== undefined ? { activate: args.activate } : {})
    })
    return { ...handle, tab }
  } catch (error) {
    // Why: a launch without its owning surface would strand a late publication.
    handle.cancel()
    throw error
  }
}

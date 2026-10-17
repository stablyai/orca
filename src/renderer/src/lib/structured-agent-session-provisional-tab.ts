import type { Tab } from '../../../shared/tab-types'
import { defaultAgentChatLabel } from '../../../shared/agent-session-chat-label'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import type {
  AgentSessionLaunchPlan,
  AgentSessionLaunchTarget
} from '@/lib/agent-session-launch-plan'
import type {
  StructuredAgentLaunchHandle,
  StructuredAgentLaunchHooks,
  StructuredAgentLaunchSettlement
} from '@/lib/structured-agent-launch-settlement'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  beginHostAdmittedStructuredLaunch,
  openDeclinedStructuredLaunchTerminal,
  type DeclinedStructuredLaunchTerminalOptions,
  type HostAdmittedStructuredLaunch,
  type StructuredLaunchTerminal
} from '@/lib/structured-agent-session-launch-admission'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { clearWebSessionFocusIntentIfMatches } from '@/runtime/web-session-focus-intent'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { nativeChatComposerHasUserContent } from '@/components/native-chat/native-chat-pending-attachment-cache'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'

type LocalProvisionalLaunch = StructuredAgentLaunchHandle & { tab: Tab }

/** A chat's tab opens once its host admits it; a launch with no host to ask takes the direct path. */
export type StructuredAgentSessionProvisionalLaunch =
  | LocalProvisionalLaunch
  | HostAdmittedStructuredLaunch

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

/** The host a structured launch would run on, which admits the chat before it exists. */
export function structuredLaunchOwner(
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
  return executionHostId && hostTarget ? { executionHostId, target: hostTarget } : null
}

type ProvisionalLaunchArgs = {
  plan: AgentSessionLaunchPlan
  hooks: StructuredAgentLaunchHooks
  focusIntent?: NativeChatComposerFocusIntent
  target?: AgentSessionLaunchTarget
  targetGroupId?: string
  activate?: boolean
  /** Lets workspace flows reveal before the chat's tab is owned: before its host is asked, when no
   *  session id exists yet. */
  beforeOpen?: (sessionId?: string) => boolean | void
  /** The terminal the host's "no" opens; a caller without one gets a new agent tab's. */
  onHostDeclined?: (
    target: RuntimeClientTarget
  ) => Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal
  /** What that default terminal carries from the caller, e.g. a recipe's saved CLI arguments. */
  declinedTerminal?: DeclinedStructuredLaunchTerminalOptions
}

type LaunchOwner = { executionHostId: ExecutionHostId; target: RuntimeClientTarget }

function openDeclinedTerminal(
  args: ProvisionalLaunchArgs,
  worktreeId: string,
  target: RuntimeClientTarget
): Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal {
  if (args.onHostDeclined) {
    return args.onHostDeclined(target)
  }
  return openDeclinedStructuredLaunchTerminal({
    plan: args.plan,
    worktreeId,
    ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
    ...(args.declinedTerminal ? { terminal: args.declinedTerminal } : {})
  })
}

/** A New Chat the user just asked for opens its chat now, so the next key has a composer; its own
 *  launch asks the host. A prompt to deliver keeps asking first: a "no" hands it to a terminal. */
function opensAtAction(args: ProvisionalLaunchArgs): boolean {
  const { plan } = args
  return (
    args.focusIntent !== undefined &&
    args.activate !== false &&
    !plan.resumeFrom &&
    (!plan.prompt?.trim() || plan.promptDelivery === 'draft')
  )
}

/** A definite "no" to a chat nobody typed in yet opens its terminal in the chat's place, where
 *  asking first used to land. A chat with typing keeps it. */
async function openTerminalForDeclinedChat(
  args: ProvisionalLaunchArgs,
  worktreeId: string,
  owner: LaunchOwner,
  tab: Tab,
  settlement: StructuredAgentLaunchSettlement
): Promise<StructuredAgentLaunchSettlement> {
  const scopeKey = structuredAgentSessionDraftScopeKey(tab.entityId)
  if (
    settlement.kind !== 'failed' ||
    !(settlement.error instanceof StructuredAgentSessionCreateRefusalError) ||
    settlement.error.code !== 'structured_agent_session_unsupported' ||
    nativeChatComposerHasUserContent(scopeKey)
  ) {
    return settlement
  }
  const terminal = await openDeclinedTerminal(args, worktreeId, owner.target)
  if (!terminal.opened || nativeChatComposerHasUserContent(scopeKey)) {
    return settlement
  }
  useAppStore.getState().closeUnifiedTab(tab.id)
  return { kind: 'terminal' }
}

function beginActionLaunch(
  args: ProvisionalLaunchArgs,
  worktreeId: string,
  owner: LaunchOwner,
  open: (launch: LocalProvisionalLaunch | null) => LocalProvisionalLaunch | null
): LocalProvisionalLaunch | null {
  const launch = open(
    beginLocalProvisionalLaunch({
      ...args,
      target: { ...args.target, worktreeId, executionHostId: owner.executionHostId },
      beforeOpen: undefined
    })
  )
  if (!launch) {
    return null
  }
  // The chat is already the visible tab; its host's copy arriving later must not pull focus back.
  clearWebSessionFocusIntentIfMatches(
    structuredAgentSessionFocusOwner(owner.target),
    worktreeId,
    `agent-session:${launch.sessionId}`
  )
  return {
    ...launch,
    settlement: launch.settlement.then((settlement) =>
      openTerminalForDeclinedChat(args, worktreeId, owner, launch.tab, settlement)
    )
  }
}

/** Binds the launch to a chat tab: at once for a New Chat the user asked for, otherwise once its
 *  host, this machine included, admits the chat. */
export function beginStructuredAgentSessionProvisionalLaunch(
  args: ProvisionalLaunchArgs
): StructuredAgentSessionProvisionalLaunch | null {
  const focusIntent = args.focusIntent
  if (args.activate === false) {
    focusIntent?.cancel()
  }
  const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
  let tabOpened = false
  const cancelIfNoTab = (): void => {
    if (!tabOpened) {
      focusIntent?.cancel()
    }
  }
  const open = (launch: LocalProvisionalLaunch | null): LocalProvisionalLaunch | null => {
    if (launch) {
      tabOpened = true
      if (args.activate !== false) {
        focusIntent?.request(launch.tab.id)
      }
    } else {
      cancelIfNoTab()
    }
    return launch
  }
  try {
    const owner = worktreeId ? structuredLaunchOwner(args.plan, worktreeId, args.target) : null
    if (owner && worktreeId && args.beforeOpen?.() === false) {
      cancelIfNoTab()
      return null
    }
    if (!owner || !worktreeId) {
      // No host to ask: the launch path refuses it with its own message.
      return open(beginLocalProvisionalLaunch(args))
    }
    if (opensAtAction(args)) {
      return beginActionLaunch(args, worktreeId, owner, open)
    }
    const launch = beginHostAdmittedStructuredLaunch({
      plan: args.plan,
      hooks: args.hooks,
      worktreeId,
      executionHostId: owner.executionHostId,
      target: owner.target,
      openAdmitted: (seedOptions) =>
        open(
          beginLocalProvisionalLaunch({
            ...args,
            target: {
              ...args.target,
              worktreeId,
              executionHostId: owner.executionHostId,
              ...(seedOptions ? { seedOptions } : {})
            },
            beforeOpen: undefined
          })
        ),
      onHostDeclined: (target) => openDeclinedTerminal(args, worktreeId, target)
    })
    void launch.settlement.then(cancelIfNoTab, cancelIfNoTab)
    return launch
  } catch (error) {
    cancelIfNoTab()
    throw error
  }
}

function beginLocalProvisionalLaunch(args: ProvisionalLaunchArgs): LocalProvisionalLaunch | null {
  const handle = args.plan.begin({ ...args.hooks, activate: args.activate !== false }, args.target)
  if (!handle) {
    return null
  }
  const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
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

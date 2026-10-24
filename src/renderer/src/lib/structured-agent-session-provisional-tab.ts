import type { NativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
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
import {
  beginHostAdmittedStructuredLaunch,
  type DeclinedStructuredLaunchTerminalOptions,
  type HostAdmittedStructuredLaunch,
  type StructuredLaunchTerminal
} from '@/lib/structured-agent-session-launch-admission'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  openTerminalForDeclinedChat,
  openDeclinedTerminal,
  opensAtAction
} from './structured-agent-session-action-launch'
import { holdEmptyWorkspaceDefaultSurfaceForLaunch } from './empty-workspace-default-surface-claims'
import type { OpenedAgentSessionTab } from './structured-agent-session-tab-open-through-layout-owner'
import {
  captureStructuredLaunchSurfaceAddress,
  openStructuredAgentSessionProvisionalTab
} from './structured-agent-session-launch-surface'
export { openStructuredAgentSessionProvisionalTab } from './structured-agent-session-launch-surface'

type LocalProvisionalLaunch = StructuredAgentLaunchHandle & { tab: OpenedAgentSessionTab }

/** A chat's tab opens once its host admits it; a launch with no host to ask takes the direct path. */
export type StructuredAgentSessionProvisionalLaunch =
  | LocalProvisionalLaunch
  | HostAdmittedStructuredLaunch
  | (StructuredAgentLaunchHandle & { tab: null })

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

/** Only a launch that takes the user to its chat may ask host publication to select it. */
function launchHooks(args: ProvisionalLaunchArgs): StructuredAgentLaunchHooks {
  return args.activate === false ? { ...args.hooks, activate: false } : args.hooks
}

export type ProvisionalLaunchArgs = {
  plan: AgentSessionLaunchPlan
  hooks: StructuredAgentLaunchHooks
  focusIntent?: NativeChatComposerFocusIntent
  target?: AgentSessionLaunchTarget
  targetGroupId?: string
  /** The tab the chat opens right after, in that tab's group. */
  afterTabId?: string
  activate?: boolean
  /** Identity-only resumes publish on commit; unknown outcomes keep their recovery tab. */
  deferPublication?: true
  /** Lets workspace flows reveal before the chat's tab is owned: before its host is asked, when no
   *  session id exists yet. */
  beforeOpen?: (sessionId?: string) => boolean | void
  /** The terminal the host's "no" opens; a caller without one gets a new agent tab's. */
  onHostDeclined?: (
    target: RuntimeClientTarget,
    activate?: false
  ) => Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal
  /** What that default terminal carries from the caller, e.g. a recipe's saved CLI arguments. */
  declinedTerminal?: DeclinedStructuredLaunchTerminalOptions
  /** `onHostDeclined` opens a surface of the caller's own (a shell) rather than the agent's CLI. */
  declinedOpensCallerSurface?: true
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
  const open = (
    launch: ReturnType<typeof beginLocalProvisionalLaunch>
  ): ReturnType<typeof beginLocalProvisionalLaunch> => {
    if (launch?.tab) {
      tabOpened = true
      if (args.activate !== false) {
        focusIntent?.request(launch.tab.id)
      }
    } else if (!launch) {
      cancelIfNoTab()
    }
    return launch
  }
  try {
    const owner = worktreeId ? structuredLaunchOwner(args.plan, worktreeId, args.target) : null
    if (owner && worktreeId && !args.deferPublication && args.beforeOpen?.() === false) {
      cancelIfNoTab()
      return null
    }
    if (!owner || !worktreeId) {
      // No host to ask: the launch path refuses it with its own message.
      return open(beginLocalProvisionalLaunch(args))
    }
    if (opensAtAction(args)) {
      const launch = open(
        beginLocalProvisionalLaunch({
          ...args,
          hooks: { ...args.hooks, activate: false },
          target: { ...args.target, worktreeId, executionHostId: owner.executionHostId },
          beforeOpen: undefined
        })
      )
      if (!launch || launch.tab === null) {
        return launch
      }
      const tab = launch.tab
      return {
        ...launch,
        settlement: launch.settlement.then((settlement) =>
          openTerminalForDeclinedChat(args, worktreeId, owner, tab, settlement)
        )
      }
    }
    if (args.deferPublication && !args.target?.surfaceAddress) {
      args = {
        ...args,
        target: {
          ...args.target,
          surfaceAddress: captureStructuredLaunchSurfaceAddress(worktreeId, args.targetGroupId)
        }
      }
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
      onHostDeclined: (target) => openDeclinedTerminal(args, worktreeId, target),
      ...(args.declinedOpensCallerSurface ? { declinedOpensCallerSurface: true as const } : {})
    })
    void launch.settlement.then(cancelIfNoTab, cancelIfNoTab)
    return launch
  } catch (error) {
    cancelIfNoTab()
    throw error
  }
}

function beginLocalProvisionalLaunch(
  args: ProvisionalLaunchArgs
): LocalProvisionalLaunch | (StructuredAgentLaunchHandle & { tab: null }) | null {
  if (args.deferPublication) {
    return beginDeferredPublication(args)
  }
  const handle = args.plan.begin(launchHooks(args), args.target)
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
      ...(args.afterTabId ? { afterTabId: args.afterTabId } : {}),
      ...(args.activate !== undefined ? { activate: args.activate } : {})
    })
    return { ...handle, tab }
  } catch (error) {
    // Why: a launch without its owning surface would strand a late publication.
    handle.cancel()
    throw error
  }
}

function beginDeferredPublication(
  args: ProvisionalLaunchArgs
): (StructuredAgentLaunchHandle & { tab: null }) | null {
  const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
  if (!worktreeId || !args.plan.resumeFrom || args.plan.prompt) {
    throw new Error('Deferred publication requires an identity-only resume.')
  }
  const releaseHold = holdEmptyWorkspaceDefaultSurfaceForLaunch(worktreeId)
  let handle: StructuredAgentLaunchHandle | null
  try {
    handle = args.plan.begin(launchHooks(args), args.target)
  } catch (error) {
    releaseHold()
    throw error
  }
  if (!handle) {
    releaseHold()
    return null
  }
  return {
    ...handle,
    tab: null,
    settlement: handle.settlement.finally(releaseHold)
  }
}

import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import { nativeChatDraftPositions } from '@/components/native-chat/native-chat-composer-draft-memory'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { afterPendingTab } from '@/runtime/layout-owner-pending-tabs'
import type {
  AgentSessionLaunchPlan,
  AgentSessionLaunchTarget
} from '@/lib/agent-session-launch-plan'
import type {
  StructuredAgentLaunchHandle,
  StructuredAgentLaunchHooks
} from '@/lib/structured-agent-launch-settlement'
import { useAppStore } from '@/store/index'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  beginHostAdmittedStructuredLaunch,
  type HostAdmittedStructuredLaunch
} from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  openTerminalForDeclinedChat,
  openDeclinedTerminal,
  opensAtAction
} from './launch/structured-agent-session-action-launch'
import { holdEmptyWorkspaceDefaultSurfaceForLaunch } from '../empty-workspace-default-surface-claims'
import type { OpenedAgentSessionTab } from '../structured-agent-session-tab-open-through-layout-owner'
import {
  captureStructuredLaunchSurfaceAddress,
  openStructuredAgentSessionProvisionalTab
} from './launch/structured-agent-session-launch-surface'

type LocalProvisionalLaunch = StructuredAgentLaunchHandle & { tab: OpenedAgentSessionTab }

export type StructuredAgentSessionProvisionalLaunch =
  | LocalProvisionalLaunch
  | HostAdmittedStructuredLaunch
  | (StructuredAgentLaunchHandle & { tab: null })

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

export type {
  PreparedProvisionalTab,
  ProvisionalLaunchArgs
} from './structured-agent-session-provisional-types'
import type { ProvisionalLaunchArgs } from './structured-agent-session-provisional-types'

export function beginStructuredAgentSessionProvisionalLaunch(
  args: ProvisionalLaunchArgs
): StructuredAgentSessionProvisionalLaunch | null {
  const focusIntent = args.focusIntent
  if (args.activate === false) {
    focusIntent?.cancel()
  }
  const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
  let tabOpened = false
  const settleWithoutTab = (): void => {
    if (!tabOpened) {
      focusIntent?.cancel()
      args.onTabOpenSettled?.(null)
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
      settleWithoutTab()
    }
    return launch
  }
  try {
    const owner = worktreeId ? structuredLaunchOwner(args.plan, worktreeId, args.target) : null
    if (owner && worktreeId && !args.deferPublication && args.beforeOpen?.() === false) {
      settleWithoutTab()
      return null
    }
    if (!owner || !worktreeId) {
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
      ...(args.declinedOpensCallerSurface ? { declinedOpensCallerSurface: true as const } : {}),
      ...(args.resumeWritersChecked ? { resumeWritersChecked: true as const } : {})
    })
    void launch.settlement.then(settleWithoutTab, settleWithoutTab)
    return launch
  } catch (error) {
    settleWithoutTab()
    throw error
  }
}

function beginLocalProvisionalLaunch(
  args: ProvisionalLaunchArgs
): LocalProvisionalLaunch | (StructuredAgentLaunchHandle & { tab: null }) | null {
  const placement = args.prepareTab?.()
  if (placement === null) {
    return null
  }
  try {
    const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
    if (placement && worktreeId) {
      const address = captureStructuredLaunchSurfaceAddress(worktreeId, placement.targetGroupId)
      args = {
        ...args,
        targetGroupId: placement.targetGroupId,
        afterTabId: undefined,
        index: placement.index,
        target: {
          ...args.target,
          surfaceAddress: {
            ...address,
            precedingTabIds: address.precedingTabIds.slice(
              0,
              placement.index === undefined ? undefined : Math.max(0, placement.index)
            )
          }
        }
      }
    }
    const launch = beginPreparedProvisionalLaunch(args)
    if (placement) {
      if (launch?.tab) {
        afterPendingTab(launch.tab.id, placement.release)
      } else {
        placement.release()
      }
    }
    return launch
  } catch (error) {
    placement?.release()
    throw error
  }
}

function beginPreparedProvisionalLaunch(
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
  const draft = readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(handle.sessionId))
  const position = nativeChatDraftPositions.get(draft)
  const retirePosition = (target = structuredAgentSessionTabId(handle.sessionId)) => {
    if (position?.at === 'end' && position.target === target) {
      position.pending = false
    }
  }
  try {
    if (args.beforeOpen?.(handle.sessionId) === false) {
      retirePosition()
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
      ...(args.index !== undefined ? { index: args.index } : {}),
      ...(args.activate !== undefined ? { activate: args.activate } : {})
    })
    afterPendingTab(tab.id, (shown) => {
      if (!shown || !useAppStore.getState().getTab(shown)) {
        retirePosition(tab.id)
      }
      if (shown === null) {
        handle.cancel()
        args.onTabOpenSettled?.(null, 'layout-refused')
      } else {
        args.onTabOpenSettled?.(shown)
      }
    })
    return { ...handle, tab }
  } catch (error) {
    retirePosition()
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

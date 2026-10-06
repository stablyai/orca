import {
  adoptAgentSessionLaunchVerdict,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import type { AgentLaunchSurface, LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import { launchAgentInStructuredNewTab } from '@/lib/launch-agent-in-new-tab-structured'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import {
  beginStructuredAgentSessionProvisionalLaunch,
  structuredLaunchPairedOwner
} from '@/lib/structured-agent-session-provisional-tab'

type StructuredFromNewTab = {
  surface: AgentLaunchSurface
  pasteDraftAfterLaunch: false
  structuredSettlement: Promise<StructuredAgentLaunchSettlement>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

/**
 * The new-tab launcher's structured route. A local chat opens at once. A paired server admits the
 * chat before any of it exists here, so its surface is the host's, as for every paired launch, and
 * its "no" runs the caller's own launch as a terminal.
 */
export function launchStructuredAgentFromNewTab(args: {
  plan: AgentSessionLaunchPlan
  worktreeId: string
  groupId?: string
  activate?: boolean
  beforeSurfaceOpen?: LaunchAgentInNewTabArgs['beforeSurfaceOpen']
  openTerminal: (terminalPlan: AgentSessionLaunchPlan) => {
    promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  } | null
}): StructuredFromNewTab | null {
  const { plan, beforeSurfaceOpen } = args
  const paired = structuredLaunchPairedOwner(plan, args.worktreeId)
  if (!paired) {
    const structured = launchAgentInStructuredNewTab({
      plan,
      ...(args.activate !== undefined ? { activate: args.activate } : {}),
      ...(beforeSurfaceOpen
        ? {
            beforeOpen: (sessionId?: string) =>
              sessionId === undefined ||
              beforeSurfaceOpen({ kind: 'local-agent-session', sessionId })
          }
        : {}),
      ...(args.groupId ? { targetGroupId: args.groupId } : {})
    })
    return (
      structured && {
        surface: {
          kind: 'local-agent-session',
          tabId: structured.tabId,
          sessionId: structured.sessionId
        },
        pasteDraftAfterLaunch: false,
        structuredSettlement: structured.structuredSettlement,
        ...(structured.promptDeliveryResult
          ? { promptDeliveryResult: structured.promptDeliveryResult }
          : {})
      }
    )
  }
  if (beforeSurfaceOpen?.({ kind: 'host-published' }) === false) {
    return null
  }
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    ...(args.activate !== undefined ? { activate: args.activate } : {}),
    target: { worktreeId: args.worktreeId, executionHostId: paired.executionHostId },
    ...(args.groupId ? { targetGroupId: args.groupId } : {}),
    onHostDeclined: () => {
      const terminal = args.openTerminal(
        adoptAgentSessionLaunchVerdict({
          route: 'terminal-tui',
          requestId: plan.requestId,
          agent: plan.agent,
          worktreeId: args.worktreeId
        })
      )
      return {
        opened: terminal !== null,
        ...(terminal?.promptDeliveryResult
          ? { promptDeliveryResult: terminal.promptDeliveryResult }
          : {})
      }
    }
  })
  return (
    launch && {
      surface: { kind: 'host-published' },
      pasteDraftAfterLaunch: false,
      structuredSettlement: launch.settlement,
      ...(launch.promptDeliveryResult ? { promptDeliveryResult: launch.promptDeliveryResult } : {})
    }
  )
}

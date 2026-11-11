import {
  adoptAgentSessionLaunchVerdict,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { LaunchAgentInNewTabArgs } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-args'
import type {
  AgentLaunchSurface,
  AgentTabLaunchOutcome
} from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-host-agents'
import type { StructuredAgentLaunchSettlement } from '@/lib/agent-session/launch/continuation/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/agent-session/launch/structured-agent-session-launch-callers'
import type { StructuredLaunchTerminal } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { structuredLaunchTerminalFromOutcome } from '@/lib/agent-session/launch/structured-launch-terminal-outcome'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'

type StructuredFromNewTab = {
  surface: AgentLaunchSurface
  pasteDraftAfterLaunch: false
  structuredSettlement: Promise<StructuredAgentLaunchSettlement>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

/** Ask the owning host to admit chat before publication; refusal falls back to the caller’s configured surface or a terminal where the CLI is installed. */
export function launchStructuredAgentFromNewTab(args: {
  plan: AgentSessionLaunchPlan
  worktreeId: string
  groupId?: string
  focusIntent?: NativeChatComposerFocusIntent
  beforeSurfaceOpen?: LaunchAgentInNewTabArgs['beforeSurfaceOpen']
  onHostDeclined?: () => StructuredLaunchTerminal
  openTerminal: (terminalPlan: AgentSessionLaunchPlan, activate?: false) => AgentTabLaunchOutcome
}): StructuredFromNewTab | Extract<AgentTabLaunchOutcome, { refused: unknown }> | null {
  const { plan, beforeSurfaceOpen } = args
  if (beforeSurfaceOpen?.({ kind: 'host-published' }) === false) {
    return null
  }
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    ...(args.focusIntent ? { focusIntent: args.focusIntent } : {}),
    target: { worktreeId: args.worktreeId },
    ...(args.groupId ? { targetGroupId: args.groupId } : {}),
    ...(args.onHostDeclined ? { declinedOpensCallerSurface: true as const } : {}),
    onHostDeclined: (_target, activate) => {
      if (args.onHostDeclined) {
        return args.onHostDeclined()
      }
      return structuredLaunchTerminalFromOutcome(
        args.openTerminal(
          adoptAgentSessionLaunchVerdict({
            route: 'terminal-tui',
            requestId: plan.requestId,
            agent: plan.agent,
            worktreeId: args.worktreeId
          }),
          activate
        )
      )
    }
  })
  return launch
    ? {
        surface: launch.tab
          ? { kind: 'local-chat', tabId: launch.tab.id }
          : { kind: 'host-published' },
        pasteDraftAfterLaunch: false,
        structuredSettlement: launch.settlement,
        ...(launch.promptDeliveryResult
          ? { promptDeliveryResult: launch.promptDeliveryResult }
          : {})
      }
    : { refused: { delivered: false, failureNotified: true } }
}

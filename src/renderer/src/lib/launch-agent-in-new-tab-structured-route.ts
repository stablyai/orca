import {
  adoptAgentSessionLaunchVerdict,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import type { AgentLaunchSurface, LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredLaunchTerminal } from '@/lib/structured-agent-session-launch-admission'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'

type StructuredFromNewTab = {
  surface: AgentLaunchSurface
  pasteDraftAfterLaunch: false
  structuredSettlement: Promise<StructuredAgentLaunchSettlement>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

/**
 * The new-tab launcher's structured route. The owning host, this machine or a paired server,
 * admits the chat before any of it exists here, so its surface is the host's, and its "no" runs
 * the caller's own launch as a terminal unless the caller names what opens instead.
 */
export function launchStructuredAgentFromNewTab(args: {
  plan: AgentSessionLaunchPlan
  worktreeId: string
  groupId?: string
  focusIntent?: NativeChatComposerFocusIntent
  beforeSurfaceOpen?: LaunchAgentInNewTabArgs['beforeSurfaceOpen']
  onHostDeclined?: () => StructuredLaunchTerminal
  openTerminal: (
    terminalPlan: AgentSessionLaunchPlan,
    activate?: false
  ) => {
    surface: AgentLaunchSurface
    terminalCompletion?: StructuredLaunchTerminal['completion']
    promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  } | null
}): StructuredFromNewTab | null {
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
    onHostDeclined: (_target, activate) => {
      if (args.onHostDeclined) {
        return args.onHostDeclined()
      }
      const terminal = args.openTerminal(
        adoptAgentSessionLaunchVerdict({
          route: 'terminal-tui',
          requestId: plan.requestId,
          agent: plan.agent,
          worktreeId: args.worktreeId
        }),
        activate
      )
      return {
        opened: terminal !== null,
        ...(terminal?.surface.kind === 'local-terminal' ? { tabId: terminal.surface.tabId } : {}),
        ...(terminal?.terminalCompletion ? { completion: terminal.terminalCompletion } : {}),
        ...(terminal?.promptDeliveryResult
          ? { promptDeliveryResult: terminal.promptDeliveryResult }
          : {})
      }
    }
  })
  return (
    launch && {
      surface: launch.tab
        ? { kind: 'local-chat', tabId: launch.tab.id }
        : { kind: 'host-published' },
      pasteDraftAfterLaunch: false,
      structuredSettlement: launch.settlement,
      ...(launch.promptDeliveryResult ? { promptDeliveryResult: launch.promptDeliveryResult } : {})
    }
  )
}

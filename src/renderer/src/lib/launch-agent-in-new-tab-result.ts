import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'

/** `host-published`: the surface opens once its host answers, a structured chat's included. */
export type AgentLaunchSurface =
  | { kind: 'local-terminal'; tabId: string }
  | { kind: 'host-published' }

export type LaunchAgentInNewTabResult = {
  surface: AgentLaunchSurface
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
  /** Structured route only: what the launch did once it settled. The call stays synchronous. */
  structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
} | null

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.surface.kind === 'host-published'
}

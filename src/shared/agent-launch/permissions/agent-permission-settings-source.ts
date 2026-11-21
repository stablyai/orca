import { formatAgentTypeLabel } from '../../agent-status/presentation/agent-type-label'
import { isAgentChatPermissionMode } from './agent-chat-permission-mode'

/** The product whose own settings an Own permission choice follows, named as that product names itself. */
export function agentPermissionSettingsSourceName(agent: string | null | undefined): string {
  return agent === 'claude' ? 'Claude Code' : formatAgentTypeLabel(agent)
}

/** What an Own pill's hint can truthfully add when it names no mode: that one is coming, that
 *  the agent reported one Orca can't name, or just whose settings apply. Null once a mode is named. */
export type AgentPermissionSettingsHint = 'report-pending' | 'unnamed-report' | 'settings'

export function agentPermissionSettingsHint(input: {
  current: string | undefined
  reported: string | undefined
  /** The next message can produce a report; absent where the surface can't tell. */
  reportPending?: boolean
  /** A pick waits for the next message, so the pill names that pick instead. */
  deferred: boolean
}): AgentPermissionSettingsHint | null {
  const { current, reported } = input
  if (
    current !== 'own' ||
    input.deferred ||
    isAgentChatPermissionMode(reported) ||
    reported === 'plan'
  ) {
    return null
  }
  return reported !== undefined
    ? 'unnamed-report'
    : input.reportPending
      ? 'report-pending'
      : 'settings'
}

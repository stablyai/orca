import { formatAgentTypeLabel } from '../../agent-status/presentation/agent-type-label'
import { isAgentChatPermissionMode } from './agent-chat-permission-mode'

/** The product whose own settings an Own permission choice follows, named as that product names itself. */
export function agentPermissionSettingsSourceName(agent: string | null | undefined): string {
  return agent === 'claude' ? 'Claude Code' : formatAgentTypeLabel(agent)
}

/** What an Own pill's hint can truthfully add when it names no mode: that the agent reported one
 *  Orca can't name, or just whose settings apply. Null once a mode is named. A missing report never
 *  promises one is coming: neither the host nor the agent version guarantees a nameable report. */
export type AgentPermissionSettingsHint = 'unnamed-report' | 'settings'

export function agentPermissionSettingsHint(input: {
  current: string | undefined
  reported: string | undefined
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
  return reported !== undefined ? 'unnamed-report' : 'settings'
}

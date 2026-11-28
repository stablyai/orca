// The note in a chat still running a turn when its agent's saved account was switched: the turn
// finishes on the account it started on, and the next message starts on the selected one.

import type { NativeChatTextBlock } from '../../native-chat-types'

export const AGENT_ACCOUNT_SWITCH_FRAME_KIND = 'notice:account-switch'
export const AGENT_ACCOUNT_SWITCH_COPY =
  'Finishing this turn on {{from}}. Your next message uses {{to}}.'
const MAX_ACCOUNT_LABEL_CHARS = 320

export type AgentAccountSwitchNotice = { from: string; to: string }

function label(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= MAX_ACCOUNT_LABEL_CHARS ? text : null
}

export function readAgentAccountSwitchFrame(
  frame: NativeChatTextBlock['providerFrame']
): AgentAccountSwitchNotice | null {
  if (frame?.provider !== 'orca' || frame.kind !== AGENT_ACCOUNT_SWITCH_FRAME_KIND) {
    return null
  }
  if (frame.payload.truncated) {
    return null
  }
  try {
    const value: unknown = JSON.parse(frame.payload.head)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const from = label('from' in value ? value.from : null)
    const to = label('to' in value ? value.to : null)
    return from && to ? { from, to } : null
  } catch {
    return null
  }
}

/** The sentence clients that predate the notice print. */
export function agentAccountSwitchText(notice: AgentAccountSwitchNotice): string {
  return AGENT_ACCOUNT_SWITCH_COPY.replace('{{from}}', () => notice.from).replace(
    '{{to}}',
    () => notice.to
  )
}

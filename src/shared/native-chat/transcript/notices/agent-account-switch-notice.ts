// The notes about a chat's saved account, where an agent's saved accounts share one login: a chat
// still running a turn when the account was switched finishes that turn on the account it started
// on, and the next message starts on the selected one; a chat that couldn't start on the selected
// account says why.

import type { NativeChatTextBlock } from '../../native-chat-types'

export const AGENT_ACCOUNT_SWITCH_FRAME_KIND = 'notice:account-switch'
export const AGENT_ACCOUNT_SWITCH_COPY =
  'Finishing this turn on {{from}}. Your next message uses {{to}}.'
export const AGENT_ACCOUNT_NOT_MOVED_COPY = "Couldn't move this chat to {{to}}: {{reason}}"
const MAX_ACCOUNT_LABEL_CHARS = 320
const MAX_REASON_CHARS = 1_000

export type AgentAccountSwitchNotice = { from: string; to: string } | { to: string; reason: string }

function label(value: unknown, max = MAX_ACCOUNT_LABEL_CHARS): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= max ? text : null
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
    const to = label('to' in value ? value.to : null)
    const reason = label('reason' in value ? value.reason : null, MAX_REASON_CHARS)
    if (to && reason) {
      return { to, reason }
    }
    const from = label('from' in value ? value.from : null)
    return from && to ? { from, to } : null
  } catch {
    return null
  }
}

/** The sentence clients that predate the notice print. */
export function agentAccountSwitchText(notice: AgentAccountSwitchNotice): string {
  return 'reason' in notice
    ? AGENT_ACCOUNT_NOT_MOVED_COPY.replace('{{to}}', () => notice.to).replace(
        '{{reason}}',
        () => notice.reason
      )
    : AGENT_ACCOUNT_SWITCH_COPY.replace('{{from}}', () => notice.from).replace(
        '{{to}}',
        () => notice.to
      )
}

import { translate } from '@/i18n/i18n'
import type { AgentSessionRewindReason } from '../../../../shared/agent-session-rewind'

const reasonCopy = {
  unsupported: () =>
    translate(
      'components.native-chat.rewind.unsupported',
      'This session does not support rewinding conversation history.'
    ),
  'history-not-paginated': () =>
    translate(
      'components.native-chat.rewind.historyNotPaginated',
      'This older Codex conversation does not support rewinding. Start a new conversation to use rewind.'
    ),
  busy: () =>
    translate(
      'components.native-chat.rewind.busy',
      'Wait for the current turn, pending messages, approvals, and background work to finish before rewinding.'
    ),
  'stale-epoch': () =>
    translate(
      'components.native-chat.rewind.staleEpoch',
      'The conversation changed. Review the latest messages before rewinding.'
    ),
  'invalid-target': () =>
    translate(
      'components.native-chat.rewind.invalidTarget',
      'This message is no longer a valid rewind point. Review the latest conversation.'
    ),
  'history-limit': () =>
    translate(
      'components.native-chat.rewind.historyLimit',
      'This conversation is too large to rewind safely. Nothing was changed.'
    ),
  'provider-refused': () =>
    translate(
      'components.native-chat.rewind.providerRefused',
      'The agent refused to rewind this conversation.'
    ),
  'proof-mismatch': () =>
    translate(
      'components.native-chat.rewind.proofMismatch',
      'Orca could not verify the conversation boundary. Reload the session before trying again.'
    ),
  'outcome-unknown': () =>
    translate(
      'components.native-chat.rewind.outcomeUnknown',
      'The rewind may have completed, but Orca could not confirm it. Sending is blocked until the outcome is resolved.'
    )
} satisfies Record<AgentSessionRewindReason, () => string>

export function nativeChatRewindReasonCopy(reason: string | undefined): string {
  return reason && Object.hasOwn(reasonCopy, reason)
    ? reasonCopy[reason as keyof typeof reasonCopy]()
    : translate(
        'components.native-chat.rewind.refused',
        'Orca could not rewind this conversation. Reload the session to check its current state.'
      )
}

export function nativeChatRewindUnavailableCopy(): string {
  return translate(
    'components.native-chat.rewind.unavailable',
    'Reconnect to a writable chat session before rewinding.'
  )
}

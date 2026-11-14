import { translate } from '@/i18n/i18n'
import {
  agentSessionRewindReasonNotice,
  type AgentSessionRewindNotice
} from '../../../../../../shared/agent-session/lifecycle/agent-session-rewind-request'

const copy = {
  unsupported: () =>
    translate(
      'components.native-chat.rewind.unsupported',
      "This chat can't go back to an earlier message."
    ),
  'history-not-paginated': () =>
    translate(
      'components.native-chat.rewind.historyNotPaginated',
      "This older Codex chat can't go back to an earlier message. Start a new chat to use Rewind to here."
    ),
  busy: () =>
    translate(
      'components.native-chat.rewind.busy',
      'Available once the agent is idle and nothing in this chat is waiting on you.'
    ),
  'stale-epoch': () =>
    translate(
      'components.native-chat.rewind.staleEpoch',
      'The conversation changed. Review the latest messages and try again.'
    ),
  'invalid-target': () =>
    translate(
      'components.native-chat.rewind.invalidTarget',
      "The conversation can't go back to this message. Nothing was changed."
    ),
  'history-limit': () =>
    translate(
      'components.native-chat.rewind.historyLimit',
      'This conversation is too long to go back in. Nothing was changed.'
    ),
  'provider-refused': () =>
    translate(
      'components.native-chat.rewind.providerRefused',
      "The agent couldn't go back to this message."
    ),
  'proof-mismatch': () =>
    translate(
      'components.native-chat.rewind.proofMismatch',
      "The agent's history didn't match this chat. Check the conversation before continuing."
    ),
  'outcome-unknown': () =>
    translate(
      'components.native-chat.rewind.outcomeUnknown',
      "Orca couldn't confirm whether the conversation went back to an earlier message. It checks before your next message is sent."
    ),
  refused: () =>
    translate(
      'components.native-chat.rewind.refused',
      "Orca couldn't go back to this message. Check the conversation before continuing."
    ),
  unavailable: () =>
    translate(
      'components.native-chat.rewind.unavailable',
      'Wait for the chat to finish connecting.'
    ),
  'returned-unknown': () =>
    translate(
      'components.native-chat.rewind.outcomeUnknownReturned',
      "Orca couldn't confirm whether the conversation went back to this message. Your message is back in the composer, and Orca checks the conversation before your next message is sent."
    ),
  timeout: () =>
    translate(
      'components.native-chat.rewind.timeout',
      "The chat didn't update after going back to this message. Reopen it to see the latest."
    ),
  pending: () =>
    translate(
      'components.native-chat.rewind.pending',
      'Wait for the conversation to go back to the earlier message.'
    )
} satisfies Record<AgentSessionRewindNotice, () => string>

export function sayNativeChatRewind(notice: AgentSessionRewindNotice): string {
  return copy[notice]()
}

export function nativeChatRewindReasonCopy(reason: string | undefined): string {
  return copy[agentSessionRewindReasonNotice(reason)]()
}

import { translate } from '@/i18n/i18n'
import {
  agentMessageSendersShown,
  type AgentMessageSender,
  type AgentMessageSource
} from '../../../../shared/agent-session-message-source'

function unnamedSenderLabel(): string {
  return translate('components.native-chat.agentMessage.unnamedSender', 'an agent')
}

export function agentMessageSenderLabel(sender: AgentMessageSender): string {
  return sender.name ?? unnamedSenderLabel()
}

/** A queued card's plain "From <names>" line; the card's own controls own its clicks. */
export function queuedCardSenderLine(from: AgentMessageSource): string {
  const { shown, more } = agentMessageSendersShown(from)
  // One name per sender, repeats included: two senders that share a name are still two.
  const listed =
    shown.length > 0 ? shown.map(agentMessageSenderLabel).join(', ') : unnamedSenderLabel()
  return translate('components.native-chat.queuedMessages.from', 'From {{names}}', {
    names: more > 0 ? `${listed} +${more}` : listed
  })
}

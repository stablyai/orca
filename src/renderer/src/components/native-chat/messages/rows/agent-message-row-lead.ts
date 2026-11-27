import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  agentMessageHeadingNamesRecipient,
  type AgentMessageHeading
} from '../../../../../../shared/agent-session/view/messages/agent-message-presentation'

/** A recipient's name where it stands alone, as a hover title: German says "an Eule", so the
 *  name never reads as what was handed over. */
export function agentMessageRowRecipientName(name: string, t: Translate = translate): string {
  return t('components.native-chat.agentMessage.recipientName', '{{name}}', { name })
}

/** Stands in for a missing name: a follow-up or a hand-off names who received it, so it takes the
 *  recipient form; every other heading keeps the sender-form fallback it always used. */
export function agentMessageRowFallback(
  heading: AgentMessageHeading,
  t: Translate = translate
): string {
  return agentMessageHeadingNamesRecipient(heading)
    ? t('components.native-chat.agentMessage.unnamedRecipient', 'an agent')
    : t('components.native-chat.agentMessage.unnamedSender', 'an agent')
}

/** The words an agent message's row starts with ("Started", "Update from"). */
export function agentMessageRowLead(
  heading: AgentMessageHeading,
  t: Translate = translate,
  standalone = false
): string {
  switch (heading) {
    case 'started':
    case 'started-agent':
      return standaloneWords(
        t('components.native-chat.agentMessage.row.started', 'Started'),
        standalone
      )
    case 'reopened-worker':
      return standaloneWords(
        t('components.native-chat.agentMessage.row.reopened', 'Reopened'),
        standalone
      )
    case 'followed-up-worker':
      return standalone
        ? t('components.native-chat.agentMessage.event.followedUp', 'Sent follow-up')
        : t('components.native-chat.agentMessage.row.followedUp', 'Sent follow-up to')
    case 'handed-off':
      return standalone
        ? t('components.native-chat.agentMessage.event.handedOff', 'Handed off')
        : t('components.native-chat.agentMessage.row.handedOff', 'Handed off to')
    case 'task':
      return standalone
        ? t('components.native-chat.agentMessage.kind.task', 'Task')
        : t('components.native-chat.agentMessage.row.task', 'Task from')
    case 'worker':
      return standalone
        ? t('components.native-chat.agentMessage.event.update', 'Update')
        : t('components.native-chat.agentMessage.row.update', 'Update from')
    case 'coordinator':
    case 'generic':
      return standalone
        ? t('components.native-chat.agentMessage.event.message', 'Message')
        : t('components.native-chat.agentMessage.row.message', 'Message from')
  }
}

/** A start or reopen lead reads whole on its own; one that joins a name with a colon ("再開:")
 *  drops it when no name follows. */
function standaloneWords(words: string, standalone: boolean): string {
  return standalone ? words.replace(/\s*[:：]\s*$/u, '') : words
}

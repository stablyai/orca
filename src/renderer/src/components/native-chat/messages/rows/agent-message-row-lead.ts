import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import { agentMessageHeading } from '../../../../../../shared/agent-session/view/messages/agent-message-presentation'

/** The words an agent message's row starts with ("Started", "Update from"). */
export function agentMessageRowLead(
  from: AgentMessageSource,
  message: NativeChatMessage,
  t: Translate = translate
): string {
  switch (agentMessageHeading(from, message)) {
    case 'started':
    case 'started-agent':
      return t('components.native-chat.agentMessage.row.started', 'Started')
    case 'reopened-worker':
      return t('components.native-chat.agentMessage.row.reopened', 'Reopened')
    case 'followed-up-worker':
      return t('components.native-chat.agentMessage.row.followedUp', 'Sent follow-up to')
    case 'handed-off':
      return t('components.native-chat.agentMessage.row.handedOff', 'Handed off to')
    case 'task':
      return t('components.native-chat.agentMessage.row.task', 'Task from')
    case 'worker':
      return t('components.native-chat.agentMessage.row.update', 'Update from')
    case 'coordinator':
    case 'generic':
      return t('components.native-chat.agentMessage.row.message', 'Message from')
  }
}

import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { CliConversationRowAgent } from '../../../shared/structured-agent-cli-conversation-adoption'

export function cliConversationExitGuidance(
  agent: CliConversationRowAgent,
  fromTerminal = false
): string {
  const values = { agent: agentLabel(agent) }
  return fromTerminal
    ? translate(
        'components.native-chat.resumeInNewChat.exitUnconfirmedFromTerminal',
        '{{agent}} is still running this conversation in this terminal. Quit {{agent}} here, then open this conversation from Session History.',
        values
      )
    : translate(
        'components.native-chat.resumeInNewChat.exitUnconfirmed',
        '{{agent}} is running this conversation in another terminal. Quit it there or close that terminal, then try again.',
        values
      )
}

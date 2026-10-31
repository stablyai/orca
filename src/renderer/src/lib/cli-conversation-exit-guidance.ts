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
        'Orca could not confirm {{agent}} stopped in this terminal. Quit {{agent}} here, then try this action again.',
        values
      )
    : translate(
        'components.native-chat.resumeInNewChat.exitUnconfirmed',
        'Orca could not confirm {{agent}} stopped. Quit {{agent}} in its terminal, then try this action again.',
        values
      )
}

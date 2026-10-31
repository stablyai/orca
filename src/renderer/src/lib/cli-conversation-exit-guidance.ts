import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { CliConversationRowAgent } from '../../../shared/structured-agent-cli-conversation-adoption'

export function cliConversationExitGuidance(
  agent: CliConversationRowAgent,
  fromTerminal = false,
  agentExited = false
): string {
  const values = { agent: agentLabel(agent) }
  if (agentExited) {
    return translate(
      'components.native-chat.resumeInNewChat.otherProgramsAfterExit',
      '{{agent}} has exited. Stop any other programs in this terminal or any other terminal running this conversation, then try again.',
      values
    )
  }
  return fromTerminal
    ? translate(
        'components.native-chat.resumeInNewChat.exitUnconfirmedFromTerminal',
        '{{agent}} is still running this conversation in this terminal. Quit {{agent}} here, then try again.',
        values
      )
    : translate(
        'components.native-chat.resumeInNewChat.exitUnconfirmed',
        '{{agent}} is running this conversation in another terminal. Quit it there, then try again.',
        values
      )
}

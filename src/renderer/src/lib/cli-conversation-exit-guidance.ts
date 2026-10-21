import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { CliConversationRowAgent } from '../../../shared/structured-agent-cli-conversation-adoption'

/** The header action disappears once the agent exits, so that surface points to Session History. */
export function cliConversationExitGuidance(
  agent: CliConversationRowAgent,
  fromTerminal = false
): string {
  const values = { agent: agentLabel(agent) }
  return fromTerminal
    ? translate(
        'components.native-chat.resumeInNewChat.exitUnconfirmedFromTerminal',
        "Orca can't confirm {{agent}} has exited in its terminal. Stop what's running there or close the terminal, then open this conversation from Session History.",
        values
      )
    : translate(
        'components.native-chat.resumeInNewChat.exitUnconfirmed',
        "Orca can't confirm {{agent}} has exited in its terminal. Stop what's running there or close the terminal, then try again.",
        values
      )
}

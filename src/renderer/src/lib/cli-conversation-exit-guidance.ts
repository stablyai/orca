import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { CliConversationRowAgent } from '../../../shared/structured-agent-cli-conversation-adoption'

export function cliConversationExitGuidance(agent: CliConversationRowAgent): string {
  return translate(
    'components.native-chat.resumeInNewChat.exitFirst',
    'Exit {{agent}} in the terminal, then open this conversation from Session History.',
    { agent: agentLabel(agent) }
  )
}

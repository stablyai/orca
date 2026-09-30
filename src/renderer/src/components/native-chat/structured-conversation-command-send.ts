import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'

export async function sendStructuredConversationCommand(input: {
  command: AgentSessionConversationCommand
  pending: { current: boolean }
  blocked: boolean
  send: (
    command: AgentSessionConversationCommand
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): Promise<{ accepted: boolean; error: string | null }> {
  if (input.pending.current || input.blocked) {
    return {
      accepted: false,
      error: translate(
        'components.native-chat.conversationCommand.pendingWork',
        'Wait for pending work and messages to finish before using this command.'
      )
    }
  }
  input.pending.current = true
  try {
    const outcome = await input.send(input.command)
    if (outcome.kind === 'not-done') {
      return { accepted: false, error: outcome.notice }
    }
    const result = outcome.kind === 'done' ? outcome.value : null
    return {
      accepted: result?.state === 'completed' && !result.error,
      error:
        result?.error ??
        (result
          ? null
          : translate(
              'components.native-chat.conversationCommand.unconfirmed',
              'Conversation operation was not confirmed.'
            ))
    }
  } finally {
    input.pending.current = false
  }
}

export function isUnconfirmedConversationCommand(method: string, value: unknown): boolean {
  return (
    method === 'agentSession.conversationCommand' &&
    (value as AgentSessionConversationCommandResult).state === 'unknown'
  )
}

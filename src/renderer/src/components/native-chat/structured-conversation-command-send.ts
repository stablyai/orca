import {
  isAgentSessionConversationCommand,
  type AgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../shared/agent-session-failure-words'
import { translate } from '@/i18n/i18n'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { agentSessionFailureStatedByStartRow } from './structured-agent-session-delivery-notices'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'

export async function sendStructuredConversationCommand(input: {
  command: AgentSessionConversationCommand
  /** The chat's agent, as a failed command names it. */
  agentName: string
  pending: { current: boolean }
  blocked: boolean
  /** What the chat's loaded start-failure rows state, read when the reply lands. */
  startFailures: () => readonly AgentSessionFailureFact[]
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
    // The pane stopped waiting on this reply (closed, left the chat, or sent a newer command).
    if (outcome.kind === 'dropped') {
      return { accepted: false, error: null }
    }
    const { value } = outcome
    // The chat's own start failed and its loaded row already says why, as for a message that start
    // rejected. A /clear's failed start is its new chat's, whose row this pane never shows, and a
    // command this build doesn't know may be either, so its host's words are shown.
    if (
      isAgentSessionConversationCommand(value.command) &&
      value.command !== 'clear' &&
      agentSessionFailureStatedByStartRow(value.failure, input.startFailures())
    ) {
      return { accepted: false, error: null }
    }
    const error = conversationCommandFailureText(value, input.agentName)
    return { accepted: value.state === 'completed' && !error, error }
  } finally {
    input.pending.current = false
  }
}

/** The host's sentence in the reader's language, from the fact beside it; with no fact (an older
 *  host), one this build can't read whole, or a command it doesn't know, the sentence as written. */
function conversationCommandFailureText(
  result: AgentSessionConversationCommandResult,
  agentName: string
): string | null {
  const fact = isAgentSessionConversationCommand(result.command)
    ? readWholeAgentSessionFailureFact(result.failure)
    : undefined
  if (!fact) {
    return result.error ?? null
  }
  // As the host words it: naming the chat's agent and the command a failed start was for.
  return agentSessionFailureSentence(
    fact,
    'row',
    { agentName, command: result.command },
    sayAgentSessionFailureTranslated
  )
}

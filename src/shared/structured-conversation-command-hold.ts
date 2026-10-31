import {
  isAgentSessionConversationCommand,
  type AgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from './agent-session/agent-session-conversation-command'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from './agent-session-failure'
import {
  sayAgentSessionFailureEnglish,
  type AgentSessionFailureSay
} from './agent-session-failure-copy'
import { agentSessionFailureSentence } from './agent-session-failure-words'
import { agentSessionFailureStatedByRow } from './agent-session-visible-failures'
import type { AgentSessionWriteNoticeSentence } from './agent-session-write-notice-copy'
import { structuredAgentSessionCommandHostRefusalCause } from './structured-agent-session-command-refusal-cause'
import type { StructuredAgentSessionCommandRefusalCause } from './structured-agent-session-composer'

/** Ahead leaves command text untouched behind an unanswered local send; other holds return an explicit refusal. */
export type StructuredConversationCommandHold =
  | 'ahead'
  | 'working'
  | 'prompt'
  | 'background'
  | 'sending'

/** Queued commands wait only for earlier unaccepted sends; ordinary commands wait for all in-flight agent work. */
export function structuredConversationCommandHold(input: {
  /** A /compact the host can hold as a card behind the turn or prompt. */
  waitsInLine: boolean
  /** A turn runs, or the chat shows the agent working on a message it has not answered. */
  agentWorking: boolean
  promptPending: boolean
  backgroundTasksRunning: boolean
  sendPending: boolean
}): StructuredConversationCommandHold | null {
  if (input.backgroundTasksRunning) {
    return 'background'
  }
  if (input.waitsInLine) {
    return input.sendPending ? 'ahead' : null
  }
  if (input.promptPending) {
    return 'prompt'
  }
  if (input.agentWorking) {
    return 'working'
  }
  if (input.sendPending) {
    return 'sending'
  }
  return null
}

/** The sentences a held command shows. */
export function heldConversationCommandParts(
  command: AgentSessionConversationCommand,
  hold: Exclude<StructuredConversationCommandHold, 'ahead'>
): AgentSessionWriteNoticeSentence[] {
  const clear = command === 'clear'
  switch (hold) {
    case 'prompt':
      return [clear ? 'clearAfterAnswer' : 'compactAfterAnswer']
    case 'working':
      return ['agentStillWorking', clear ? 'runClearWhenDone' : 'runCompactWhenDone']
    case 'sending':
      return [clear ? 'clearAfterSending' : 'compactAfterSending']
    case 'background':
      return ['pendingWork']
  }
}

/** Translate complete known facts/commands; preserve host text for older/newer payloads this client cannot interpret. */
function conversationCommandFailureText(
  result: AgentSessionConversationCommandResult,
  agentName: string | undefined,
  say: AgentSessionFailureSay
): string | null {
  const fact = isAgentSessionConversationCommand(result.command)
    ? readWholeAgentSessionFailureFact(result.failure)
    : undefined
  if (!fact) {
    return result.error ?? null
  }
  return agentSessionFailureSentence(fact, 'row', { agentName, command: result.command }, say)
}

/** What a command's reply shows: nothing for a start failure a row already states; otherwise its failure in words that name the agent, and the cause a host refusal names. */
export function conversationCommandReply(
  value: AgentSessionConversationCommandResult,
  input: {
    agentName?: string
    /** What the chat's loaded start-failure rows state when the reply lands. */
    startFailures: readonly AgentSessionFailureFact[]
    say?: AgentSessionFailureSay
  }
): { accepted: boolean; error: string | null; cause?: StructuredAgentSessionCommandRefusalCause } {
  // Clear/new-command failures may belong elsewhere and need host wording.
  if (
    isAgentSessionConversationCommand(value.command) &&
    value.command !== 'clear' &&
    agentSessionFailureStatedByRow(value.failure, input.startFailures)
  ) {
    return { accepted: false, error: null }
  }
  const error = conversationCommandFailureText(
    value,
    input.agentName,
    input.say ?? sayAgentSessionFailureEnglish
  )
  if (value.state === 'completed' && !error) {
    return { accepted: true, error: null }
  }
  const cause = structuredAgentSessionCommandHostRefusalCause(value)
  return { accepted: false, error, ...(cause ? { cause } : {}) }
}

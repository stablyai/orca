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
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import {
  agentSessionWriteNoticeText,
  agentSessionWriteFailureText,
  sayAgentSessionWriteNoticeTranslated
} from './agent-session-write-notice-text'
import { agentSessionFailureStatedByStartRow } from '../../../../shared/structured-agent-session-start-failure-facts'
import { structuredAgentSessionStartFailureFacts } from './structured-agent-session-delivery-notices'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'
import type { StructuredPromptItem } from './structured-agent-session-message-projection'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import { structuredAgentSessionCommandHostRefusalCause } from '../../../../shared/structured-agent-session-command-refusal-cause'
import type {
  StructuredAgentSessionCommandOutcome,
  StructuredAgentSessionCommandRefusalCause
} from '../../../../shared/structured-agent-session-composer'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'

/** Why this client does not send the command yet. `ahead`: a message this window sent is not
 *  the host's yet; the command is not taken, and its text stays in the composer while Send is
 *  busy, as for any send on its way. The rest are refused here, in words. */
export type StructuredConversationCommandHold =
  | 'ahead'
  | 'working'
  | 'prompt'
  | 'background'
  | 'sending'

/** A command that waits in line is held only by a message the host doesn't have yet, which must
 *  stay ahead of it; any other command, by anything the agent still has in flight. */
export function structuredConversationCommandHold(input: {
  /** A /compact the host can hold as a card behind the turn or prompt. */
  waitsInLine: boolean
  /** A turn runs, or the chat shows the agent working on a message it has not answered. */
  agentWorking: boolean
  promptPending: boolean
  backgroundTasksRunning: boolean
  /** This chat's one message request has not settled yet. */
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
  // The agent is idle and this window's own message hasn't reached the host: that is the wait.
  if (input.sendPending) {
    return 'sending'
  }
  return null
}

type CommandOutcome = Omit<StructuredAgentSessionCommandOutcome, 'handled'>

/** Which of what a refused command waits on the chat shows right now. */
export type StructuredConversationCommandCauses = Readonly<
  Record<StructuredAgentSessionCommandRefusalCause, boolean>
>

/** The line a command refused here gets: what the person sees and can do, as the host says it. */
function heldCommandText(
  command: AgentSessionConversationCommand,
  hold: Exclude<StructuredConversationCommandHold, 'ahead'>,
  agentName: string
): string {
  if (hold === 'sending' || hold === 'background') {
    return sayAgentSessionFailureTranslated(
      hold === 'sending' ? 'commandAfterSending' : 'commandWaitForPendingWork',
      { agent: agentName, command }
    )
  }
  return agentSessionWriteNoticeText([
    {
      failure: {
        kind: 'commandRefused',
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: hold === 'prompt' ? 'promptPending' : 'turnActive' }
        }
      },
      surface: 'row',
      context: { agentName, command }
    }
  ])
}

export async function sendStructuredConversationCommand(input: {
  command: AgentSessionConversationCommand
  /** The chat's agent, as a failed command names it. */
  agentName: string
  pending: { current: boolean }
  hold: StructuredConversationCommandHold | null
  /** What the chat showed at the press. A refusal names its cause only when the chat showed it,
   *  so a host ahead of the chat can't make the line go the moment it lands; else it is said as
   *  any other failure. */
  causes: StructuredConversationCommandCauses
  /** What the chat's loaded start-failure rows state, read when the reply lands. */
  startFailures: () => readonly AgentSessionFailureFact[]
  send: (
    command: AgentSessionConversationCommand
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): Promise<CommandOutcome> {
  const refused = (
    error: string | null,
    cause: StructuredAgentSessionCommandRefusalCause | undefined
  ): CommandOutcome => ({
    accepted: false,
    error,
    ...(error && cause && input.causes[cause] ? { refusedWhile: cause } : {})
  })
  // A command on its way is the agent's work in flight.
  if (input.pending.current) {
    return { accepted: false, error: heldCommandText(input.command, 'working', input.agentName) }
  }
  // The message ahead reads as sending, and Send is busy until the host has it; nothing is armed.
  if (input.hold === 'ahead') {
    return { accepted: false, error: null }
  }
  if (input.hold !== null) {
    // Each hold here is named for the cause it waits on.
    return refused(heldCommandText(input.command, input.hold, input.agentName), input.hold)
  }
  input.pending.current = true
  try {
    const outcome = await input.send(input.command)
    if (outcome.kind === 'not-done') {
      return {
        accepted: false,
        error: agentSessionWriteFailureText(outcome.failure, input.command, {
          agentName: input.agentName
        })
      }
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
    if (value.state === 'completed' && !error) {
      return { accepted: true, error: null }
    }
    return refused(error, structuredAgentSessionCommandHostRefusalCause(value))
  } finally {
    input.pending.current = false
  }
}

/** The composer's /clear or /compact, with what this pane knows about work in flight; and which
 *  of what a refusal waits on the chat shows, which its line stands on. */
export function structuredConversationCommandRunner(args: {
  agentName: string
  pending: { current: boolean }
  /** The host holds a /compact as a card, and this client renders the queue. */
  commandsWait: boolean
  /** What the chat shows: a turn, the Working rule, its background work, its sends. */
  chat: {
    turnId: string | null
    isWorking: boolean
    /** The queue's send is the host's next update: the pane reads working. */
    queueSendsNext: boolean
    backgroundTasks: { isMonitoring: boolean; show: boolean }
    submissions: readonly AgentJournalSubmission[]
  }
  /** The chat's pending prompts: a card would wait forever on ones this build cannot answer. */
  prompts: readonly StructuredPromptItem[]
  /** A rewind this pane started is on its way; read at the press. */
  rewindInFlight: { readonly current: boolean }
  sends: readonly StructuredAgentSessionPendingSend[]
  /** The loaded rows, read when the reply lands, for the start failures they state. */
  items: () => readonly AgentJournalRenderItem[]
  send: (
    command: AgentSessionConversationCommand,
    delivery?: 'queue-if-active'
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): {
  runConversationCommand: (command: AgentSessionConversationCommand) => Promise<CommandOutcome>
  /** What a refusal's line stands on, as the chat shows it now. */
  commandRefusalCauses: StructuredConversationCommandCauses
} {
  const promptPending = args.prompts.length > 0
  const agentWorking = args.chat.turnId !== null || args.chat.isWorking || args.chat.queueSendsNext
  const sendPending = args.sends.some((entry) => entry.phase === 'sending')
  const causes: StructuredConversationCommandCauses = {
    working: agentWorking,
    prompt: promptPending,
    // The strip, mid-turn included: what a host refusing on background tasks points at.
    background: args.chat.backgroundTasks.show || args.chat.backgroundTasks.isMonitoring,
    sending: sendPending,
    retry: false
  }
  const run = (command: AgentSessionConversationCommand) => {
    const waitsInLine =
      command === 'compact' &&
      args.commandsWait &&
      !(promptPending && pendingPromptsAllUnanswerableHere(args.prompts))
    return sendStructuredConversationCommand({
      command,
      agentName: args.agentName,
      pending: args.pending,
      hold: structuredConversationCommandHold({
        waitsInLine,
        agentWorking,
        promptPending,
        // A rewind on its way holds a command as background work does, in the same words.
        backgroundTasksRunning:
          args.chat.backgroundTasks.isMonitoring || args.rewindInFlight.current,
        sendPending
      }),
      causes,
      startFailures: () => structuredAgentSessionStartFailureFacts(args.items()),
      send: (command) =>
        args.send(
          command,
          command === 'compact' && args.commandsWait ? 'queue-if-active' : undefined
        )
    })
  }
  return { runConversationCommand: run, commandRefusalCauses: causes }
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
    sayAgentSessionFailureTranslated,
    sayAgentSessionWriteNoticeTranslated
  )
}

import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { structuredAgentSessionStartFailureFacts } from './structured-agent-session-delivery-notices'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'
import type { StructuredPromptItem } from '../../../../shared/structured-agent-session-message-projection'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import type {
  StructuredAgentSessionCommandOutcome,
  StructuredAgentSessionCommandRefusalCause
} from '../../../../shared/structured-agent-session-composer'
import {
  conversationCommandReply,
  heldConversationCommandParts,
  structuredConversationCommandHold,
  type StructuredConversationCommandHold
} from '../../../../shared/structured-conversation-command-hold'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'

type CommandOutcome = Omit<StructuredAgentSessionCommandOutcome, 'handled'>

export type StructuredConversationCommandCauses = Readonly<
  Record<StructuredAgentSessionCommandRefusalCause, boolean>
>

export async function sendStructuredConversationCommand(input: {
  command: AgentSessionConversationCommand
  agentName: string
  pending: { current: boolean }
  hold: StructuredConversationCommandHold | null
  /** Name a refusal’s cause only if visible at keypress; otherwise it could disappear before the reader sees it. */
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
    return {
      accepted: false,
      error: agentSessionWriteNoticeText(heldConversationCommandParts(input.command, 'working'))
    }
  }
  // The message ahead reads as sending, and Send is busy until the host has it; nothing is armed.
  if (input.hold === 'ahead') {
    return { accepted: false, error: null }
  }
  if (input.hold !== null) {
    return refused(
      agentSessionWriteNoticeText(heldConversationCommandParts(input.command, input.hold)),
      input.hold
    )
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
    const reply = conversationCommandReply(outcome.value, {
      agentName: input.agentName,
      startFailures: input.startFailures(),
      say: sayAgentSessionFailureTranslated
    })
    return reply.accepted ? { accepted: true, error: null } : refused(reply.error, reply.cause)
  } finally {
    input.pending.current = false
  }
}

export function structuredConversationCommandRunner(args: {
  agentName: string
  pending: { current: boolean }
  /** The host holds a /compact as a card, and this client renders the queue. */
  commandsWait: boolean
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

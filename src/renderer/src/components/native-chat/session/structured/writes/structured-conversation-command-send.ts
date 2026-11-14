import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../../../../shared/agent-session/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../../../../../shared/agent-session/failures/agent-session-failure'
import { sayAgentSessionFailureTranslated } from '../../../messages/notices/agent-session-failure-words-text'
import { agentSessionWriteNoticeText } from '../../../messages/notices/agent-session-write-notice-text'
import { agentSessionVisibleFailureFacts } from '../../../../../../../shared/agent-session/failures/agent-session-visible-failures'
import { pendingPromptsAllUnanswerableHere } from '../../../../../../../shared/agent-session/agent-session-approval-subject'
import type { StructuredPromptItem } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionPendingSend } from '../delivery/structured-agent-session-pending-sends'
import type {
  StructuredAgentSessionCommandOutcome,
  StructuredAgentSessionCommandRefusalCause
} from '../../../../../../../shared/agent-session/view/structured-agent-session-composer'
import {
  conversationCommandReply,
  heldConversationCommandParts,
  structuredConversationCommandHold,
  type StructuredConversationCommandHold
} from '../../../../../../../shared/structured-conversation-command-hold'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'
import { structuredAgentSessionCommandWriteRefusalCause } from '../../../../../../../shared/agent-session/failures/structured-agent-session-command-refusal-cause'

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
  /** Called as a /clear goes out; the returned restore runs unless the host accepts it. */
  onClearSent?: () => () => void
  send: (
    command: AgentSessionConversationCommand
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
  /** The command passed every local hold and is on its way to the host. */
  onSent?: () => void
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
  const restoreClear = input.command === 'clear' ? input.onClearSent?.() : undefined
  let accepted = false
  try {
    const sending = input.send(input.command)
    input.onSent?.()
    const outcome = await sending
    if (outcome.kind === 'not-done') {
      return refused(
        outcome.notice,
        structuredAgentSessionCommandWriteRefusalCause(outcome.failure)
      )
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
    accepted = reply.accepted
    return reply.accepted ? { accepted: true, error: null } : refused(reply.error, reply.cause)
  } finally {
    input.pending.current = false
    if (!accepted) {
      restoreClear?.()
    }
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
  onClearSent?: () => () => void
  send: (
    command: AgentSessionConversationCommand,
    delivery?: 'queue-if-active',
    instructions?: string
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): {
  runConversationCommand: (
    command: AgentSessionConversationCommand,
    instructions?: string,
    onSent?: () => void
  ) => Promise<CommandOutcome>
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
  const run = (
    command: AgentSessionConversationCommand,
    instructions?: string,
    onSent?: () => void
  ) => {
    const waitsInLine =
      command === 'compact' &&
      args.commandsWait &&
      !(promptPending && pendingPromptsAllUnanswerableHere(args.prompts))
    return sendStructuredConversationCommand({
      command,
      agentName: args.agentName,
      pending: args.pending,
      hold: structuredConversationCommandHold({
        command,
        waitsInLine,
        agentWorking,
        promptPending,
        backgroundTasksRunning: args.chat.backgroundTasks.isMonitoring,
        rewindInFlight: args.rewindInFlight.current,
        sendPending
      }),
      causes,
      startFailures: () => agentSessionVisibleFailureFacts(args.items()),
      onClearSent: args.onClearSent,
      onSent,
      send: (command) =>
        args.send(
          command,
          command === 'compact' && args.commandsWait ? 'queue-if-active' : undefined,
          instructions
        )
    })
  }
  return { runConversationCommand: run, commandRefusalCauses: causes }
}

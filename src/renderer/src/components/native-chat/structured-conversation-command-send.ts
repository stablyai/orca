import {
  isAgentSessionConversationCommand,
  type AgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from '../../../../shared/agent-session/agent-session-conversation-command'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../shared/agent-session-failure-words'
import { translate } from '@/i18n/i18n'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import {
  agentSessionFailureStatedByStartRow,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'
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

type CommandOutcome = Omit<StructuredAgentSessionCommandOutcome, 'handled'>

export type StructuredConversationCommandCauses = Readonly<
  Record<StructuredAgentSessionCommandRefusalCause, boolean>
>

function heldCommandText(
  command: AgentSessionConversationCommand,
  hold: Exclude<StructuredConversationCommandHold, 'ahead'>
): string {
  const clear = command === 'clear'
  switch (hold) {
    case 'prompt':
      return agentSessionWriteNoticeText([clear ? 'clearAfterAnswer' : 'compactAfterAnswer'])
    case 'working':
      return agentSessionWriteNoticeText([
        'agentStillWorking',
        clear ? 'runClearWhenDone' : 'runCompactWhenDone'
      ])
    case 'sending':
      return agentSessionWriteNoticeText([clear ? 'clearAfterSending' : 'compactAfterSending'])
    case 'background':
      break
  }
  return translate(
    'components.native-chat.conversationCommand.pendingWork',
    'Wait for pending work and messages to finish before using this command.'
  )
}

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
    return { accepted: false, error: heldCommandText(input.command, 'working') }
  }
  // The message ahead reads as sending, and Send is busy until the host has it; nothing is armed.
  if (input.hold === 'ahead') {
    return { accepted: false, error: null }
  }
  if (input.hold !== null) {
    return refused(heldCommandText(input.command, input.hold), input.hold)
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
    // Suppress start failures already shown in this chat; clear/new-command failures may belong elsewhere and need host wording.
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

/** Translate complete known facts/commands; preserve host text for older/newer payloads this client cannot interpret. */
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
  return agentSessionFailureSentence(
    fact,
    'row',
    { agentName, command: result.command },
    sayAgentSessionFailureTranslated
  )
}

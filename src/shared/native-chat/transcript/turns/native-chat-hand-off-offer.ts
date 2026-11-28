import { isRootAgentJournalItem } from '../../../agent-session/journal/agent-session-journal-producer'
import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationSource
} from '../../../agent-session/conversation-context/agent-session-continuation'
import type { TuiAgent } from '../../../agent-launch/catalog/tui-agent'
import { buildAgentSessionHandoffContext } from '../agent-session-handoff-context'
import type { NativeChatMessage } from '../../native-chat-types'

/** A finished response of the chat's own agent, still in its current context, eligible for a
 *  context-seeded hand-off when no native Fork action is offered on that row. */
export function nativeChatRowOffersHandOff(
  row: {
    message: NativeChatMessage
    /** Inside a subagent's section, whose replies are no root turn. */
    inSubagentSection: boolean
    turnWorking: boolean
  },
  chat: {
    contextFloorSequence: number
  }
): boolean {
  const { message } = row
  const sequence = message.journalPosition?.sequence
  const withinContext =
    chat.contextFloorSequence === 0 ||
    (sequence !== undefined && sequence > chat.contextFloorSequence)
  return (
    message.role === 'assistant' &&
    message.source === 'transcript' &&
    !message.agentStart &&
    !row.inSubagentSection &&
    isRootAgentJournalItem(message) &&
    !row.turnWorking &&
    withinContext
  )
}

/** Slices rendered chat messages from the active context floor through `throughMessageId` inclusive,
 *  omitting anything after the selected response as well as queued or unsent drafts. */
export function sliceNativeChatMessagesThrough(
  messages: readonly NativeChatMessage[],
  throughMessageId: string,
  contextFloorSequence = 0
): NativeChatMessage[] | null {
  const targetIndex = messages.findIndex((message) => message.id === throughMessageId)
  if (targetIndex === -1) {
    return null
  }
  const sliced = messages.slice(0, targetIndex + 1).filter((message) => {
    if (message.queued || message.unsent) {
      return false
    }
    if (contextFloorSequence > 0) {
      const sequence = message.journalPosition?.sequence
      if (sequence === undefined || sequence <= contextFloorSequence) {
        return false
      }
    }
    return true
  })
  return sliced.length > 0 ? sliced : null
}

/** Builds a truncated continuation source up to `throughMessageId`, omitting the full-session
 *  `transcriptPath` so the new session cannot read turns after the selected response. */
export function buildResponseHandOffSource(input: {
  messages: readonly NativeChatMessage[]
  throughMessageId: string
  contextFloorSequence?: number
  sourceAgent: TuiAgent
  sourceTitle?: string | null
  sourceWorkingDirectory?: string | null
}): AgentSessionContinuationSource | null {
  const sliced = sliceNativeChatMessagesThrough(
    input.messages,
    input.throughMessageId,
    input.contextFloorSequence ?? 0
  )
  if (!sliced) {
    return null
  }
  const source: AgentSessionContinuationSource = {
    sourceKind: 'chat',
    sourceAgent: input.sourceAgent,
    sourceTitle: input.sourceTitle,
    sourceWorkingDirectory: input.sourceWorkingDirectory,
    transcriptPath: undefined,
    capturedText: buildAgentSessionHandoffContext(sliced),
    truncatedToResponse: true
  }
  return buildAgentSessionContinuationPrompt(source, 'focused') ? source : null
}

import { noteRevisedInPlace, positionsRevisedFrom } from './revised-in-place-lists'
import { onlyStreamedTextChanged } from './structured-agent-session-streamed-text-rows'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { compareAgentJournalItems } from '../journal/agent-session-journal-position'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import {
  isAgentSessionContextClear,
  isNativeChatContextClear
} from '../conversation-context/agent-session-context-clear'
import { isNativeChatProviderRetryRow } from '../../native-chat/transcript/notices/native-chat-provider-retry-runs'
import {
  compareNativeChatTranscriptMessages,
  sameNativeChatRowPlacement
} from '../../native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import {
  isQuestionNeutralAgentJournalItem,
  sameQuestionTurnBoundary
} from '../../native-chat/transcript/messages/structured-agent-question-projection'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'
import {
  projectStructuredAgentSessionMessageRows,
  type StructuredAgentSessionItemProjector,
  type StructuredAgentSessionMessageRows,
  type StructuredAgentSessionOptimisticMessage
} from './structured-agent-session-message-projection'

// Streamed commits mostly revise or append rows; re-deriving only those keeps a long chat's commit cost off its history.

/** Whether a revision or append of this item can change only its own row. */
function drawsOnlyItsOwnRow(item: AgentJournalRenderItem): boolean {
  return (
    isQuestionNeutralAgentJournalItem(item) &&
    !isAgentSessionContextClear(item.body) &&
    !(item.body.kind === 'message' && item.body.command)
  )
}

function independentRow(row: NativeChatMessage | undefined): boolean {
  return row === undefined || (!isNativeChatProviderRetryRow(row) && !isNativeChatContextClear(row))
}

type MessageStream = StructuredAgentSessionMessageRows & {
  items: readonly AgentJournalRenderItem[]
  optimistic: readonly StructuredAgentSessionOptimisticMessage[]
  submissions: readonly AgentJournalSubmission[]
  /** Conversation row index by id, for rows drawn undecorated from one item. */
  rowAt: Map<string, number>
  submissionIds: ReadonlySet<string>
  optimisticIds: ReadonlySet<string>
}

function withRowIndex(
  projection: StructuredAgentSessionMessageRows,
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[]
): MessageStream {
  const rowAt = new Map<string, number>()
  for (let index = 0; index < projection.conversationEnd; index += 1) {
    rowAt.set(projection.output[index]!.id, index)
  }
  return {
    ...projection,
    items,
    optimistic,
    submissions,
    rowAt,
    submissionIds: new Set(
      submissions.map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
    ),
    optimisticIds: new Set(
      optimistic.map((entry) => agentJournalSubmissionKey(entry.clientMessageId))
    )
  }
}

/** Revised rows replace their own; appended rows join the conversation before held cards and echoes. */
function reuseMessages(
  previous: MessageStream,
  items: readonly AgentJournalRenderItem[],
  projectItems: StructuredAgentSessionItemProjector
): MessageStream | null {
  // Stopped sends are placed among the rows, so only a revision of a reply's streamed text keeps
  // them where they were; any other change (a turn's opener corrected) places them again.
  if (
    items.length < previous.items.length ||
    (previous.hasStoppedSends && items.length !== previous.items.length)
  ) {
    return null
  }
  let output: NativeChatMessage[] | null = null
  const revisedAt: number[] = []
  // A revision in place names its rows; anything else is compared row by row.
  for (const index of positionsRevisedFrom(items, previous.items) ?? previous.items.keys()) {
    const before = previous.items[index]!
    const item = items[index]!
    if (before === item) {
      continue
    }
    if (previous.hasStoppedSends && !onlyStreamedTextChanged(before, item)) {
      return null
    }
    if (
      !drawsOnlyItsOwnRow(before) ||
      !drawsOnlyItsOwnRow(item) ||
      !sameQuestionTurnBoundary(before, item) ||
      compareAgentJournalItems(before, item) !== 0
    ) {
      return null
    }
    const [old] = projectItems([before])
    const [row] = projectItems([item])
    if (!old || !row) {
      if (old || row) {
        return null
      }
      continue
    }
    const at = previous.rowAt.get(old.id)
    if (
      at === undefined ||
      previous.output[at] !== old ||
      !independentRow(old) ||
      !independentRow(row) ||
      !sameNativeChatRowPlacement(old, row)
    ) {
      return null
    }
    ;(output ??= previous.output.slice())[at] = row
    revisedAt.push(at)
  }
  const appended = items.slice(previous.items.length)
  if (appended.length === 0) {
    if (!output) {
      return { ...previous, items }
    }
    noteRevisedInPlace(output, previous.output, revisedAt)
    return { ...previous, items, output }
  }
  if (
    appended.some(
      (item) =>
        !drawsOnlyItsOwnRow(item) ||
        previous.submissionIds.has(item.itemId) ||
        previous.optimisticIds.has(item.itemId)
    )
  ) {
    return null
  }
  const rows = projectItems(appended)
  let last = previous.output[previous.conversationEnd - 1]
  for (const row of rows) {
    if (
      !independentRow(row) ||
      !row.journalPosition ||
      previous.rowAt.has(row.id) ||
      previous.submissionIds.has(row.id) ||
      previous.optimisticIds.has(row.id) ||
      (last && compareNativeChatTranscriptMessages(last, row) >= 0)
    ) {
      return null
    }
    last = row
  }
  const base = output ?? previous.output
  for (const [offset, row] of rows.entries()) {
    previous.rowAt.set(row.id, previous.conversationEnd + offset)
  }
  return {
    ...previous,
    items,
    output: [
      ...base.slice(0, previous.conversationEnd),
      ...rows,
      ...base.slice(previous.conversationEnd)
    ],
    conversationEnd: previous.conversationEnd + rows.length
  }
}

/** One consumer's messages across commits: re-derive only revised or appended items when nothing else can
 * change, else project in full. */
export function createStructuredAgentSessionMessageProjection(
  projectItems: StructuredAgentSessionItemProjector = projectStructuredItemsToNativeChat
) {
  let previous: MessageStream | null = null
  return (
    items: readonly AgentJournalRenderItem[],
    optimistic: readonly StructuredAgentSessionOptimisticMessage[],
    submissions: readonly AgentJournalSubmission[]
  ): NativeChatMessage[] => {
    const reused =
      previous?.optimistic === optimistic && previous.submissions === submissions
        ? previous.items === items
          ? previous
          : reuseMessages(previous, items, projectItems)
        : null
    previous =
      reused ??
      withRowIndex(
        projectStructuredAgentSessionMessageRows(items, optimistic, submissions, projectItems),
        items,
        optimistic,
        submissions
      )
    return previous.output
  }
}

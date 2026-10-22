import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { isAgentSessionProviderContextBoundary } from './agent-session-provider-context'
import type { NativeChatMessage } from './native-chat-types'

export function isAgentSessionContextClear(body: AgentJournalItemBody | undefined): boolean {
  return body?.kind === 'status' && isAgentSessionProviderContextBoundary(body.contextClear)
}

export function isNativeChatContextClear(message: NativeChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) => block.type === 'text' && isAgentSessionProviderContextBoundary(block.contextClear)
    )
  )
}

export function agentSessionContextSequenceFor(
  sequence: number,
  boundaries: readonly number[]
): number {
  let left = 0
  let right = boundaries.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (boundaries[middle] < sequence) {
      left = middle + 1
    } else {
      right = middle
    }
  }
  return left > 0 ? boundaries[left - 1] : 0
}

export function latestAgentSessionContextClearSequence(
  items: Iterable<Pick<AgentJournalRenderItem, 'sequence' | 'body'>>
): number {
  let sequence = 0
  for (const item of items) {
    if (item.sequence > sequence && isAgentSessionContextClear(item.body)) {
      sequence = item.sequence
    }
  }
  return sequence
}

/** What a transcript shows: rows from the `/clear` divider at `floor` on, so a cleared chat reads
 *  as cleared. The journal keeps the earlier rows for worker reads and archives. */
export function agentSessionTranscriptRows<
  T extends Pick<AgentJournalRenderItem, 'sequence' | 'body'>
>(items: readonly T[], floor = latestAgentSessionContextClearSequence(items)): readonly T[] {
  return floor > 0 ? items.filter((item) => item.sequence >= floor) : items
}

/** The host's latest `/clear` sequence, when it speaks for this journal epoch; 0 otherwise. */
export function agentSessionContextFloorSequence(
  floor: AgentJournalCursor | undefined,
  epoch: string | null
): number {
  return floor && floor.epoch === epoch ? floor.sequence : 0
}

/** A loaded `/clear` divider is where a transcript's history starts, so nothing older is paged. */
export function agentSessionHasOlderTranscript(
  items: readonly Pick<AgentJournalRenderItem, 'body'>[],
  hasOlder: boolean
): boolean {
  return hasOlder && !items.some((item) => isAgentSessionContextClear(item.body))
}

export function agentSessionCurrentContextRows(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  minimumSequence = 0
) {
  const sequence = Math.max(minimumSequence, latestAgentSessionContextClearSequence(items))
  return sequence > 0
    ? {
        items: items.filter((item) => item.sequence > sequence),
        submissions: submissions.filter(
          (submission) => (submission.acceptedSequence ?? 0) > sequence
        )
      }
    : { items, submissions }
}

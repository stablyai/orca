import { finishAgentSessionSteps } from './agent-session-projection-steps'
import type { AgentJournalCursor } from './journal/agent-session-journal-identity'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './journal/agent-session-journal-types'
import { isAgentSessionProviderContextBoundary } from './agent-session-provider-context'
import type { NativeChatMessage } from '../native-chat/native-chat-types'

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
  return finishAgentSessionSteps(latestAgentSessionContextClearSequenceSteps(items))
}

export function* latestAgentSessionContextClearSequenceSteps(
  items: Iterable<Pick<AgentJournalRenderItem, 'sequence' | 'body'>>
): Generator<void, number> {
  let sequence = 0
  for (const item of items) {
    yield

    if (item.sequence > sequence && isAgentSessionContextClear(item.body)) {
      sequence = item.sequence
    }
  }
  return sequence
}

/** Show rows from the /clear divider onward; retain earlier journal rows for workers and archives. */
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
): { items: readonly AgentJournalRenderItem[]; submissions: readonly AgentJournalSubmission[] } {
  return finishAgentSessionSteps(
    agentSessionCurrentContextRowsSteps(items, submissions, minimumSequence)
  )
}

export function* agentSessionCurrentContextRowsSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  minimumSequence = 0
): Generator<
  void,
  { items: readonly AgentJournalRenderItem[]; submissions: readonly AgentJournalSubmission[] }
> {
  const sequence = Math.max(
    minimumSequence,
    yield* latestAgentSessionContextClearSequenceSteps(items)
  )
  if (sequence === 0) {
    return { items, submissions }
  }
  const currentItems: AgentJournalRenderItem[] = []
  const currentSubmissions: AgentJournalSubmission[] = []
  for (const item of items) {
    if (item.sequence > sequence) {
      currentItems.push(item)
    }
    yield
  }
  for (const submission of submissions) {
    if ((submission.acceptedSequence ?? 0) > sequence) {
      currentSubmissions.push(submission)
    }
    yield
  }
  return { items: currentItems, submissions: currentSubmissions }
}

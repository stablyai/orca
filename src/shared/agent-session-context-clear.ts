import type {
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

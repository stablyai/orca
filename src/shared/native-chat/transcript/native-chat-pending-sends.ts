import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import type {
  NativeChatPromptDispatch,
  NativeChatPromptSubmission,
  NativeChatSourceContext
} from '../input/native-chat-prompt-observation'
import type { NativeChatMessage } from '../native-chat-types'
import type {
  NativeChatSourceReceipt,
  NativeChatSourceBoundary,
  NativeChatReceiptDependency
} from './native-chat-source-receipts'
import {
  reconcileNativeChatPendingSends,
  commitNativeChatPendingReceipts
} from './native-chat-pending-reconciliation'
export { releaseEmptyTranscriptClaims } from './native-chat-pending-legacy'

// Bounds reconciliation cost; each open send rescans the transcript.
export const NATIVE_CHAT_PENDING_SEND_LIMIT = 8
export type NativeChatPendingDispatchOutcome = 'not-submitted' | 'uncertain' | 'submitted'

export type NativeChatPendingSend = {
  id: string
  /** Host-owned sends can use optional exact evidence alongside text matching. */
  sourceAgent?: AgentType
  sourceContext?: NativeChatSourceContext
  sourceSessionId?: string
  promptBinding?: NativeChatPromptDispatch
  promptSubmission?: NativeChatPromptSubmission
  sourceBoundary?: NativeChatSourceBoundary
  sourceReceipt?: NativeChatSourceReceipt
  receiptMembers?: string[]
  receiptProof?: 'source' | 'legacy'
  receiptGlue?: boolean
  receiptDependencies?: NativeChatReceiptDependency[]
  /** Capability can still resolve to the shipped legacy path until the dispatch callback finishes. */
  evidenceModePending?: true
  /** A source row cannot commit an operation before its final transport disposition. */
  dispatchPending?: true
  dispatchOutcome?: Promise<NativeChatPendingDispatchOutcome>
  /** Definite send outcome; absent while the send is simply awaiting its transcript row. */
  delivery?: 'unconfirmed' | 'rejected'
  recovery?: true
  /** When a write's acknowledgment was lost, so a remount keeps the original hold deadline. */
  writeUnconfirmedAt?: number
  /** Authoritative provider session in which the observation interval began. */
  writeUnconfirmedSessionId?: string
  text: string
  imagePaths?: string[]
  /** Client clock at send time; display placement never compares it with the host clock. */
  sentAt: number
  /** Host working epoch observed at send time; absent for an idle send, null for an unknown epoch. */
  queuedDuringWorkingEpoch?: number | null
  /** Match only after the last authoritative row at send time so repeated prompts cannot bind older turns. */
  afterMessageId?: string | null
  /** Timestamp of that boundary in the transcript host's clock domain. */
  afterMessageTimestamp?: number | null
  /** An authoritative empty read proves all session rows are newer; loading or absent sessions cannot claim this. */
  afterEmptyTranscriptSessionId?: string
  /** 1-based occurrence among identical sends sharing the same boundary. */
  matchingOccurrence?: number
  /** Shared time boundary when that message boundary is unavailable. */
  matchingAfterTimestamp?: number
}

/** Visibility and retirement project one allocation; retirement alone commits ownership. */
export function prunePendingSends<T extends NativeChatPendingSend>(
  pending: T[],
  messages: readonly NativeChatMessage[],
  sessionId = '',
  context?: NativeChatSourceContext
): T[] {
  return commitNativeChatPendingReceipts(pending, messages, sessionId, context)
}

export function visibleNativeChatPendingSends<T extends NativeChatPendingSend>(
  pending: T[],
  messages: readonly NativeChatMessage[],
  sessionId = '',
  context?: NativeChatSourceContext
): T[] {
  const { represented } = reconcileNativeChatPendingSends(pending, messages, sessionId, context)
  return pending.filter((entry) => !represented.has(entry.id))
}

export function nativeChatPendingSendPlacement(
  entry: Pick<NativeChatPendingSend, 'queuedDuringWorkingEpoch'>,
  workingEpoch?: number | null
): 'active' | 'queued' {
  return entry.queuedDuringWorkingEpoch !== undefined &&
    workingEpoch !== undefined &&
    (entry.queuedDuringWorkingEpoch === null ||
      workingEpoch === null ||
      entry.queuedDuringWorkingEpoch === workingEpoch)
    ? 'queued'
    : 'active'
}

/** Scrape-source echoes yield to real transcript rows. */
export function pendingSendsAsMessages(
  pending: NativeChatPendingSend[],
  existingMessages: readonly NativeChatMessage[] = [],
  workingEpoch?: number | null,
  sessionId = '',
  context?: NativeChatSourceContext
): NativeChatMessage[] {
  return visibleNativeChatPendingSends(pending, existingMessages, sessionId, context).map(
    (entry) => ({
      id: `pending:${entry.id}`,
      role: 'user' as const,
      blocks: [
        ...(entry.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path })),
        ...(entry.text.trim().length > 0 ? [{ type: 'text' as const, text: entry.text }] : [])
      ],
      timestamp: entry.sentAt,
      pendingSend: nativeChatPendingSendPlacement(entry, workingEpoch),
      source: 'scrape' as const
    })
  )
}

export function isPendingMessageId(id: string): boolean {
  return id.startsWith('pending:')
}

export function isLaunchPromptMessageId(id: string): boolean {
  return id.startsWith('launch-pending:')
}

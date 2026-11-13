import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type {
  NativeChatPendingSend,
  NativeChatPendingDispatchOutcome
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import { canClaimNativeChatReceipt } from '../../../../../../../shared/native-chat/transcript/native-chat-source-receipts'
import {
  assignNativeChatPendingOccurrence,
  nativeChatPendingContentKey,
  nativeChatPendingMatchKey
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-occurrence'
import type { NativeChatPromptDispatch } from '../../../../../../../shared/native-chat/input/native-chat-prompt-observation'

export type NativeChatOptimisticSendOutcome = {
  setPromptBinding?: (pendingId: string, binding: NativeChatPromptDispatch) => void
  /** The host refused the write: mark the echo "Message not sent". */
  setSourceEvidence?: (pendingId: string, source: boolean) => void
  finishSourceEvidence?: (pendingId: string) => void
  finishDispatch?: (
    pendingId: string,
    promise: Promise<NativeChatPendingDispatchOutcome>,
    outcome: NativeChatPendingDispatchOutcome
  ) => void
  reject: (pendingId: string) => void
  /** The write acknowledgment was lost: hold the echo, then flag it unconfirmed. */
  holdUnconfirmed: (pendingId: string) => void
}

/** A definite refusal contributes no transcript occurrence; spent predecessors keep their debt. */
function releaseRejectedOccurrence(
  entries: NativeChatPendingSend[],
  rejected: NativeChatPendingSend
): NativeChatPendingSend[] {
  const index = entries.findIndex((entry) => entry.id === rejected.id)
  const key = nativeChatPendingMatchKey({ ...rejected, sourceAgent: undefined })
  const rank = entries[index]?.matchingOccurrence ?? 1
  let first: NativeChatPendingSend | undefined
  return entries.map((entry, position) => {
    if (
      position <= index ||
      nativeChatPendingMatchKey({ ...entry, sourceAgent: undefined }) !== key ||
      (entry.matchingOccurrence ?? 1) <= rank
    ) {
      return entry
    }
    first ??= entry
    const matchingOccurrence = entry.matchingOccurrence! - 1
    return {
      ...entry,
      matchingOccurrence: matchingOccurrence === 1 ? undefined : matchingOccurrence,
      matchingAfterTimestamp:
        rank === 1
          ? matchingOccurrence === 1
            ? undefined
            : (first.afterMessageTimestamp ?? first.sentAt)
          : entry.matchingAfterTimestamp
    }
  })
}

export function rejectPendingSend(
  entries: NativeChatPendingSend[],
  id: string
): NativeChatPendingSend[] {
  const entry = entries.find((entry) => entry.id === id)
  if (!entry || entry.delivery === 'rejected') {
    return entries
  }
  const next =
    entry.sourceAgent && !entry.sourceReceipt ? releaseRejectedOccurrence(entries, entry) : entries
  return next.map((candidate) =>
    candidate.id === id ? { ...candidate, delivery: 'rejected' } : candidate
  )
}

export function resolvePendingSendEvidence(
  entries: NativeChatPendingSend[],
  id: string,
  agent: AgentType,
  source?: boolean
): NativeChatPendingSend[] {
  const index = entries.findIndex(
    (entry) => entry.id === id && (entry.evidenceModePending || entry.dispatchPending)
  )
  if (index === -1) {
    return entries
  }
  let entry = entries[index]
  if (source === false) {
    const key = nativeChatPendingContentKey({ ...entry, sourceAgent: undefined })
    for (const previous of entries.slice(0, index)) {
      if (
        !previous.sourceAgent &&
        !previous.sourceReceipt &&
        previous.delivery &&
        nativeChatPendingContentKey(previous) === key
      ) {
        entries = releaseRejectedOccurrence(entries, previous)
      }
    }
    entry = entries[index]
  }
  const resolved = {
    ...entry,
    sourceAgent: source === undefined ? entry.sourceAgent : source ? agent : undefined,
    evidenceModePending: undefined,
    ...(source === false ? { dispatchPending: undefined, dispatchOutcome: undefined } : {})
  }
  const key = nativeChatPendingContentKey(resolved)
  const before = entries
    .slice(0, index)
    .filter(
      (previous) =>
        source !== false ||
        previous.sourceAgent ||
        !previous.delivery ||
        nativeChatPendingContentKey(previous) !== key
    )
  const next =
    source === false
      ? assignNativeChatPendingOccurrence<NativeChatPendingSend>(
          before
            .filter((previous) => canClaimNativeChatReceipt(previous, true))
            .map((previous) => ({ ...previous, sourceAgent: undefined })),
          resolved
        )
      : resolved
  return [...before, next, ...entries.slice(index + 1)]
}

export function finishPendingSendDispatch(
  entries: NativeChatPendingSend[],
  id: string,
  promise: Promise<NativeChatPendingDispatchOutcome>,
  outcome: NativeChatPendingDispatchOutcome
): NativeChatPendingSend[] {
  const entry = entries.find(
    (candidate) =>
      candidate.id === id && candidate.dispatchPending && candidate.dispatchOutcome === promise
  )
  if (!entry) {
    return entries
  }
  if (outcome === 'not-submitted') {
    entries = rejectPendingSend(entries, id)
  }
  return entries.map((candidate) =>
    candidate.id !== id
      ? candidate
      : {
          ...candidate,
          dispatchPending: undefined,
          dispatchOutcome: undefined,
          evidenceModePending: undefined,
          ...(outcome === 'not-submitted'
            ? { delivery: 'rejected' as const }
            : outcome === 'uncertain'
              ? { writeUnconfirmedAt: entry.writeUnconfirmedAt ?? Date.now() }
              : {
                  writeUnconfirmedAt: undefined,
                  writeUnconfirmedSessionId: undefined,
                  delivery: undefined
                })
        }
  )
}

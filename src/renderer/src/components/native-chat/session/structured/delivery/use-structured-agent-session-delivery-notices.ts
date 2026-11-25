import { useLatestHandler } from '@/lib/use-latest-handler'
import { useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import {
  structuredAgentSessionClearSequences,
  structuredAgentSessionCommandItemIds
} from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { agentJournalSubmissionKey } from '../../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import { useStructuredAgentSessionStartFailureFacts } from '../../../messages/notices/use-structured-agent-session-start-failure-facts'
import type { NativeChatDeliveryNotice } from '../../../messages/rows/NativeChatMessageRow'
import type { AgentSessionFailureFact } from '../../../../../../../shared/agent-session/failures/agent-session-failure'
import { rowsBesideStreamedText } from '../../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { structuredAgentSessionRetryLineages } from '../../../../../../../shared/agent-session/view/structured-agent-session-retry-lineage'

/** The structured chat's delivery notices, by the message id each row renders under. */
export function useStructuredAgentSessionDeliveryNotices(args: {
  pending: readonly StructuredAgentSessionPendingSend[]
  submissions: readonly AgentJournalSubmission[]
  journalItems: readonly AgentJournalRenderItem[]
  agentName: string
  startFailures?: readonly AgentSessionFailureFact[]
  onRetry?: (submission: AgentJournalSubmission, bodyClientMessageId: string) => void
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, pending, submissions } = args
  const onRetry = useLatestHandler(
    (submission: AgentJournalSubmission, bodyClientMessageId: string) =>
      args.onRetry?.(submission, bodyClientMessageId)
  )
  const retryEnabled = args.onRetry !== undefined
  const lineages = useMemo(() => structuredAgentSessionRetryLineages(submissions), [submissions])
  // Only rejection wording needs journal items; pending delivery comes from submissions alone.
  const hasRejected = useMemo(
    () =>
      submissions.some(
        (submission) =>
          submission.dispatchState === 'rejected' &&
          !dispatchWasWithdrawn(submission) &&
          lineages.get(submission.retryOfClientMessageId ?? submission.clientMessageId)
            ?.dispatchState !== 'accepted'
      ),
    [lineages, submissions]
  )
  const loadedFailures = useStructuredAgentSessionStartFailureFacts(
    args.journalItems,
    hasRejected && args.startFailures === undefined
  )
  const startFailures = args.startFailures ?? loadedFailures
  const journalRows = rowsBesideStreamedText(args.journalItems)
  const clearSequences = useMemo(() => {
    if (hasRejected) {
      const sequences = structuredAgentSessionClearSequences(journalRows)
      return sequences.length ? sequences : undefined
    }
    return undefined
  }, [journalRows, hasRejected])
  const commandItemIds = useStableItemIds(
    useMemo(
      () => (hasRejected ? structuredAgentSessionCommandItemIds(journalRows) : NO_ITEMS),
      [hasRejected, journalRows]
    )
  )
  const retryItems = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of pending) {
      if (entry.retryOfClientMessageId) {
        ids.add(agentJournalSubmissionKey(entry.retryOfClientMessageId))
      }
    }
    for (const [root, retry] of lineages) {
      if (retry.dispatchState === 'pending' || retry.dispatchState === 'rejected') {
        ids.add(agentJournalSubmissionKey(root))
        ids.add(agentJournalSubmissionKey(retry.clientMessageId))
      }
    }
    return ids
  }, [lineages, pending])
  const itemIds = useStableItemIds(
    useMemo(() => {
      if (retryItems.size === 0) {
        return NO_ITEMS
      }
      const found = new Set<string>()
      for (const item of journalRows) {
        if (retryItems.has(item.itemId)) {
          found.add(item.itemId)
        }
      }
      return found
    }, [journalRows, retryItems])
  )
  const notices = useMemo(
    () =>
      structuredAgentSessionDeliveryNotices({
        pending,
        submissions,
        agentName,
        startFailures,
        commandItemIds,
        clearSequences,
        itemIds,
        onRetry: retryEnabled ? onRetry : undefined
      }),
    [
      pending,
      submissions,
      agentName,
      startFailures,
      commandItemIds,
      clearSequences,
      itemIds,
      retryEnabled,
      onRetry
    ]
  )
  // Reuse unchanged notices/maps across submission batches to avoid rerendering rows.
  const previousRef = useRef(notices)
  const stable = sameNoticesKept(previousRef.current, notices)
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

const NO_ITEMS: ReadonlySet<string> = new Set()

/** Item-only streaming commits need no new notices when relevant membership is unchanged. */
function useStableItemIds(ids: ReadonlySet<string>): ReadonlySet<string> {
  const previousRef = useRef(ids)
  const previous = previousRef.current
  const stable =
    previous === ids || (previous.size === ids.size && [...ids].every((id) => previous.has(id)))
      ? previous
      : ids
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

/** Reuse equivalent prior notices and the whole prior map when every entry matches. */
function sameNoticesKept(
  previous: ReadonlyMap<string, NativeChatDeliveryNotice>,
  next: ReadonlyMap<string, NativeChatDeliveryNotice>
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  if (previous === next) {
    return next
  }
  let allKept = previous.size === next.size
  const kept = new Map<string, NativeChatDeliveryNotice>()
  for (const [id, notice] of next) {
    const before = previous.get(id)
    const same =
      before !== undefined &&
      before.text === notice.text &&
      before.failureKind === notice.failureKind &&
      before.signIn?.agentName === notice.signIn?.agentName &&
      before.signIn?.account === notice.signIn?.account &&
      before.onSend === notice.onSend &&
      before.recoveryFocus === notice.recoveryFocus &&
      before.recoveryCardId === notice.recoveryCardId &&
      (before.onDismiss === undefined) === (notice.onDismiss === undefined)
    allKept &&= same
    kept.set(id, same ? before : notice)
  }
  return allKept ? previous : kept
}

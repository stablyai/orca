import { useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionCommandItemIds } from '../../../../shared/structured-agent-session-message-projection'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []
const NO_ITEMS: readonly AgentJournalRenderItem[] = []

/** The structured chat's delivery notices, by the message id each row renders under. */
export function useStructuredAgentSessionDeliveryNotices(args: {
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
  journalItems: readonly AgentJournalRenderItem[]
  failedHere: ReadonlySet<string>
  retry: (clientMessageId: string) => void
  agentName: string
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, failedHere, outbox, submissions } = args
  // Read at click time, so the notices stay put while the outbox's Retry is rebuilt each render.
  const retryRef = useRef(args.retry)
  useEffect(() => {
    retryRef.current = args.retry
  })
  const retry = useCallback((clientMessageId: string) => {
    retryRef.current(clientMessageId)
  }, [])
  // Only a message shown as not sent (a withdrawn one draws nothing) or still in the outbox reads
  // the journal's rows, so in a chat with neither a new batch of them re-renders no row.
  const hasRejected =
    outbox.some((entry) => entry.state === 'rejected') ||
    submissions.some(
      (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
    )
  const journalRows = hasRejected || outbox.length > 0 ? submissions : NO_SUBMISSIONS
  // Only an outbox copy of a rejected message reads the loaded rows, so a streaming turn rebuilds
  // no notice otherwise.
  const loadedItems = hasRejected && outbox.length > 0 ? args.journalItems : NO_ITEMS
  const startFailures = useStructuredAgentSessionStartFailureFacts(args.journalItems, hasRejected)
  const commandItemIds = useCommandItemIds(args.journalItems, hasRejected)
  const notices = useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        outbox,
        agentName,
        retry,
        journalRows,
        startFailures,
        failedHere,
        commandItemIds,
        loadedItems
      ),
    [
      outbox,
      agentName,
      retry,
      journalRows,
      startFailures,
      failedHere,
      commandItemIds,
      loadedItems
    ]
  )
  // A submission batch rebuilds the map; one that says the same keeps the old, so no row re-renders.
  const previousRef = useRef(notices)
  const stable = sameNoticesKept(previousRef.current, notices)
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

const NO_COMMANDS: ReadonlySet<string> = new Set()

/** The loaded commands, read only while `enabled`, and held while unchanged so a streaming turn
 *  rebuilds no notice. */
function useCommandItemIds(
  items: readonly AgentJournalRenderItem[],
  enabled: boolean
): ReadonlySet<string> {
  const ids = useMemo(
    () => (enabled ? structuredAgentSessionCommandItemIds(items) : NO_COMMANDS),
    [enabled, items]
  )
  const previousRef = useRef(ids)
  const previous = previousRef.current
  const stable =
    previous.size === ids.size && [...ids].every((id) => previous.has(id)) ? previous : ids
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

/** `next`, reusing each notice `previous` words the same way, and `previous` itself when all are. */
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
    // Each Retry calls the stable `retry` with its own id, so one under the same key is the same.
    const same =
      before !== undefined &&
      before.text === notice.text &&
      (before.onRetry === undefined) === (notice.onRetry === undefined) &&
      (before.onDismiss === undefined) === (notice.onDismiss === undefined)
    allKept &&= same
    kept.set(id, same ? before : notice)
  }
  return allKept ? previous : kept
}

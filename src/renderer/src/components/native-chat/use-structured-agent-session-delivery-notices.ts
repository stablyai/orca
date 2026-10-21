import { useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionCommandItemIds } from '../../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

/** The structured chat's delivery notices, by the message id each row renders under. */
export function useStructuredAgentSessionDeliveryNotices(args: {
  pending: readonly StructuredAgentSessionPendingSend[]
  submissions: readonly AgentJournalSubmission[]
  journalItems: readonly AgentJournalRenderItem[]
  agentName: string
  startFailures?: readonly AgentSessionFailureFact[]
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, pending, submissions } = args
  // Only a chat with a message shown as not sent reads the journal's rows and loaded items, so in a
  // chat with none a streaming turn rebuilds no notice.
  const hasRejected = submissions.some(
    (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
  )
  const journalRows = hasRejected ? submissions : NO_SUBMISSIONS
  const loadedFailures = useStructuredAgentSessionStartFailureFacts(
    args.journalItems,
    hasRejected && args.startFailures === undefined
  )
  const startFailures = args.startFailures ?? loadedFailures
  const commandItemIds = useCommandItemIds(args.journalItems, hasRejected)
  const notices = useMemo(
    () =>
      structuredAgentSessionDeliveryNotices({
        pending,
        submissions: journalRows,
        agentName,
        startFailures,
        commandItemIds
      }),
    [pending, journalRows, agentName, startFailures, commandItemIds]
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
    const same =
      before !== undefined &&
      before.text === notice.text &&
      (before.onDismiss === undefined) === (notice.onDismiss === undefined)
    allKept &&= same
    kept.set(id, same ? before : notice)
  }
  return allKept ? previous : kept
}

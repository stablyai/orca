import { useEffect, useMemo, useRef } from 'react'
import type { AgentJournalRenderItem } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSubmission } from '../../../../../../../shared/agent-session/view/structured-agent-session-submissions'
import { dispatchWasWithdrawn } from '../../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionCommandItemIds } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { useStructuredAgentSessionStartFailureFacts } from '../../../messages/notices/use-structured-agent-session-start-failure-facts'
import type { NativeChatDeliveryNotice } from '../../../messages/rows/NativeChatMessageRow'
import type { AgentSessionFailureFact } from '../../../../../../../shared/agent-session/failures/agent-session-failure'

export function useStructuredAgentSessionHasRejection(
  submissions: readonly StructuredAgentSubmission[]
) {
  return useMemo(
    () =>
      submissions.some(
        (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
      ),
    [submissions]
  )
}

/** The structured chat's delivery notices, by the message id each row renders under. */
export function useStructuredAgentSessionDeliveryNotices(args: {
  submissions: readonly StructuredAgentSubmission[]
  journalItems: readonly AgentJournalRenderItem[]
  agentName: string
  startFailures?: readonly AgentSessionFailureFact[]
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, submissions } = args
  // Only rejection wording needs journal items; pending delivery comes from submissions alone.
  const hasRejected = useStructuredAgentSessionHasRejection(submissions)
  const loadedFailures = useStructuredAgentSessionStartFailureFacts(
    args.journalItems,
    hasRejected && args.startFailures === undefined
  )
  const startFailures = args.startFailures ?? loadedFailures
  const commandItemIds = useCommandItemIds(args.journalItems, hasRejected)
  const notices = useMemo(
    () =>
      structuredAgentSessionDeliveryNotices({
        submissions,
        agentName,
        startFailures,
        commandItemIds
      }),
    [submissions, agentName, startFailures, commandItemIds]
  )
  // Reuse unchanged notices/maps across submission batches to avoid rerendering rows.
  const previousRef = useRef(notices)
  const stable = useMemo(() => sameNoticesKept(previousRef.current, notices), [notices])
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

const NO_COMMANDS: ReadonlySet<string> = new Set()

/** Read command IDs only while enabled; retain unchanged sets through streaming. */
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
  const stable = useMemo(
    () => (previous.size === ids.size && [...ids].every((id) => previous.has(id)) ? previous : ids),
    [previous, ids]
  )
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
      (before.onDismiss === undefined) === (notice.onDismiss === undefined)
    allKept &&= same
    kept.set(id, same ? before : notice)
  }
  return allKept ? previous : kept
}

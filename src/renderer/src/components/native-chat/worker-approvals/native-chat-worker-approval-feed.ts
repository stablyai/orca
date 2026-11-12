import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import {
  WorkerApprovalsFrame,
  type OrchestrationWorkerApprovalEntry
} from '../../../../../shared/orchestration/orchestration-crew'
import { workerApprovalLapsesAt } from './worker-approval-card-model'
import {
  closedApproval,
  type WorkerApprovalOutcome
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'

export type NativeChatWorkerApproval = OrchestrationWorkerApprovalEntry

type Feed = {
  /** The host's list, as last received. */
  received: readonly NativeChatWorkerApproval[]
  /** Prompts answered or found closed here, shown closed until the host's list closes them too. */
  closedHere: Map<string, { outcome: WorkerApprovalOutcome; at: string }>
  entries: readonly NativeChatWorkerApproval[]
  listeners: Set<() => void>
  dispose: () => void
}

const EMPTY: readonly NativeChatWorkerApproval[] = []
// Why 5 s: a dropped local stream is rare; retry without hammering a host that refuses it.
const RETRY_MS = 5_000
const feeds = new Map<string, Feed>()

function publish(feed: Feed): void {
  for (const [approvalId] of feed.closedHere) {
    const entry = feed.received.find(({ approval }) => approval.approvalId === approvalId)
    if (entry?.approval.state !== 'open') {
      feed.closedHere.delete(approvalId)
    }
  }
  feed.entries = feed.closedHere.size
    ? feed.received.map((entry) => {
        const closed = feed.closedHere.get(entry.approval.approvalId)
        return closed
          ? { ...entry, approval: closedApproval(entry.approval, closed.outcome), at: closed.at }
          : entry
      })
    : feed.received
  feed.listeners.forEach((notify) => notify())
}

/** Shows a prompt closed at once, as answered here or found gone, before the host's list says so;
 *  null shows it open again, for an answer that was not applied. */
export function closeNativeChatWorkerApproval(
  party: string,
  approvalId: string,
  outcome: WorkerApprovalOutcome | null
): void {
  const feed = feeds.get(party)
  if (feed) {
    if (outcome) {
      feed.closedHere.set(approvalId, { outcome, at: new Date().toISOString() })
    } else {
      feed.closedHere.delete(approvalId)
    }
    publish(feed)
  }
}

/** One stream per chat party, shared by its transcript rows and its strip; local hosts only (v1).
 *  Not parked while hidden: a hidden coordinator tab still needs its workers' prompts. */
function observeWorkerApprovals(party: string, listener: () => void): () => void {
  let feed = feeds.get(party)
  if (!feed) {
    const held: Feed = {
      received: EMPTY,
      closedHere: new Map(),
      entries: EMPTY,
      listeners: new Set(),
      dispose: () => {}
    }
    feed = held
    feeds.set(party, held)
    let close: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let generation = 0
    const open = (): void => {
      const attempt = ++generation
      const live = () => feeds.get(party) === held && generation === attempt
      let pending: NativeChatWorkerApproval[] | undefined
      // Keeps the cards it has: the next stream sends the current list as soon as it opens.
      const lose = (error?: unknown): void => {
        if (!live()) {
          return
        }
        generation += 1
        close?.()
        close = undefined
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        if (code !== 'method_not_found' && code !== 'forbidden') {
          retry = setTimeout(open, RETRY_MS)
        }
      }
      void subscribeRuntimeRpc(
        { kind: 'local' },
        'orchestration.workerApprovalsSubscribe',
        { party },
        {
          onEvent: (value) => {
            const parsed = WorkerApprovalsFrame.safeParse(value)
            if (!live() || !parsed.success) {
              return
            }
            const frame = parsed.data
            if (frame.type === 'begin') {
              pending = []
            } else if (frame.type === 'approval') {
              pending?.push(frame.entry)
            } else if (frame.type === 'complete' && pending) {
              held.received = pending.length ? pending : EMPTY
              pending = undefined
              publish(held)
            } else if (frame.type === 'end') {
              lose()
            }
          },
          onError: lose,
          onClose: lose
        }
      ).then((handle) => {
        if (live()) {
          close = handle.unsubscribe
        } else {
          handle.unsubscribe()
        }
      }, lose)
    }
    held.dispose = () => {
      generation += 1
      clearTimeout(retry)
      close?.()
    }
    open()
  }
  const held = feed
  held.listeners.add(listener)
  return () => {
    held.listeners.delete(listener)
    // A remount in the same task keeps the stream.
    queueMicrotask(() => {
      if (held.listeners.size === 0 && feeds.get(party) === held) {
        feeds.delete(party)
        held.dispose()
      }
    })
  }
}

/** A chat coordinator's workers' approvals, oldest first, until each lapses; none for no party. */
export function useNativeChatWorkerApprovals(
  party: string | null
): readonly NativeChatWorkerApproval[] {
  const subscribe = useCallback(
    (listener: () => void) => (party ? observeWorkerApprovals(party, listener) : () => {}),
    [party]
  )
  const all = useSyncExternalStore(subscribe, () =>
    party ? (feeds.get(party)?.entries ?? EMPTY) : EMPTY
  )
  const [now, setNow] = useState(Date.now)
  const nextLapse = Math.min(
    ...all.map(({ approval }) => workerApprovalLapsesAt(approval)).filter((at) => at > now)
  )
  useEffect(() => {
    if (!Number.isFinite(nextLapse)) {
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), nextLapse - Date.now())
    return () => clearTimeout(timer)
  }, [nextLapse])
  return useMemo(
    () => all.filter(({ approval }) => workerApprovalLapsesAt(approval) > now),
    [all, now]
  )
}

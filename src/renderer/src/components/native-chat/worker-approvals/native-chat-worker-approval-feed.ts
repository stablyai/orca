import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import {
  WorkerApprovalsFrame,
  type OrchestrationWorkerApprovalEntry
} from '../../../../../shared/orchestration/orchestration-crew'
import { workerApprovalLapsesAt } from './worker-approval-card-model'

export type NativeChatWorkerApproval = OrchestrationWorkerApprovalEntry

type Feed = {
  /** The host's list, as last received. */
  received: readonly NativeChatWorkerApproval[]
  /** Prompts that closed while shown, kept pinned until then (epoch ms) so the outcome lands in view. */
  settling: Map<string, number>
  settleTimer?: ReturnType<typeof setTimeout>
  /** Above the composer: open prompts, ones only the worker's terminal can answer, and settling ones. */
  pinned: readonly NativeChatWorkerApproval[]
  /** In the transcript, at the time each was asked. */
  receipts: readonly NativeChatWorkerApproval[]
  listeners: Set<() => void>
  dispose: () => void
}

const EMPTY: readonly NativeChatWorkerApproval[] = []
// Why 5 s: a dropped local stream is rare; retry without hammering a host that refuses it.
const RETRY_MS = 5_000
// Why 4 s: long enough to read the outcome where the card was, short enough not to crowd the composer.
const SETTLE_MS = 4_000
const feeds = new Map<string, Feed>()

const signature = (entries: readonly NativeChatWorkerApproval[]): string =>
  entries
    .map(({ approval, at }) =>
      [
        approval.approvalId,
        approval.state,
        approval.outcome?.by,
        approval.outcome?.decision,
        at
      ].join('\u0000')
    )
    .join('\u0001')
const keep = (
  previous: readonly NativeChatWorkerApproval[],
  next: NativeChatWorkerApproval[]
): readonly NativeChatWorkerApproval[] =>
  signature(previous) === signature(next) ? previous : next.length ? next : EMPTY

function publish(feed: Feed): void {
  const wasOpen = new Set(
    feed.pinned.flatMap(({ approval }) => (approval.state === 'open' ? [approval.approvalId] : []))
  )
  const entries = feed.received
  const now = Date.now()
  for (const { approval } of entries) {
    if (approval.state !== 'open' && wasOpen.has(approval.approvalId)) {
      feed.settling.set(approval.approvalId, now + SETTLE_MS)
    }
  }
  for (const [approvalId, until] of feed.settling) {
    if (until <= now || !entries.some(({ approval }) => approval.approvalId === approvalId)) {
      feed.settling.delete(approvalId)
    }
  }
  const pinned = (entry: NativeChatWorkerApproval): boolean =>
    entry.approval.state === 'open' ||
    entry.approval.outcome?.by === 'terminal-only' ||
    feed.settling.has(entry.approval.approvalId)
  feed.pinned = keep(feed.pinned, entries.filter(pinned))
  feed.receipts = keep(
    feed.receipts,
    entries.filter((entry) => !pinned(entry))
  )
  clearTimeout(feed.settleTimer)
  if (feed.settling.size) {
    feed.settleTimer = setTimeout(() => publish(feed), Math.min(...feed.settling.values()) - now)
  }
  feed.listeners.forEach((notify) => notify())
}

/** One stream per chat party, shared by its transcript rows and its strip; local hosts only (v1).
 *  Not parked while hidden: a hidden coordinator tab still needs its workers' prompts. */
function observeWorkerApprovals(party: string, listener: () => void): () => void {
  let feed = feeds.get(party)
  if (!feed) {
    const held: Feed = {
      received: EMPTY,
      settling: new Map(),
      pinned: EMPTY,
      receipts: EMPTY,
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
      clearTimeout(held.settleTimer)
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

/** A chat coordinator's workers' approvals for the pinned area, oldest first; an open one leaves
 *  once its countdown lapses with no closing report. None for no party. */
export function useNativeChatPinnedWorkerApprovals(
  party: string | null
): readonly NativeChatWorkerApproval[] {
  const pinned = useFeedPart(party, 'pinned')
  const [now, setNow] = useState(Date.now)
  const nextLapse = Math.min(
    ...pinned.map(({ approval }) => workerApprovalLapsesAt(approval)).filter((at) => at > now)
  )
  useEffect(() => {
    if (!Number.isFinite(nextLapse)) {
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), nextLapse - Date.now())
    return () => clearTimeout(timer)
  }, [nextLapse])
  return useMemo(
    () => pinned.filter(({ approval }) => workerApprovalLapsesAt(approval) > now),
    [pinned, now]
  )
}

/** A chat coordinator's closed worker approvals for its transcript; the same array until one changes. */
export function useNativeChatWorkerApprovalReceipts(
  party: string | null
): readonly NativeChatWorkerApproval[] {
  return useFeedPart(party, 'receipts')
}

function useFeedPart(
  party: string | null,
  part: 'pinned' | 'receipts'
): readonly NativeChatWorkerApproval[] {
  const subscribe = useCallback(
    (listener: () => void) => (party ? observeWorkerApprovals(party, listener) : () => {}),
    [party]
  )
  return useSyncExternalStore(subscribe, () =>
    party ? (feeds.get(party)?.[part] ?? EMPTY) : EMPTY
  )
}

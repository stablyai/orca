import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { ORCHESTRATION_PAIRED_WORKER_APPROVALS_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  WorkerApprovalsFrame,
  type OrchestrationWorkerApprovalEntry
} from '../../../../../shared/orchestration/orchestration-crew'
import { workerApprovalLapsesAt } from './worker-approval-card-model'

export type NativeChatWorkerApproval = OrchestrationWorkerApprovalEntry

type Feed = {
  /** The host's list, as last received. */
  received: readonly NativeChatWorkerApproval[]
  /** Above the composer: open prompts, and ones only the worker's terminal can answer. */
  pinned: readonly NativeChatWorkerApproval[]
  /** In the transcript, at the time each was asked. */
  receipts: readonly NativeChatWorkerApproval[]
  listeners: Set<() => void>
  dispose: () => void
}

const EMPTY: readonly NativeChatWorkerApproval[] = []
// Why 5 s: a dropped stream is rare; retry without hammering a host that refuses it.
const RETRY_MS = 5_000
// An older server may be updated in place while its chat stays open.
const UNSUPPORTED_RECHECK_MS = 5 * 60_000
const feeds = new Map<string, Feed>()

const feedKey = (target: RuntimeClientTarget, party: string): string =>
  `${target.kind === 'local' ? 'local' : target.environmentId}\u0000${party}`

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

// An answered prompt goes straight to its transcript place: holding it above the composer jumped it there later.
const pinned = ({ approval }: NativeChatWorkerApproval): boolean =>
  approval.state === 'open' || approval.outcome?.by === 'terminal-only'

function publish(feed: Feed): void {
  const entries = feed.received
  feed.pinned = keep(feed.pinned, entries.filter(pinned))
  feed.receipts = keep(
    feed.receipts,
    entries.filter((entry) => !pinned(entry))
  )
  feed.listeners.forEach((notify) => notify())
}

/** One stream per chat party on its owning host, shared by its transcript rows and its strip.
 *  Not parked while hidden: a hidden coordinator tab still needs its workers' prompts. */
function observeWorkerApprovals(
  target: RuntimeClientTarget,
  party: string,
  listener: () => void
): () => void {
  const key = feedKey(target, party)
  let feed = feeds.get(key)
  if (!feed) {
    const held: Feed = {
      received: EMPTY,
      pinned: EMPTY,
      receipts: EMPTY,
      listeners: new Set(),
      dispose: () => {}
    }
    feed = held
    feeds.set(key, held)
    let close: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let generation = 0
    const open = (): void => {
      const attempt = ++generation
      const live = () => feeds.get(key) === held && generation === attempt
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
        target,
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
    const start = (): void => {
      if (target.kind === 'local') {
        open()
        return
      }
      // An older server would refuse a paired window's Allow, so its prompts stay in the worker's pane.
      runtimeEnvironmentSupportsCapability(
        target.environmentId,
        ORCHESTRATION_PAIRED_WORKER_APPROVALS_RUNTIME_CAPABILITY
      ).then(
        (supported) => {
          if (feeds.get(key) === held) {
            if (supported) {
              open()
            } else {
              retry = setTimeout(start, UNSUPPORTED_RECHECK_MS)
            }
          }
        },
        () => {
          if (feeds.get(key) === held) {
            retry = setTimeout(start, RETRY_MS)
          }
        }
      )
    }
    start()
  }
  const held = feed
  held.listeners.add(listener)
  return () => {
    held.listeners.delete(listener)
    // A remount in the same task keeps the stream.
    queueMicrotask(() => {
      if (held.listeners.size === 0 && feeds.get(key) === held) {
        feeds.delete(key)
        held.dispose()
      }
    })
  }
}

/** A chat coordinator's workers' approvals for the pinned area, oldest first; an open one leaves
 *  once its countdown lapses with no closing report. None for no party. */
export function useNativeChatPinnedWorkerApprovals(
  target: RuntimeClientTarget,
  party: string | null
): readonly NativeChatWorkerApproval[] {
  const pinned = useFeedPart(target, party, 'pinned')
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
  target: RuntimeClientTarget,
  party: string | null
): readonly NativeChatWorkerApproval[] {
  return useFeedPart(target, party, 'receipts')
}

function useFeedPart(
  target: RuntimeClientTarget,
  party: string | null,
  part: 'pinned' | 'receipts'
): readonly NativeChatWorkerApproval[] {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const subscribe = useCallback(
    (listener: () => void) =>
      party
        ? observeWorkerApprovals(
            environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
            party,
            listener
          )
        : () => {},
    [environmentId, party]
  )
  return useSyncExternalStore(subscribe, () =>
    party ? (feeds.get(feedKey(target, party))?.[part] ?? EMPTY) : EMPTY
  )
}

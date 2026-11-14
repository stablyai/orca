import { SPLIT_TERMINAL_PANE_EVENT, type SplitTerminalPaneDetail } from '@/constants/terminal'
import { BACKGROUND_WORKTREE_MEASURE_WINDOW_MS } from '../../../terminal/background-terminal-worktree-visibility'

// Why 32: ordinary use has one request; the cap tolerates automation bursts without letting a stalled renderer retain unbounded commands or mount leases.
export const TERMINAL_PANE_SPLIT_QUEUE_CAPACITY = 32

type SplitMountLease = {
  timer: ReturnType<typeof setTimeout>
  token: symbol
  tabId: string
  worktreeId?: string
}

const queuedRequests: SplitTerminalPaneDetail[] = []
const splitMountLeasesByTarget = new Map<string, SplitMountLease>()
/** Mounts held open until their holder releases them; bounded by the work in flight that holds them. */
const mountHoldsByTarget = new Map<string, { tabId: string; worktreeId: string; count: number }>()
const splitMountLeaseListeners = new Set<() => void>()
let splitMountLeaseTabIds: ReadonlySet<string> = new Set()

function notifySplitMountLeaseChange(): void {
  splitMountLeaseTabIds = new Set([
    ...[...splitMountLeasesByTarget.values()].map((lease) => lease.tabId),
    ...[...mountHoldsByTarget.values()].map((hold) => hold.tabId)
  ])
  for (const listener of splitMountLeaseListeners) {
    listener()
  }
}

function splitTargetKey(tabId: string, worktreeId: string | undefined): string {
  return `${worktreeId ?? ''}\0${tabId}`
}

function removeQueuedRequestsForTarget(tabId: string, worktreeId?: string): void {
  for (let index = queuedRequests.length - 1; index >= 0; index -= 1) {
    const request = queuedRequests[index]
    if (
      request.tabId === tabId &&
      (worktreeId === undefined || request.worktreeId === worktreeId)
    ) {
      queuedRequests.splice(index, 1)
    }
  }
}

function releaseSplitMountLease(tabId: string, worktreeId?: string, token?: symbol): void {
  let changed = false
  for (const [key, lease] of splitMountLeasesByTarget) {
    if (
      lease.tabId !== tabId ||
      (worktreeId !== undefined && lease.worktreeId !== worktreeId) ||
      (token !== undefined && lease.token !== token)
    ) {
      continue
    }
    clearTimeout(lease.timer)
    splitMountLeasesByTarget.delete(key)
    changed = true
  }
  if (changed) {
    notifySplitMountLeaseChange()
  }
}

function evictOldestSplitMountLease(): void {
  const oldest = splitMountLeasesByTarget.values().next().value as SplitMountLease | undefined
  if (!oldest) {
    return
  }
  removeQueuedRequestsForTarget(oldest.tabId, oldest.worktreeId)
  releaseSplitMountLease(oldest.tabId, oldest.worktreeId)
}

function acquireSplitMountLease(tabId: string, worktreeId?: string): void {
  const key = splitTargetKey(tabId, worktreeId)
  const existing = splitMountLeasesByTarget.get(key)
  if (existing) {
    clearTimeout(existing.timer)
    splitMountLeasesByTarget.delete(key)
  } else if (splitMountLeasesByTarget.size >= TERMINAL_PANE_SPLIT_QUEUE_CAPACITY) {
    evictOldestSplitMountLease()
  }

  const token = Symbol(tabId)
  const timer = setTimeout(() => {
    removeQueuedRequestsForTarget(tabId, worktreeId)
    releaseSplitMountLease(tabId, worktreeId, token)
  }, BACKGROUND_WORKTREE_MEASURE_WINDOW_MS)
  splitMountLeasesByTarget.set(key, { timer, token, tabId, worktreeId })
  if (!existing) {
    notifySplitMountLeaseChange()
  }
}

/** Keeps a parked tab mountable for the same bounded lease used by background terminal mounts. */
export function queueTerminalPaneSplitRequest(detail: SplitTerminalPaneDetail): void {
  if (!detail.tabId) {
    return
  }
  while (queuedRequests.length >= TERMINAL_PANE_SPLIT_QUEUE_CAPACITY) {
    queuedRequests.shift()
  }
  queuedRequests.push(detail)
  acquireSplitMountLease(detail.tabId, detail.worktreeId)
}

/** Keeps a tab mounted, parked or not, until the returned release runs: work on its live panes
 *  that outlasts a timed lease must not lose them to cold parking halfway through. */
export function holdTerminalPaneMount(tabId: string, worktreeId: string): () => void {
  const key = splitTargetKey(tabId, worktreeId)
  const hold = mountHoldsByTarget.get(key)
  if (hold) {
    hold.count += 1
  } else {
    mountHoldsByTarget.set(key, { tabId, worktreeId, count: 1 })
    notifySplitMountLeaseChange()
  }
  let released = false
  return () => {
    const current = mountHoldsByTarget.get(key)
    if (released || !current) {
      return
    }
    released = true
    current.count -= 1
    if (current.count === 0) {
      mountHoldsByTarget.delete(key)
      notifySplitMountLeaseChange()
    }
  }
}

export function takeQueuedTerminalPaneSplitRequests(
  tabId: string,
  worktreeId?: string
): SplitTerminalPaneDetail[] {
  const requests: SplitTerminalPaneDetail[] = []
  for (let index = queuedRequests.length - 1; index >= 0; index -= 1) {
    const request = queuedRequests[index]
    if (
      request.tabId !== tabId ||
      (worktreeId !== undefined &&
        request.worktreeId !== undefined &&
        request.worktreeId !== worktreeId)
    ) {
      continue
    }
    requests.unshift(request)
    queuedRequests.splice(index, 1)
  }
  return requests
}

export function cancelQueuedTerminalPaneSplitRequests(tabId: string, worktreeId?: string): void {
  removeQueuedRequestsForTarget(tabId, worktreeId)
  releaseSplitMountLease(tabId, worktreeId)
}

export function hasTerminalPaneSplitMountLease(tabId: string, worktreeId?: string): boolean {
  return [...splitMountLeasesByTarget.values(), ...mountHoldsByTarget.values()].some(
    (lease) =>
      lease.tabId === tabId && (worktreeId === undefined || lease.worktreeId === worktreeId)
  )
}

export function subscribeTerminalPaneSplitMountLeases(listener: () => void): () => void {
  splitMountLeaseListeners.add(listener)
  return () => splitMountLeaseListeners.delete(listener)
}

export function getTerminalPaneSplitMountLeaseTabIds(): ReadonlySet<string> {
  return splitMountLeaseTabIds
}

export function dispatchTerminalPaneSplitRequest(detail: SplitTerminalPaneDetail): void {
  window.dispatchEvent(
    new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, { detail })
  )
}

export function registerTerminalPaneSplitRequestHandler(
  tabId: string,
  worktreeId: string | undefined,
  handler: (detail: SplitTerminalPaneDetail) => void
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<SplitTerminalPaneDetail>).detail
    if (
      detail?.tabId === tabId &&
      (detail.worktreeId === undefined || detail.worktreeId === worktreeId)
    ) {
      handler(detail)
    }
  }
  window.addEventListener(SPLIT_TERMINAL_PANE_EVENT, listener)
  for (const detail of takeQueuedTerminalPaneSplitRequests(tabId, worktreeId)) {
    handler(detail)
  }
  return () => window.removeEventListener(SPLIT_TERMINAL_PANE_EVENT, listener)
}

export function resolveTerminalPaneSplitSourceId(
  detail: SplitTerminalPaneDetail,
  getNumericIdForLeaf: (leafId: string) => number | null
): number {
  return detail.sourceLeafId
    ? (getNumericIdForLeaf(detail.sourceLeafId) ?? -1)
    : detail.paneRuntimeId
}

export function _resetTerminalPaneSplitRequestRoutingForTests(): void {
  queuedRequests.splice(0)
  for (const lease of splitMountLeasesByTarget.values()) {
    clearTimeout(lease.timer)
  }
  splitMountLeasesByTarget.clear()
  mountHoldsByTarget.clear()
  splitMountLeaseListeners.clear()
  splitMountLeaseTabIds = new Set()
}

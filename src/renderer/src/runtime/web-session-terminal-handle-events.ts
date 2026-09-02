import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'

export type WebSessionTerminalHandleUpdate = {
  surfacePresent: boolean
  terminalHandle: string | null
}

type TerminalHandleSubscriber = {
  hostTabId: string
  leafId: string | null
  listener: (update: WebSessionTerminalHandleUpdate) => void
}

const subscribersBySession = new Map<string, Set<TerminalHandleSubscriber>>()
const pendingSnapshotBySession = new Map<
  string,
  {
    snapshot: RuntimeMobileSessionTabsResult
    eligibleSubscribers: Set<TerminalHandleSubscriber>
  }
>()

function sessionKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}\u0000${worktreeId}`
}

function resolveSubscriberUpdate(
  snapshot: RuntimeMobileSessionTabsResult,
  subscriber: TerminalHandleSubscriber
): WebSessionTerminalHandleUpdate {
  const surfaces = snapshot.tabs.filter(
    (tab): tab is RuntimeMobileSessionTerminalClientTab =>
      tab.type === 'terminal' &&
      (tab.parentTabId === subscriber.hostTabId || tab.id === subscriber.hostTabId) &&
      (!subscriber.leafId || tab.leafId === subscriber.leafId)
  )
  if (surfaces.length === 0) {
    return { surfacePresent: false, terminalHandle: null }
  }
  const mirroredSurfaces = surfaces.filter(
    (surface) => surface.parentTabId === subscriber.hostTabId
  )
  const readySurface =
    mirroredSurfaces.find((surface) => surface.status === 'ready' && surface.isActive) ??
    mirroredSurfaces.find((surface) => surface.status === 'ready')
  return {
    surfacePresent: true,
    terminalHandle: readySurface?.terminal ?? null
  }
}

export function subscribeAcceptedWebSessionTerminalHandle(
  args: {
    environmentId: string
    worktreeId: string
    hostTabId: string
    leafId?: string | null
  },
  listener: (update: WebSessionTerminalHandleUpdate) => void
): () => void {
  const key = sessionKey(args.environmentId, args.worktreeId)
  const subscribers = subscribersBySession.get(key) ?? new Set<TerminalHandleSubscriber>()
  const subscriber: TerminalHandleSubscriber = {
    hostTabId: args.hostTabId,
    leafId: args.leafId ?? null,
    listener
  }
  subscribers.add(subscriber)
  subscribersBySession.set(key, subscribers)
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) {
      subscribersBySession.delete(key)
    }
  }
}

export function queueAcceptedWebSessionTerminalSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): void {
  if (subscribersBySession.size === 0) {
    return
  }
  const key = sessionKey(environmentId, snapshot.worktree)
  const subscribers = subscribersBySession.get(key)
  if (!subscribers || subscribers.size === 0) {
    return
  }
  const pendingSnapshot = {
    snapshot,
    eligibleSubscribers: new Set(subscribers)
  }
  pendingSnapshotBySession.set(key, pendingSnapshot)
  // Why: freshness checks can run inside a Zustand updater; defer transport
  // callbacks and coalesce same-tick snapshots so only the newest fact can win.
  queueMicrotask(() => {
    if (pendingSnapshotBySession.get(key) !== pendingSnapshot) {
      return
    }
    pendingSnapshotBySession.delete(key)
    const currentSubscribers = subscribersBySession.get(key)
    for (const subscriber of pendingSnapshot.eligibleSubscribers) {
      if (currentSubscribers?.has(subscriber)) {
        subscriber.listener(resolveSubscriberUpdate(pendingSnapshot.snapshot, subscriber))
      }
    }
  })
}

export function getWebSessionTerminalHandleSubscriberCountForTests(): number {
  let count = 0
  for (const subscribers of subscribersBySession.values()) {
    count += subscribers.size
  }
  return count
}

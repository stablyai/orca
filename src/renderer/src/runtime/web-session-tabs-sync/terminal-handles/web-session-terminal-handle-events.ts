import {
  retainedTerminalSnapshotAuthority,
  retainedTerminalSnapshotPublisher,
  type RetainedTerminalSnapshotAuthority
} from '../retained-terminal-start-authority'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../../shared/runtime-mobile-session-tab-contracts'
import { hostSnapshotAffirmsWorktreeContents } from '../hydration/host-session-snapshot-authority'

export type WebSessionTerminalHandleUpdate = {
  publisher?: RetainedTerminalSnapshotAuthority
  publisherOnly?: true
  authority?: RetainedTerminalSnapshotAuthority
  /** A present but unreadable fact is unknown, never negative evidence. */
  retainedStartAbsent?: boolean
  surfacePresent: boolean
  terminalHandle: string | null
  /** The published handle's process lifetime, when the host stamps one. */
  incarnationId?: string | null
}

type TerminalHandleSubscriber = {
  hostTabId: string
  observePublisherChanges: boolean
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
  subscriber: TerminalHandleSubscriber,
  environmentId: string
): WebSessionTerminalHandleUpdate {
  const publisher = retainedTerminalSnapshotPublisher(snapshot, environmentId)
  if (!hostSnapshotAffirmsWorktreeContents(snapshot)) {
    return { publisher, publisherOnly: true, surfacePresent: false, terminalHandle: null }
  }
  const surfaces = snapshot.tabs.filter(
    (tab): tab is RuntimeMobileSessionTerminalClientTab =>
      tab.type === 'terminal' &&
      (tab.parentTabId === subscriber.hostTabId || tab.id === subscriber.hostTabId) &&
      (!subscriber.leafId || tab.leafId === subscriber.leafId)
  )
  if (surfaces.length === 0) {
    return { publisher, surfacePresent: false, terminalHandle: null }
  }
  const mirroredSurfaces = surfaces.filter(
    (surface) => surface.parentTabId === subscriber.hostTabId
  )
  const readySurface =
    mirroredSurfaces.find((surface) => surface.status === 'ready' && surface.isActive) ??
    mirroredSurfaces.find((surface) => surface.status === 'ready')
  const evidence =
    mirroredSurfaces.length === 1
      ? retainedTerminalSnapshotAuthority(snapshot, environmentId, {
          worktreeId: snapshot.worktree,
          tabId: mirroredSurfaces[0]!.parentTabId,
          leafId: mirroredSurfaces[0]!.leafId
        })
      : undefined
  return {
    ...(publisher ? { publisher } : {}),
    ...(evidence
      ? {
          authority: evidence.authority,
          retainedStartAbsent: !Object.hasOwn(evidence.row, 'retainedTerminalStart')
        }
      : {}),
    surfacePresent: true,
    terminalHandle: readySurface?.terminal ?? null,
    ...(readySurface?.incarnationId ? { incarnationId: readySurface.incarnationId } : {})
  }
}

export function subscribeAcceptedWebSessionTerminalHandle(
  args: {
    environmentId: string
    worktreeId: string
    hostTabId: string
    leafId?: string | null
    observePublisherChanges?: boolean
  },
  listener: (update: WebSessionTerminalHandleUpdate) => void
): () => void {
  const key = sessionKey(args.environmentId, args.worktreeId)
  const subscribers = subscribersBySession.get(key) ?? new Set<TerminalHandleSubscriber>()
  const subscriber: TerminalHandleSubscriber = {
    hostTabId: args.hostTabId,
    observePublisherChanges: args.observePublisherChanges === true,
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
  // Unpublished contents affirm only an accepted publisher transition, for opted-in observers.
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
  // Coalesce updater-time snapshots in a microtask so transport callbacks see committed state and newest facts.
  queueMicrotask(() => {
    if (pendingSnapshotBySession.get(key) !== pendingSnapshot) {
      return
    }
    pendingSnapshotBySession.delete(key)
    const currentSubscribers = subscribersBySession.get(key)
    for (const subscriber of pendingSnapshot.eligibleSubscribers) {
      if (
        currentSubscribers?.has(subscriber) &&
        (hostSnapshotAffirmsWorktreeContents(snapshot) ||
          (subscriber.observePublisherChanges &&
            retainedTerminalSnapshotPublisher(snapshot, environmentId)))
      ) {
        subscriber.listener(
          resolveSubscriberUpdate(pendingSnapshot.snapshot, subscriber, environmentId)
        )
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

import {
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from './runtime-provider-accounts-client'

// Why: older hosts never poll for a paired stream, so a long-lived one would freeze the meters.
const STALE_REOPEN_MS = 5 * 60_000
const RECONNECT_DELAY_MS = 5_000

/** A host that answers without usage is reachable, so "cannot reach" would be false. */
export type OwnerAccountsFailure = 'unreachable' | 'usage-not-published'

/** What a host last published about its accounts and usage, and whether it still vouches for it. */
export type OwnerAccountsState = {
  snapshot: ProviderAccountsSnapshot | null
  failure: OwnerAccountsFailure | null
}

type Stream = { state: OwnerAccountsState | null; listeners: Set<() => void>; close: () => void }

// One accounts stream per host, shared by every reader while any is mounted; no cache after that.
const streams = new Map<string, Stream>()

function publish(stream: Stream, state: OwnerAccountsState): void {
  stream.state = state
  stream.listeners.forEach((listener) => listener())
}

function snapshotState(snapshot: ProviderAccountsSnapshot): OwnerAccountsState {
  // Why: a host that predates published usage answers without it; say so, never spin, and keep its roster.
  return { snapshot, failure: snapshot.rateLimits ? null : 'usage-not-published' }
}

function connect(environmentId: string, stream: Stream): void {
  let closed = false
  const timers: ReturnType<typeof setTimeout>[] = []
  // Each open makes the host refresh stale usage.
  const reopen = (): void => {
    if (!closed) {
      stop()
      connect(environmentId, stream)
    }
  }
  const lost = (): void => {
    if (!closed) {
      // Why: losing contact must not erase what the host already vouched for.
      publish(stream, { snapshot: stream.state?.snapshot ?? null, failure: 'unreachable' })
      timers.push(setTimeout(reopen, RECONNECT_DELAY_MS))
    }
  }
  timers.push(setTimeout(reopen, STALE_REOPEN_MS))
  const watcher = watchProviderAccounts(
    { kind: 'environment', environmentId },
    {
      onSnapshot: (snapshot) => {
        if (!closed) {
          publish(stream, snapshotState(snapshot))
        }
      },
      // Why: timeout, closed stream and RPC failure all mean the owner's usage is unverifiable.
      onError: lost,
      onClosedAfterSnapshot: lost
    }
  )
  const stop = (): void => {
    closed = true
    timers.forEach(clearTimeout)
    watcher.close()
  }
  stream.close = stop
}

export function subscribeOwnerAccounts(environmentId: string, listener: () => void): () => void {
  let stream = streams.get(environmentId)
  if (!stream) {
    stream = { state: null, listeners: new Set(), close: () => {} }
    streams.set(environmentId, stream)
    connect(environmentId, stream)
  }
  const current = stream
  current.listeners.add(listener)
  return () => {
    current.listeners.delete(listener)
    if (current.listeners.size === 0 && streams.get(environmentId) === current) {
      streams.delete(environmentId)
      current.close()
    }
  }
}

export function readOwnerAccounts(environmentId: string): OwnerAccountsState | null {
  return streams.get(environmentId)?.state ?? null
}

/** A direct read of the host (forced refresh) lands where every reader sees it. */
export function applyOwnerAccountsSnapshot(
  environmentId: string,
  snapshot: ProviderAccountsSnapshot
): void {
  const stream = streams.get(environmentId)
  if (stream) {
    publish(stream, snapshotState(snapshot))
  }
}

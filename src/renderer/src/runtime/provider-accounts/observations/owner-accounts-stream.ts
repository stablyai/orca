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

/** A host's environment id, or null for this device's own live accounts and usage. */
export type OwnerAccountsKey = string | null

type Stream = {
  state: OwnerAccountsState | null
  revision: number
  listeners: Set<() => void>
  close: () => void
}

// One accounts stream per host, shared by every reader while any is mounted; no cache after that.
const streams = new Map<OwnerAccountsKey, Stream>()

function publish(stream: Stream, state: OwnerAccountsState): void {
  stream.state = state
  stream.revision += 1
  stream.listeners.forEach((listener) => listener())
}

function snapshotState(snapshot: ProviderAccountsSnapshot): OwnerAccountsState {
  // Why: a host that predates published usage answers without it; say so, never spin, and keep its roster.
  return { snapshot, failure: snapshot.rateLimits ? null : 'usage-not-published' }
}

function connect(environmentId: OwnerAccountsKey, stream: Stream): void {
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
    environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
    {
      onSnapshot: (snapshot) => {
        if (!closed) {
          publish(stream, snapshotState(snapshot))
        }
      },
      // Why: timeout, closed stream and RPC failure all mean the owner's usage is unverifiable.
      onError: lost,
      onClosedAfterSnapshot: lost
    },
    { liveLocalUsage: true }
  )
  const stop = (): void => {
    closed = true
    timers.forEach(clearTimeout)
    watcher.close()
  }
  stream.close = stop
}

export function subscribeOwnerAccounts(
  environmentId: OwnerAccountsKey,
  listener: () => void
): () => void {
  let stream = streams.get(environmentId)
  if (!stream) {
    stream = { state: null, revision: 0, listeners: new Set(), close: () => {} }
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

export function readOwnerAccounts(environmentId: OwnerAccountsKey): OwnerAccountsState | null {
  return streams.get(environmentId)?.state ?? null
}

export type OwnerAccountsStreamToken = { stream: Stream; revision: number }

export function currentOwnerAccountsStream(
  environmentId: OwnerAccountsKey
): OwnerAccountsStreamToken | null {
  const stream = streams.get(environmentId)
  return stream ? { stream, revision: stream.revision } : null
}

// Bind a direct refresh to the original subscription and its last observation.
export function applyOwnerAccountsSnapshot(
  environmentId: OwnerAccountsKey,
  snapshot: ProviderAccountsSnapshot,
  startedOn: OwnerAccountsStreamToken | null
): void {
  const stream = streams.get(environmentId)
  if (stream && stream === startedOn?.stream && stream.revision === startedOn.revision) {
    publish(stream, snapshotState(snapshot))
  }
}

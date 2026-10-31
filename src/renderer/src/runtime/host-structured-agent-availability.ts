import {
  AGENT_SESSION_AVAILABILITY_METHOD,
  decodeAgentSessionAvailabilityFrame,
  type AgentSessionAgentAvailability
} from '../../../shared/agent-session-agent-availability'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

/** One agent-health projection per host/runtime/pairing serves all workspace menus. Restart/re-pair needs a new answer; reconnect/lost readers retain received snapshots. Initial failure has no roster and differs from a received empty frame. */
export type HostStructuredAgentAvailability =
  | { state: 'pending' | 'unavailable' }
  | { state: 'received'; byAgent: ReadonlyMap<string, AgentSessionAgentAvailability> }

export type HostStructuredAgentAvailabilityOwner = {
  target: RuntimeClientTarget
  executionHostId: string
  /** Null for the local runtime. */
  runtimeId: string | null
  pairingRevision: number | undefined
}

type Resource = {
  executionHostId: string
  holders: number
  model: HostStructuredAgentAvailability
  first?: Promise<void>
  /** Set while a stream is open; a lost one reopens on the next acquire, keeping the model. */
  close: (() => void) | null
}

const NOT_READY: HostStructuredAgentAvailability = { state: 'pending' }
const resources = new Map<string, Resource>()
const listeners = new Set<() => void>()

function publish(): void {
  listeners.forEach((listener) => listener())
}

function availabilityKey(
  executionHostId: string,
  runtimeId: string | null,
  pairingRevision: number | undefined
) {
  return [executionHostId, runtimeId ?? '', pairingRevision ?? ''].join('\u0000')
}

function open(key: string, resource: Resource, target: RuntimeClientTarget): void {
  const { promise, resolve: settled } = Promise.withResolvers<void>()
  resource.first = promise
  let unsubscribe: (() => void) | null = null
  const close = (): void => {
    resource.close = null
    settled()
    unsubscribe?.()
  }
  // Only this open's stream, while its entry is current, may publish or be lost.
  const live = (): boolean => resources.get(key) === resource && resource.close === close
  const settle = (byAgent: ReadonlyMap<string, AgentSessionAgentAvailability>): void => {
    settled()
    resource.model = { state: 'received', byAgent }
    publish()
  }
  const lose = (): void => {
    if (live()) {
      close()
      if (resource.model.state === 'pending') {
        resource.model = { state: 'unavailable' }
        publish()
      }
    }
  }
  resource.close = close
  void subscribeRuntimeRpc(
    target,
    AGENT_SESSION_AVAILABILITY_METHOD,
    {},
    {
      onEvent: (frame) => {
        const byAgent = live() ? decodeAgentSessionAvailabilityFrame(frame) : null
        if (byAgent) {
          settle(byAgent)
        }
      },
      onError: lose,
      onClose: lose
    }
  ).then((handle) => {
    if (live()) {
      unsubscribe = handle.unsubscribe
    } else {
      handle.unsubscribe()
    }
  }, lose)
}

/** Holds the host's availability stream; the last holder's release closes it and keeps the
 *  snapshot. Call only for a host advertising the availability capability. */
export function acquireHostStructuredAgentAvailability(
  owner: HostStructuredAgentAvailabilityOwner
): () => void {
  const key = availabilityKey(owner.executionHostId, owner.runtimeId, owner.pairingRevision)
  let resource = resources.get(key)
  if (!resource) {
    // A retired runtime or an earlier pairing of this host is never read again.
    for (const [staleKey, stale] of resources) {
      if (stale.executionHostId === owner.executionHostId && stale.holders === 0) {
        resources.delete(staleKey)
      }
    }
    resource = { executionHostId: owner.executionHostId, holders: 0, model: NOT_READY, close: null }
    resources.set(key, resource)
  }
  if (!resource.close) {
    open(key, resource, owner.target)
  }
  const held = resource
  held.holders += 1
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    held.holders -= 1
    // Same-commit reacquisition must retain the stream; defer last-holder close to a microtask.
    queueMicrotask(() => {
      if (held.holders === 0) {
        held.close?.()
      }
    })
  }
}

/** The host's last snapshot on this runtime and pairing; not ready before its first. */
export function readHostStructuredAgentAvailability(
  executionHostId: string,
  runtimeId: string | null | undefined,
  pairingRevision: number | undefined
): HostStructuredAgentAvailability {
  return runtimeId === undefined
    ? NOT_READY
    : (resources.get(availabilityKey(executionHostId, runtimeId, pairingRevision))?.model ??
        NOT_READY)
}

export function subscribeHostStructuredAgentAvailability(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Settlement belongs to this open, even while an older snapshot is retained. */
export function firstHostStructuredAgentAvailability(
  owner: HostStructuredAgentAvailabilityOwner
): Promise<void> {
  return (
    resources.get(availabilityKey(owner.executionHostId, owner.runtimeId, owner.pairingRevision))
      ?.first ?? Promise.resolve()
  )
}

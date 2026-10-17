import {
  AGENT_SESSION_AVAILABILITY_METHOD,
  decodeAgentSessionAvailabilityFrame,
  type AgentSessionAgentAvailability
} from '../../../shared/agent-session-agent-availability'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

/**
 * Which agents can open as a chat in a workspace, as its host's availability stream last published
 * it; every + menu on that workspace reads this one projection. Keyed by host, the runtime instance
 * and the workspace, so a restarted host reads as not ready until it answers.
 *
 * Not ready until the first complete generation lands. A stream that fails or closes is ready with
 * no answers, which every agent reads as unknown: lost contact is no verdict.
 */
export type HostStructuredAgentAvailability =
  | { ready: false }
  | { ready: true; byAgent: ReadonlyMap<string, AgentSessionAgentAvailability> }

export type HostStructuredAgentAvailabilityOwner = {
  target: RuntimeClientTarget
  executionHostId: string
  /** Null for the local runtime. */
  runtimeId: string | null
  worktreeId: string
}

type Resource = {
  holders: number
  model: HostStructuredAgentAvailability
  /** Set while a stream is open; a lost one reopens on the next acquire, keeping the model. */
  close: (() => void) | null
}

const NOT_READY: HostStructuredAgentAvailability = { ready: false }
const resources = new Map<string, Resource>()
const listeners = new Set<() => void>()

function publish(): void {
  listeners.forEach((listener) => listener())
}

function availabilityKey(executionHostId: string, runtimeId: string | null, worktreeId: string) {
  return [executionHostId, runtimeId ?? '', worktreeId].join('\u0000')
}

function open(key: string, resource: Resource, owner: HostStructuredAgentAvailabilityOwner): void {
  let unsubscribe: (() => void) | null = null
  const close = (): void => {
    resource.close = null
    unsubscribe?.()
  }
  // Only this open's stream, while its workspace is held, may publish or be lost.
  const live = (): boolean => resources.get(key) === resource && resource.close === close
  const settle = (byAgent: ReadonlyMap<string, AgentSessionAgentAvailability>): void => {
    resource.model = { ready: true, byAgent }
    publish()
  }
  const lose = (): void => {
    if (live()) {
      close()
      settle(new Map())
    }
  }
  resource.close = close
  void subscribeRuntimeRpc(
    owner.target,
    AGENT_SESSION_AVAILABILITY_METHOD,
    { worktree: toRuntimeWorktreeSelector(owner.worktreeId) },
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

/** Holds the workspace's availability stream; the last holder's release closes it. Call only for a
 *  host advertising the availability capability. */
export function acquireHostStructuredAgentAvailability(
  owner: HostStructuredAgentAvailabilityOwner
): () => void {
  const key = availabilityKey(owner.executionHostId, owner.runtimeId, owner.worktreeId)
  const resource = resources.get(key) ?? { holders: 0, model: NOT_READY, close: null }
  resources.set(key, resource)
  if (!resource.close) {
    open(key, resource, owner)
  }
  resource.holders += 1
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    resource.holders -= 1
    // Why a microtask: a holder that re-acquires in the same commit keeps the answers it has.
    queueMicrotask(() => {
      if (resource.holders === 0 && resources.get(key) === resource) {
        resources.delete(key)
        resource.close?.()
        publish()
      }
    })
  }
}

/** The workspace's readiness on this runtime; not ready when nothing holds its stream. */
export function readHostStructuredAgentAvailability(
  executionHostId: string,
  runtimeId: string | null | undefined,
  worktreeId: string
): HostStructuredAgentAvailability {
  return runtimeId === undefined
    ? NOT_READY
    : (resources.get(availabilityKey(executionHostId, runtimeId, worktreeId))?.model ?? NOT_READY)
}

export function subscribeHostStructuredAgentAvailability(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

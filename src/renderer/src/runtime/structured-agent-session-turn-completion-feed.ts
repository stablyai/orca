// Share host completion/prompt edges per target without snapshots, buffers or reconnect catch-up. Status feed retains state; this feed intentionally loses outage edges. Retention would create unread obligations with nothing to retire them and relight already-read work.

import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import type { AgentSessionAttentionEdge } from '../../../shared/agent-session-attention'
import { AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeStructuredAgentSessionTurnCompletions } from './structured-agent-session-client'

export type StructuredAgentSessionTurnCompletionListener = (edge: AgentSessionAttentionEdge) => void

export type StructuredAgentSessionTurnCompletionFeedOwner = {
  activate: () => () => void
  subscribe: (listener: StructuredAgentSessionTurnCompletionListener) => () => void
}

const RECONNECT_MAX_DELAY_MS = 5_000

/** `stop` is the map's own teardown, not part of the owner contract callers hold. */
type OwnedTurnCompletionFeed = StructuredAgentSessionTurnCompletionFeedOwner & { stop: () => void }

const owners = new Map<string, OwnedTurnCompletionFeed>()

export function structuredAgentSessionTurnCompletionFeedKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

function createOwner(target: RuntimeClientTarget, key: string): OwnedTurnCompletionFeed {
  const listeners = new Map<StructuredAgentSessionTurnCompletionListener, symbol>()
  const activations = new Set<symbol>()
  // Pending probes, opens and retries belong to this epoch until deferred stop runs.
  let live = false
  let pendingFlush = false
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  const deliver = (edge: AgentSessionAttentionEdge): void => {
    // A copy, so a listener that unsubscribes mid-fanout does not skip its neighbour.
    for (const listener of Array.from(listeners.keys())) {
      try {
        listener(edge)
      } catch (error) {
        console.warn('[structured-session-completion] listener failed', error)
      }
    }
  }
  const active = (candidate: number): boolean => live && candidate === generation
  const clearReconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }
  const dropHandle = (): void => {
    handle?.unsubscribe()
    handle = null
  }
  let open = (): void => {}
  const scheduleReconnect = (candidate: number): void => {
    if (!active(candidate) || reconnectTimer) {
      return
    }
    const delay = Math.min(250 * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (active(candidate)) {
        open()
      }
    }, delay)
  }
  // Reconnect starts empty; host retains no missed-edge history to request.
  const loseConnection = (candidate: number): void => {
    if (!active(candidate)) {
      return
    }
    generation += 1
    dropHandle()
    scheduleReconnect(generation)
  }
  const subscribeToHost = (candidate: number): void => {
    void subscribeStructuredAgentSessionTurnCompletions(
      target,
      (event: AgentSessionTurnCompletionEvent) => {
        if (!active(candidate)) {
          return
        }
        if (event.type === 'end') {
          loseConnection(candidate)
          return
        }
        reconnectAttempt = 0
        // An arm this build cannot name is dropped, not handed on half-read.
        if (activations.size > 0 && (event.type === 'completion' || event.type === 'prompt')) {
          deliver(event)
        }
      },
      () => {
        if (active(candidate)) {
          loseConnection(candidate)
        }
      },
      () => {
        if (active(candidate)) {
          loseConnection(candidate)
        }
      }
    )
      .then((opened) => {
        if (active(candidate)) {
          handle = opened
        } else {
          opened.unsubscribe()
        }
      })
      .catch(() => loseConnection(candidate))
  }
  open = (): void => {
    const candidate = ++generation
    dropHandle()
    if (target.kind !== 'environment') {
      // A local host is this build; only a remote one can predate the method.
      subscribeToHost(candidate)
      return
    }
    const environmentId = target.environmentId
    void runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!active(candidate)) {
          return
        }
        // Unsupported methods stop permanently; failed probes remain retryable to avoid endless relay probing.
        if (supported) {
          subscribeToHost(candidate)
          return
        }
        console.warn(
          '[structured-session-completion] host too old for the turn-completion feed',
          environmentId
        )
      })
      .catch(() => loseConnection(candidate))
  }
  const stop = (): void => {
    live = false
    generation += 1
    clearReconnect()
    dropHandle()
    reconnectAttempt = 0
  }

  const flush = (): void => {
    if (pendingFlush) {
      return
    }
    pendingFlush = true
    queueMicrotask(() => {
      pendingFlush = false
      if (owners.get(key) !== owner) {
        return
      }
      if (activations.size === 0) {
        stop()
      }
      if (activations.size === 0 && listeners.size === 0) {
        owners.delete(key)
      }
    })
  }
  const owner: OwnedTurnCompletionFeed = {
    activate: () => {
      const token = Symbol('turn-completion-feed')
      activations.add(token)
      if (!live) {
        live = true
        open()
      }
      return () => {
        if (activations.delete(token) && activations.size === 0) {
          flush()
        }
      }
    },
    subscribe: (listener) => {
      const registration = listeners.get(listener) ?? Symbol('turn-completion-listener')
      listeners.set(listener, registration)
      return () => {
        if (listeners.get(listener) !== registration) {
          return
        }
        listeners.delete(listener)
        flush()
      }
    },
    stop: () => {
      stop()
      listeners.clear()
      activations.clear()
      pendingFlush = false
    }
  }
  return owner
}

export function getStructuredAgentSessionTurnCompletionFeed(
  target: RuntimeClientTarget
): StructuredAgentSessionTurnCompletionFeedOwner {
  const key = structuredAgentSessionTurnCompletionFeedKey(target)
  const acquire = (): OwnedTurnCompletionFeed => {
    let owner = owners.get(key)
    if (!owner) {
      owner = createOwner(target, key)
      owners.set(key, owner)
    }
    return owner
  }
  return {
    activate: () => acquire().activate(),
    subscribe: (listener) => acquire().subscribe(listener)
  }
}

export function structuredAgentSessionTurnCompletionFeedCountForTests(): number {
  return owners.size
}

export function resetStructuredAgentSessionTurnCompletionFeedsForTests(): void {
  // Stop subscription/reconnect before dropping map or unheld streams leak into the next test.
  for (const owner of owners.values()) {
    owner.stop()
  }
  owners.clear()
}

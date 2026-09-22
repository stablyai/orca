// One host turn-completion stream per runtime target, fanned out to whoever is listening.
//
// The status feed next door is a mirror: it keeps the latest summary per session so a late reader
// still learns what every session is doing. This one keeps NOTHING. A completion is an edge, and
// an edge that has already passed is not state a late reader needs — so there is no snapshot to
// hand out, no buffer, and no catch-up after a reconnect. Losing the stream means the completions
// that land while it is down are gone; the host baselines its own side and never replays them.
//
// That is deliberate. A retained completion would be a durable "unread is owed" obligation with
// nothing to retire it, and a reconnect would then light the dot for work the user already read.

import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import { AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import { subscribeStructuredAgentSessionTurnCompletions } from './structured-agent-session-client'

export type StructuredAgentSessionTurnCompletionListener = (
  completion: AgentSessionTurnCompletion
) => void

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

function createOwner(target: RuntimeClientTarget): OwnedTurnCompletionFeed {
  const listeners = new Set<StructuredAgentSessionTurnCompletionListener>()
  const activations = new Set<symbol>()
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  const deliver = (completion: AgentSessionTurnCompletion): void => {
    // A copy, so a listener that unsubscribes mid-fanout does not skip its neighbour.
    for (const listener of Array.from(listeners)) {
      try {
        listener(completion)
      } catch (error) {
        console.warn('[structured-session-completion] listener failed', error)
      }
    }
  }
  const active = (candidate: number): boolean => activations.size > 0 && candidate === generation
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
  // NO CATCH-UP: reconnecting re-opens an empty stream. Nothing asks the host what was missed,
  // because the host kept nothing to answer with.
  const loseConnection = (candidate: number): void => {
    if (candidate !== generation) {
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
        deliver(event.completion)
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
        // A host without the method is terminal, not a fault: retrying would relay-probe forever.
        // A failed probe is not an answer, so that path still reconnects.
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
    generation += 1
    clearReconnect()
    dropHandle()
    reconnectAttempt = 0
  }

  return {
    activate: () => {
      const token = Symbol('turn-completion-feed')
      activations.add(token)
      if (activations.size === 1) {
        open()
      }
      return () => {
        activations.delete(token)
        if (activations.size === 0) {
          stop()
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop
  }
}

export function getStructuredAgentSessionTurnCompletionFeed(
  target: RuntimeClientTarget
): StructuredAgentSessionTurnCompletionFeedOwner {
  const key = structuredAgentSessionTurnCompletionFeedKey(target)
  let owner = owners.get(key)
  if (!owner) {
    owner = createOwner(target)
    owners.set(key, owner)
  }
  return owner
}

export function resetStructuredAgentSessionTurnCompletionFeedsForTests(): void {
  // Dropping the map alone leaves a live subscription and its pending reconnect running into the
  // next test, where they reopen a stream nothing is holding.
  for (const owner of owners.values()) {
    owner.stop()
  }
  owners.clear()
}

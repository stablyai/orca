// One host turn-completion stream per runtime target, shared by every surface that raises
// attention for a structured chat.
//
// Unlike the status feed this owner caches nothing. A completion is an edge, not a state: there is
// no snapshot to merge, nothing to re-read on reconnect, and nothing a late listener can be told
// about. Losing the stream reconnects and the client BASELINES — completions that landed while it
// was away are dropped, not queued. That is the decided recovery policy, and the host holds its
// own half of it; a test pins this side so a later refactor cannot quietly turn it into catch-up.

import { AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  readStructuredTurnCompletionEvent,
  type StructuredTurnCompletion
} from '../../../shared/structured-turn-completion'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import { subscribeStructuredAgentSessionTurnCompletion } from './structured-agent-session-client'

export type StructuredTurnCompletionListener = (completion: StructuredTurnCompletion) => void

export type StructuredTurnCompletionFeedOwner = {
  /** Holds the stream open while any caller is activated; the last release tears it down. */
  activate: () => () => void
  subscribe: (listener: StructuredTurnCompletionListener) => () => void
}

const RECONNECT_MAX_DELAY_MS = 5_000

type OwnedCompletionFeed = StructuredTurnCompletionFeedOwner & {
  stop: () => void
}

const owners = new Map<string, OwnedCompletionFeed>()

export function structuredTurnCompletionFeedKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

function createOwner(target: RuntimeClientTarget): OwnedCompletionFeed {
  const listeners = new Set<StructuredTurnCompletionListener>()
  const activations = new Set<symbol>()
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

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
  const announce = (completion: StructuredTurnCompletion): void => {
    // A Set skips entries deleted mid-iteration, so a listener that unsubscribes itself from
    // inside its own callback is safe here.
    for (const listener of listeners) {
      try {
        listener(completion)
      } catch (error) {
        // One surface throwing must not cost every other surface its completion.
        console.warn('[structured-turn-completion] listener failed', error)
      }
    }
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
  const loseConnection = (candidate: number): void => {
    if (candidate !== generation) {
      return
    }
    generation += 1
    dropHandle()
    scheduleReconnect(generation)
  }
  const subscribeToHost = (candidate: number): void => {
    void subscribeStructuredAgentSessionTurnCompletion(
      target,
      (raw) => {
        if (!active(candidate)) {
          return
        }
        // An event this build cannot place is dropped, never coerced: inventing a verdict is how
        // a dot ends up claiming a failed turn finished well.
        const event = readStructuredTurnCompletionEvent(raw)
        if (!event) {
          return
        }
        if (event.type === 'end') {
          loseConnection(candidate)
          return
        }
        reconnectAttempt = 0
        announce(event.completion)
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
          '[structured-turn-completion] host too old for the completion feed',
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

export function getStructuredTurnCompletionFeed(
  target: RuntimeClientTarget
): StructuredTurnCompletionFeedOwner {
  const key = structuredTurnCompletionFeedKey(target)
  let owner = owners.get(key)
  if (!owner) {
    owner = createOwner(target)
    owners.set(key, owner)
  }
  return owner
}

export function resetStructuredTurnCompletionFeedsForTests(): void {
  // Dropping the map alone leaves a live subscription and its pending reconnect running into the
  // next test, where they reopen a stream nothing is holding.
  for (const owner of owners.values()) {
    owner.stop()
  }
  owners.clear()
}

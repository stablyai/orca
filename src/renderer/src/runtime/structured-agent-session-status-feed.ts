// One host status stream per runtime target, shared by every session-list projection.
//
// The feed is a read-only mirror: the host projects each session's status from its journal and
// this owner keeps the latest summary per session while anyone is looking. Losing the stream
// keeps the cached summaries and reconnects; a fresh snapshot merges over them.
// Which sessions are listed is the tab map's decision, so the feed never retracts a summary.

import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import { subscribeStructuredAgentSessionStatus } from './structured-agent-session-client'

export type StructuredAgentSessionStatusSnapshot = ReadonlyMap<string, AgentSessionStatusSummary>

export type StructuredAgentSessionStatusFeedOwner = {
  activate: () => () => void
  getSnapshot: () => StructuredAgentSessionStatusSnapshot
  subscribe: (listener: () => void) => () => void
}

const RECONNECT_MAX_DELAY_MS = 5_000

/** `stop` is the map's own teardown, not part of the owner contract callers hold. */
type OwnedStatusFeed = StructuredAgentSessionStatusFeedOwner & { stop: () => void }

const owners = new Map<string, OwnedStatusFeed>()

export function structuredAgentSessionStatusFeedKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

function createOwner(target: RuntimeClientTarget): OwnedStatusFeed {
  let snapshot: StructuredAgentSessionStatusSnapshot = new Map()
  const listeners = new Set<() => void>()
  const activations = new Set<symbol>()
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  const emit = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  const setSnapshot = (next: StructuredAgentSessionStatusSnapshot): void => {
    snapshot = next
    emit()
  }
  const applyEvent = (event: AgentSessionStatusEvent): void => {
    if (event.type === 'snapshot') {
      reconnectAttempt = 0
      // Merged, not replaced: a restarted host restores its readable sessions asynchronously, so
      // the first snapshot can be empty and dropping those rows flickers every one to no-status.
      const next = new Map(snapshot)
      for (const session of event.sessions) {
        next.set(session.sessionId, session)
      }
      setSnapshot(next)
      return
    }
    if (event.type === 'status') {
      const next = new Map(snapshot)
      next.set(event.session.sessionId, event.session)
      setSnapshot(next)
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
  const subscribeToHost = (candidate: number): void => {
    void subscribeStructuredAgentSessionStatus(
      target,
      (event) => {
        if (!active(candidate)) {
          return
        }
        if (event.type === 'end') {
          dropHandle()
          scheduleReconnect(candidate)
          return
        }
        applyEvent(event)
      },
      () => {
        if (active(candidate)) {
          dropHandle()
          scheduleReconnect(candidate)
        }
      },
      () => {
        if (active(candidate)) {
          dropHandle()
          scheduleReconnect(candidate)
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
      .catch(() => scheduleReconnect(candidate))
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
      AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!active(candidate)) {
          return
        }
        // A host without the method is terminal, not a fault: retrying would relay-probe
        // forever. A failed probe is not an answer, so that path still reconnects.
        if (supported) {
          subscribeToHost(candidate)
          return
        }
        console.warn('[structured-session-status] host too old for the status feed', environmentId)
      })
      .catch(() => scheduleReconnect(candidate))
  }
  const stop = (): void => {
    generation += 1
    clearReconnect()
    dropHandle()
    reconnectAttempt = 0
  }

  return {
    activate: () => {
      const token = Symbol('status-feed')
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
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop
  }
}

export function getStructuredAgentSessionStatusFeed(
  target: RuntimeClientTarget
): StructuredAgentSessionStatusFeedOwner {
  const key = structuredAgentSessionStatusFeedKey(target)
  let owner = owners.get(key)
  if (!owner) {
    owner = createOwner(target)
    owners.set(key, owner)
  }
  return owner
}

export function resetStructuredAgentSessionStatusFeedsForTests(): void {
  // Dropping the map alone leaves a live subscription and its pending reconnect running
  // into the next test, where they reopen a stream nothing is holding.
  for (const owner of owners.values()) {
    owner.stop()
  }
  owners.clear()
}

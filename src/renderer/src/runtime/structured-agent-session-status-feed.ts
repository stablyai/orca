// Share one read-only host status stream per target. Retain latest summaries across disconnect and merge fresh snapshots; tab maps own visibility, so this feed never retracts summaries.

import { AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-workspace-sleep'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import {
  foldAgentSessionStatusEvent,
  revokeAgentSessionStatusLive,
  type AgentSessionStatusSnapshot
} from '../../../shared/agent-session-status-snapshot-fold'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeStructuredAgentSessionStatus } from './structured-agent-session-client'

export type StructuredAgentSessionStatusSnapshot = AgentSessionStatusSnapshot

export type StructuredAgentSessionStatusFeedOwner = {
  activate: () => () => void
  getSnapshot: () => StructuredAgentSessionStatusSnapshot
  getSessionSleepState: (sessionId: string) => number | null | undefined
  getNamingActive: (sessionId: string) => boolean | null
  getSessionObservation: (sessionId: string) => 'live' | 'unverifiable'
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
  let namingActiveSessionIds: Set<string> | null = null
  const confirmedSessions = new Set<string>()
  // Disconnect revokes live execution, but each chat's last Sleep answer still holds.
  const knownSleep = new Map<string, number | null>()
  const listeners = new Set<() => void>()
  const activations = new Set<symbol>()
  let sleepResolved = false
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
      // Naming metadata precedes the full status snapshot and says nothing about Sleep.
      sleepResolved ||= event.namingActiveSessionIds === undefined
      reconnectAttempt = 0
      if (event.namingActiveSessionIds !== undefined) {
        namingActiveSessionIds = new Set(event.namingActiveSessionIds)
      }
      for (const session of event.sessions) {
        confirmedSessions.add(session.sessionId)
        knownSleep.set(
          session.sessionId,
          session.hostExecutionOwned ? null : (session.sleptAt ?? null)
        )
      }
    } else if (event.type === 'status') {
      confirmedSessions.add(event.session.sessionId)
      knownSleep.set(
        event.session.sessionId,
        event.session.hostExecutionOwned ? null : (event.session.sleptAt ?? null)
      )
    } else {
      return
    }
    setSnapshot(foldAgentSessionStatusEvent(snapshot, event))
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
  const revokeSnapshotOwnership = (): void => {
    const next = revokeAgentSessionStatusLive(snapshot)
    if (next !== snapshot) {
      setSnapshot(next)
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
  // Lost contact revokes verified execution, never proves exit or settles sessions.
  const loseConnection = (candidate: number): void => {
    if (candidate !== generation) {
      return
    }
    generation += 1
    namingActiveSessionIds = null
    confirmedSessions.clear()
    revokeSnapshotOwnership()
    emit()
    dropHandle()
    scheduleReconnect(generation)
  }
  const subscribeToHost = (candidate: number): void => {
    void subscribeStructuredAgentSessionStatus(
      target,
      (event) => {
        if (!active(candidate)) {
          return
        }
        if (event.type === 'end') {
          loseConnection(candidate)
          return
        }
        applyEvent(event)
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
    void Promise.all([
      runtimeEnvironmentSupportsCapability(
        environmentId,
        AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY
      ),
      runtimeEnvironmentSupportsCapability(
        environmentId,
        AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY
      )
    ])
      .then(([supported, marksSleep]) => {
        if (!active(candidate)) {
          return
        }
        if (!marksSleep || !supported) {
          sleepResolved = true
          emit()
        }
        // Unsupported method is final to avoid endless relay probes; failed capability probes remain retryable.
        if (supported) {
          subscribeToHost(candidate)
          return
        }
        console.warn('[structured-session-status] host too old for the status feed', environmentId)
      })
      .catch(() => loseConnection(candidate))
  }
  const stop = (): void => {
    generation += 1
    clearReconnect()
    dropHandle()
    revokeSnapshotOwnership()
    reconnectAttempt = 0
    // Teardown has no active readers; next subscription owns re-confirmation.
    namingActiveSessionIds = null
    confirmedSessions.clear()
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
    getSessionSleepState: (sessionId) => {
      const known = knownSleep.get(sessionId)
      return known !== undefined ? known : sleepResolved ? null : undefined
    },
    getNamingActive: (sessionId) => namingActiveSessionIds?.has(sessionId) ?? null,
    getSessionObservation: (sessionId) =>
      confirmedSessions.has(sessionId) ? 'live' : 'unverifiable',
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
  // Stop subscriptions/reconnects before clearing map or they reopen unheld streams in the next test.
  for (const owner of owners.values()) {
    owner.stop()
  }
  owners.clear()
}

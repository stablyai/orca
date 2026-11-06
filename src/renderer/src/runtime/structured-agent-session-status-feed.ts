// Share one read-only host status stream per target. Retain latest summaries across disconnect and merge fresh snapshots; tab maps own visibility, so this feed never retracts summaries.

import { AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-workspace-sleep'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session/agent-session-wire'
import {
  foldAgentSessionConversationNames,
  type AgentSessionConversationNames
} from '../../../shared/agent-session/agent-session-conversation-names'
import {
  AgentSessionAssociationObservation,
  applyAgentSessionStatusEvent,
  revokeAgentSessionStatusLiveInPlace,
  type AgentSessionStatusSnapshot
} from '../../../shared/agent-session/view/agent-session-status-snapshot-fold'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-attention-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeStructuredAgentSessionStatus } from './structured-agent-session-client'
import {
  createStructuredAgentSessionStatusDispatch,
  membershipChanges,
  type StructuredAgentSessionStatusChange
} from './structured-agent-session-status-dispatch'

export type StructuredAgentSessionStatusSnapshot = AgentSessionStatusSnapshot

export type { StructuredAgentSessionStatusChange }

export type StructuredAgentSessionStatusFeedOwner = {
  activate: () => () => void
  /** The live map, updated in place: read entries, never use its identity as a change signal. */
  getSnapshot: () => StructuredAgentSessionStatusSnapshot
  getNamingSnapshot: () => AgentSessionConversationNames
  getAssociationRevision: () => number
  getSessionSleepState: (sessionId: string) => number | null | undefined
  getNamingActive: (sessionId: string) => boolean | null
  getSessionObservation: (sessionId: string) => 'live' | 'unverifiable'
  /** Host-wide readers; each update says which sessions it touched. */
  subscribe: (listener: (change: StructuredAgentSessionStatusChange) => void) => () => void
  /** Per-chat readers wake only for updates touching their session. */
  subscribeSession: (sessionId: string, listener: () => void) => () => void
}

const RECONNECT_MAX_DELAY_MS = 5_000

/** `stop` is the map's own teardown, not part of the owner contract callers hold. */
type OwnedStatusFeed = StructuredAgentSessionStatusFeedOwner & { stop: () => void }

const owners = new Map<string, OwnedStatusFeed>()

export function structuredAgentSessionStatusFeedKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

function createOwner(target: RuntimeClientTarget): OwnedStatusFeed {
  // Updated in place like a keyed entity store: one session's change must not copy every retained summary.
  const snapshot = new Map<string, AgentSessionStatusSummary>()
  let names: AgentSessionConversationNames = new Map()
  const associations = new AgentSessionAssociationObservation()
  let namingActiveSessionIds: Set<string> | null = null
  const confirmedSessions = new Set<string>()
  // Disconnect revokes live execution, but each chat's last Sleep answer still holds.
  const knownSleep = new Map<string, number | null>()
  const dispatch = createStructuredAgentSessionStatusDispatch()
  const emit = dispatch.emit
  const activations = new Set<symbol>()
  let sleepResolved = false
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  const applyEvent = (event: AgentSessionStatusEvent): void => {
    const touched = new Set<string>()
    let wholeHost = false
    if (event.type === 'snapshot') {
      // Naming metadata precedes the full status snapshot and says nothing about Sleep.
      const resolvesSleep = !sleepResolved && event.namingActiveSessionIds === undefined
      sleepResolved ||= resolvesSleep
      // Resolving Sleep or first learning naming activity answers for every session, listed or not.
      wholeHost = resolvesSleep
      reconnectAttempt = 0
      if (event.namingActiveSessionIds !== undefined) {
        const next = new Set(event.namingActiveSessionIds)
        const moved = membershipChanges(namingActiveSessionIds, next)
        wholeHost ||= moved === null
        moved?.forEach((sessionId) => touched.add(sessionId))
        namingActiveSessionIds = next
      }
      // Paired-host frames are unchecked; the names fold ignores a malformed list, so must this.
      for (const note of Array.isArray(event.conversationNames) ? event.conversationNames : []) {
        if (typeof note?.sessionId === 'string') {
          touched.add(note.sessionId)
        }
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
    associations.observe(event)
    // Names stay copy-on-write: tab-name observation compares this map's identity, and it copies only on a rename.
    names = foldAgentSessionConversationNames(names, event)
    for (const sessionId of applyAgentSessionStatusEvent(snapshot, event)) {
      touched.add(sessionId)
    }
    emit(wholeHost ? null : touched)
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
  // Lost contact revokes verified execution, never proves exit or settles sessions.
  const loseConnection = (candidate: number): void => {
    if (candidate !== generation) {
      return
    }
    generation += 1
    namingActiveSessionIds = null
    confirmedSessions.clear()
    revokeAgentSessionStatusLiveInPlace(snapshot)
    emit(null)
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
    associations.renew()
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
          emit(null)
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
    reconnectAttempt = 0
    // Teardown has no active readers; next subscription owns re-confirmation.
    const observed = confirmedSessions.size > 0 || namingActiveSessionIds !== null
    namingActiveSessionIds = null
    confirmedSessions.clear()
    // Readers that outlive activation (hooks that activate conditionally) must see lost observation too.
    if (revokeAgentSessionStatusLiveInPlace(snapshot).length > 0 || observed) {
      emit(null)
    }
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
    getNamingSnapshot: () => names,
    getAssociationRevision: () => associations.revision,
    getSessionSleepState: (sessionId) => {
      const known = knownSleep.get(sessionId)
      return known !== undefined ? known : sleepResolved ? null : undefined
    },
    getNamingActive: (sessionId) => namingActiveSessionIds?.has(sessionId) ?? null,
    getSessionObservation: (sessionId) =>
      confirmedSessions.has(sessionId) ? 'live' : 'unverifiable',
    subscribe: dispatch.subscribe,
    subscribeSession: dispatch.subscribeSession,
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

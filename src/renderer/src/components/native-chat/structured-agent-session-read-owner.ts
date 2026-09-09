import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryResult
} from '../../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { NATIVE_CHAT_INITIAL_LIMIT } from './native-chat-pagination'
import { startStructuredAgentSessionReadTransport } from './structured-agent-session-read-transport'

export type StructuredAgentSessionReadSnapshot = {
  state: StructuredAgentSessionState
  loadingOlder: boolean
  providerSession?: AgentProviderSessionMetadata
}

export type StructuredAgentSessionReadOwner = {
  activate: () => () => void
  dispose: () => void
  getSnapshot: () => StructuredAgentSessionReadSnapshot
  loadOlder: () => Promise<void>
  refresh: () => void
  subscribe: (listener: () => void) => () => void
}

const owners = new Map<string, StructuredAgentSessionReadOwner>()

function countsTowardInitialHistory(item: AgentJournalRenderItem): boolean {
  return item.body.kind !== 'status' || !item.body.providerFrame
}

function ownerKey(sessionId: string, target: RuntimeClientTarget): string {
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  return `${targetKey}:${sessionId}`
}

function createReadOwner(
  key: string,
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionReadOwner {
  let snapshot: StructuredAgentSessionReadSnapshot = {
    state: EMPTY_STRUCTURED_AGENT_SESSION,
    loadingOlder: false
  }
  let stopActiveRun: (() => void) | null = null
  let refreshActiveRun = (): void => {}
  const retiredHistoryRead = (): boolean => true
  let captureActiveHistoryReadGuard = (): (() => boolean) => retiredHistoryRead
  const activations = new Set<symbol>()
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  const setSnapshot = (next: StructuredAgentSessionReadSnapshot): void => {
    if (next === snapshot) {
      return
    }
    snapshot = next
    emit()
  }
  const apply = (action: StructuredAgentSessionAction): void => {
    const state = reduceStructuredAgentSession(snapshot.state, action)
    if (state !== snapshot.state) {
      setSnapshot({ ...snapshot, state })
    }
  }
  const setProviderSession = (providerSession: AgentProviderSessionMetadata | undefined): void => {
    if (!agentProviderSessionsEqual(undefined, snapshot.providerSession, providerSession)) {
      setSnapshot({ ...snapshot, providerSession })
    }
  }
  const clearLoadingOlder = (): void => {
    if (snapshot.loadingOlder) {
      setSnapshot({ ...snapshot, loadingOlder: false })
    }
  }
  const refreshTail = async (shouldStop: () => boolean): Promise<void> => {
    const result = await callStructuredAgentSession<AgentSessionHistoryResult>(
      target,
      'agentSession.history',
      { sessionId, direction: 'tail', limit: AGENT_SESSION_HISTORY_MAX_LIMIT }
    )
    if (shouldStop()) {
      return
    }
    setProviderSession(result.providerSession)
    if (!result.ok) {
      if (shouldStop()) {
        return
      }
      apply({
        type: 'event',
        event: {
          type: 'reset',
          sessionId,
          reset: result.reset,
          page: result.page,
          fence: result.fence ?? 0
        }
      })
      return
    }
    if (shouldStop()) {
      return
    }
    apply({ type: 'tail-page', page: result.page })
    if (shouldStop()) {
      return
    }
    let restored = snapshot.state.items.filter(countsTowardInitialHistory).length
    while (snapshot.state.hasOlder && restored < NATIVE_CHAT_INITIAL_LIMIT) {
      const oldest = oldestStructuredAgentSessionCursor(snapshot.state)
      if (!oldest || shouldStop()) {
        break
      }
      const missing = NATIVE_CHAT_INITIAL_LIMIT - restored
      const older = await callStructuredAgentSession<AgentSessionHistoryResult>(
        target,
        'agentSession.history',
        {
          sessionId,
          direction: 'before',
          cursor: oldest,
          limit: Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, missing)
        }
      )
      if (shouldStop()) {
        return
      }
      if (!older.ok || older.page.window.oldest?.sequence === oldest.sequence) {
        break
      }
      if (shouldStop()) {
        return
      }
      apply({ type: 'older-page', requestedEpoch: oldest.epoch, page: older.page })
      if (shouldStop()) {
        return
      }
      restored = snapshot.state.items.filter(countsTowardInitialHistory).length
    }
  }

  const start = (): void => {
    if (snapshot.state.epoch === null) {
      apply({ type: 'loading' })
    }
    const transport = startStructuredAgentSessionReadTransport({
      applyEvent: (event) => apply({ type: 'event', event }),
      applyError: (message) => apply({ type: 'error', message }),
      getCursor: () => snapshot.state.cursor,
      onHistoryReadInvalidated: clearLoadingOlder,
      refreshTail,
      sessionId,
      target
    })
    captureActiveHistoryReadGuard = transport.captureHistoryReadGuard
    refreshActiveRun = transport.refresh
    stopActiveRun = () => {
      captureActiveHistoryReadGuard = () => retiredHistoryRead
      refreshActiveRun = (): void => {}
      transport.dispose()
      stopActiveRun = null
    }
  }

  let owner: StructuredAgentSessionReadOwner
  const deleteIfUnused = (): void => {
    if (activations.size === 0 && listeners.size === 0 && owners.get(key) === owner) {
      owners.delete(key)
    }
  }
  owner = {
    activate: () => {
      const token = Symbol(sessionId)
      activations.add(token)
      if (activations.size === 1) {
        start()
      }
      return () => {
        activations.delete(token)
        if (activations.size === 0) {
          stopActiveRun?.()
          deleteIfUnused()
        }
      }
    },
    dispose: () => {
      activations.clear()
      listeners.clear()
      stopActiveRun?.()
    },
    getSnapshot: () => snapshot,
    loadOlder: async () => {
      const shouldStop = captureActiveHistoryReadGuard()
      if (shouldStop()) {
        return
      }
      const cursor = oldestStructuredAgentSessionCursor(snapshot.state)
      if (!cursor || !snapshot.state.hasOlder || snapshot.loadingOlder) {
        return
      }
      if (shouldStop()) {
        return
      }
      setSnapshot({ ...snapshot, loadingOlder: true })
      try {
        const result = await callStructuredAgentSession<AgentSessionHistoryResult>(
          target,
          'agentSession.history',
          { sessionId, direction: 'before', cursor, limit: AGENT_SESSION_HISTORY_MAX_LIMIT }
        )
        if (shouldStop()) {
          return
        }
        if (result.ok && !shouldStop()) {
          apply({ type: 'older-page', requestedEpoch: cursor.epoch, page: result.page })
        }
      } catch (error) {
        if (!shouldStop()) {
          apply({ type: 'error', message: String(error) })
        }
      } finally {
        if (!shouldStop()) {
          clearLoadingOlder()
        }
      }
    },
    refresh: () => refreshActiveRun(),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        deleteIfUnused()
      }
    }
  }
  return owner
}

export function getStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionReadOwner {
  const key = ownerKey(sessionId, target)
  let owner = owners.get(key)
  if (!owner) {
    owner = createReadOwner(key, sessionId, target)
    owners.set(key, owner)
  }
  return owner
}

export function resetStructuredAgentSessionReadOwnersForTests(): void {
  for (const owner of owners.values()) {
    owner.dispose()
  }
  owners.clear()
}

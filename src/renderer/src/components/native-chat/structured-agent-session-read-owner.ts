import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryPage,
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
import { NATIVE_CHAT_INITIAL_LIMIT, type NativeChatOlderPageResult } from './native-chat-pagination'
import {
  OLDER_PAGE_ANCHOR_ATTEMPTS,
  readStructuredAgentSessionOlderPage
} from './structured-agent-session-older-page-read'
import { startStructuredAgentSessionReadTransport } from './structured-agent-session-read-transport'

export type StructuredAgentSessionReadSnapshot = {
  state: StructuredAgentSessionState
  loadingOlder: boolean
  /** Bumped whenever older-page reads are invalidated (open, snapshot, reset, dispose). */
  olderHistoryGeneration: number
  providerSession?: AgentProviderSessionMetadata
}

export type StructuredAgentSessionReadOwner = {
  publishCreated: (page: AgentSessionHistoryPage) => void
  activate: () => () => void
  dispose: () => void
  getSnapshot: () => StructuredAgentSessionReadSnapshot
  loadOlder: () => Promise<NativeChatOlderPageResult>
  subscribe: (listener: () => void) => () => void
}

import {
  adoptStructuredReadOwner,
  getOrCreateStructuredReadOwner,
  forgetStructuredReadOwner,
  structuredReadOwnerKey
} from './structured-agent-session-read-owner-registry'
export {
  findStructuredAgentSessionReadOwner,
  retireStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner-registry'

function countsTowardInitialHistory(item: AgentJournalRenderItem): boolean {
  return item.body.kind !== 'status' || !item.body.providerFrame
}

function createReadOwner(
  key: string,
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionReadOwner {
  let snapshot: StructuredAgentSessionReadSnapshot = {
    state: EMPTY_STRUCTURED_AGENT_SESSION,
    loadingOlder: false,
    olderHistoryGeneration: 0
  }
  let stopActiveRun: (() => void) | null = null
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
    const state = reduceStructuredAgentSession(snapshot.state, action, Date.now())
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
  const invalidateOlderPages = (): void => {
    setSnapshot({
      ...snapshot,
      loadingOlder: false,
      olderHistoryGeneration: snapshot.olderHistoryGeneration + 1
    })
  }
  const hydrate = async (shouldStop: () => boolean): Promise<void> => {
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
    apply({ type: 'history-page', page: result.page })
    if (shouldStop()) {
      return
    }
    let restored = snapshot.state.items.filter(countsTowardInitialHistory).length
    let anchorSlides = 0
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
      // A live batch that head-trimmed past the anchor makes this page discontiguous;
      // the reducer drops it, so re-anchor rather than chase a moving window forever.
      if (oldestStructuredAgentSessionCursor(snapshot.state)?.sequence !== oldest.sequence) {
        anchorSlides += 1
        if (anchorSlides >= OLDER_PAGE_ANCHOR_ATTEMPTS) {
          break
        }
        continue
      }
      apply({ type: 'older-page', requestedCursor: oldest, page: older.page })
      if (shouldStop()) {
        return
      }
      restored = snapshot.state.items.filter(countsTowardInitialHistory).length
    }
  }

  let olderPage: { shouldStop: () => boolean; promise: Promise<NativeChatOlderPageResult> } | null =
    null

  const start = (): void => {
    if (snapshot.state.epoch === null) {
      apply({ type: 'loading' })
    }
    const transport = startStructuredAgentSessionReadTransport({
      applyEvent: (event, options) => apply({ type: 'event', event, ...options }),
      applyError: (message, refusal) => {
        // Once loaded, a failure with no host refusal attached is treated as lost contact: the
        // transport retries it and the chat stays as it is. A refusal is the host's answer: shown.
        if (snapshot.state.epoch !== null && refusal === undefined) {
          return
        }
        apply({ type: 'error', message, refusal })
      },
      getCursor: () => snapshot.state.cursor,
      onHistoryReadInvalidated: invalidateOlderPages,
      hydrate: snapshot.state.epoch === null ? hydrate : undefined,
      sessionId,
      target
    })
    captureActiveHistoryReadGuard = transport.captureHistoryReadGuard
    stopActiveRun = () => {
      captureActiveHistoryReadGuard = () => retiredHistoryRead
      transport.dispose()
      stopActiveRun = null
    }
  }

  let owner: StructuredAgentSessionReadOwner
  const deleteIfUnused = (): void => {
    if (activations.size === 0 && listeners.size === 0) {
      forgetStructuredReadOwner(key, owner)
    }
  }
  owner = {
    publishCreated: (page) => {
      if (snapshot.state.epoch === null) {
        apply({ type: 'history-page', page })
      }
    },
    activate: () => {
      // Remounts and StrictMode re-run setup on an owner whose cleanup just forgot it.
      adoptStructuredReadOwner(key, owner)
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
    loadOlder: () => {
      // Concurrent callers (scroll-to-top, the button, a rail jump) share one page
      // and its result rather than reading a refusal as "no progress".
      if (olderPage && !olderPage.shouldStop()) {
        return olderPage.promise
      }
      const shouldStop = captureActiveHistoryReadGuard()
      if (shouldStop()) {
        return Promise.resolve('superseded')
      }
      if (!oldestStructuredAgentSessionCursor(snapshot.state) || !snapshot.state.hasOlder) {
        return Promise.resolve('exhausted')
      }
      setSnapshot({ ...snapshot, loadingOlder: true })
      const promise = readStructuredAgentSessionOlderPage({
        target,
        sessionId,
        getState: () => snapshot.state,
        apply,
        shouldStop
      })
      const page = { shouldStop, promise }
      olderPage = page
      void page.promise.finally(() => {
        if (olderPage !== page) {
          return
        }
        olderPage = null
        if (!shouldStop()) {
          clearLoadingOlder()
        }
      })
      return page.promise
    },
    subscribe: (listener) => {
      adoptStructuredReadOwner(key, owner)
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
  const key = structuredReadOwnerKey(sessionId, target)
  return getOrCreateStructuredReadOwner(key, () => createReadOwner(key, sessionId, target))
}

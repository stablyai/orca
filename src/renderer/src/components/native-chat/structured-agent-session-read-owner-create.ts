import { createStructuredAgentSessionReadHydrate } from './structured-agent-session-read-hydrate'
import {
  type AgentProviderSessionMetadata,
  agentProviderSessionsEqual
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction
} from '../../../../shared/agent-session/structured-agent-session-reducer'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { startStructuredAgentSessionReadTransport } from './structured-agent-session-read-transport'
import { createStructuredAgentSessionPRLinkObserver } from './structured-agent-session-pr-link-observer'

import { createStructuredAgentSessionReadActivity } from './structured-agent-session-read-activity'
import { createStructuredAgentSessionOlderPageLoader } from './structured-agent-session-older-page-loader'
import type {
  StructuredAgentSessionReadSnapshot,
  StructuredAgentSessionReadOwner,
  StructuredAgentSessionReadEffects
} from './structured-agent-session-read-owner-contract'

import {
  adoptStructuredReadOwner,
  forgetStructuredReadOwner
} from './structured-agent-session-read-owner-registry'

export function createReadOwner(
  key: string,
  sessionId: string,
  target: RuntimeClientTarget | null
): StructuredAgentSessionReadOwner {
  let snapshot: StructuredAgentSessionReadSnapshot = {
    state: EMPTY_STRUCTURED_AGENT_SESSION,
    loadingOlder: false,
    olderHistoryGeneration: 0,
    initialHistoryAutoLoad: true,
    current: false
  }
  let stopActiveRun: (() => void) | null = null
  const retiredHistoryRead = (): boolean => true
  let captureActiveHistoryReadGuard = (): (() => boolean) => retiredHistoryRead
  const activations = new Map<symbol, StructuredAgentSessionReadEffects>()
  const listeners = new Set<() => void>()
  const commandListeners = new Set<() => void>()
  const historyReaders = new Set<symbol>()
  let disposed = false
  const activity = createStructuredAgentSessionReadActivity(
    () => !disposed,
    () => snapshot.state
  )
  const observePRLinks = target
    ? createStructuredAgentSessionPRLinkObserver(sessionId, target)
    : () => {}

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
    if (
      state.submissions !== snapshot.state.submissions ||
      state.queuedMessages !== snapshot.state.queuedMessages
    ) {
      activity.observe(state)
    }
    // Published even when the frame changed nothing: a caught-up resume is an empty batch.
    const current =
      snapshot.current ||
      (action.type === 'event' &&
        action.event.type !== 'end' &&
        !(action.event.type === 'batch' && action.event.hasNewer))
    if (state !== snapshot.state || current !== snapshot.current) {
      setSnapshot({ ...snapshot, state, current })
    }
  }
  const markStale = (): void => {
    if (snapshot.current) {
      setSnapshot({ ...snapshot, current: false })
    }
  }
  const setProviderSession = (providerSession: AgentProviderSessionMetadata | undefined): void => {
    if (!agentProviderSessionsEqual(undefined, snapshot.providerSession, providerSession)) {
      setSnapshot({ ...snapshot, providerSession })
    }
  }
  const invalidateOlderPages = (): void => {
    setSnapshot({
      ...snapshot,
      loadingOlder: false,
      olderHistoryGeneration: snapshot.olderHistoryGeneration + 1
    })
  }
  const trimUnusedHistory = (): void => {
    if (disposed || historyReaders.size > 0) {
      return
    }
    const state = reduceStructuredAgentSession(snapshot.state, { type: 'trim-history' })
    if (state === snapshot.state && !snapshot.loadingOlder) {
      return
    }
    if (state.submissions !== snapshot.state.submissions) {
      activity.observe(state)
    }
    setSnapshot({
      ...snapshot,
      state,
      loadingOlder: false,
      olderHistoryGeneration: snapshot.olderHistoryGeneration + 1
    })
  }
  const trimHistory = (): void => {
    if (disposed) {
      return
    }
    if (snapshot.initialHistoryAutoLoad) {
      setSnapshot({ ...snapshot, initialHistoryAutoLoad: false })
    }
    trimUnusedHistory()
  }
  const hydrate = createStructuredAgentSessionReadHydrate({
    target,
    sessionId,
    getState: () => snapshot.state,
    apply,
    setProviderSession
  })

  const start = (effects: StructuredAgentSessionReadEffects): void => {
    if (!target) {
      return
    }
    if (snapshot.state.epoch === null) {
      apply({ type: 'loading' })
    }
    const transport = startStructuredAgentSessionReadTransport({
      subscribeRetryNow: effects.subscribeRetryNow,
      applyRequests: apply,
      applyEvent: (event, options) => {
        const lostCommands =
          snapshot.state.commands != null && 'commands' in event && event.commands === null
        apply({ type: 'event', event, ...options })
        if (
          event.type !== 'end' &&
          (event.commandsChanged || options?.opensSubscription || lostCommands)
        ) {
          commandListeners.forEach((listener) => listener())
        }
        observePRLinks(event, effects.getState)
      },
      applyError: (message, refusal) => {
        // After loading, transport failures retain history while retrying; host refusals are explicit answers to show.
        if (snapshot.state.epoch !== null && refusal === undefined) {
          return
        }
        apply({ type: 'error', message, refusal })
      },
      getCursor: () => snapshot.state.cursor,
      onContactLost: markStale,
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
      markStale()
    }
  }

  let owner: StructuredAgentSessionReadOwner
  const deleteIfUnused = (): void => {
    const subscriptions = activations.size + listeners.size + commandListeners.size
    if (subscriptions === 0 && !activity.retained()) {
      forgetStructuredReadOwner(key, owner)
    }
  }
  const subscribeTo = (collection: Set<() => void>, listener: () => void): (() => void) => {
    if (disposed) {
      return () => {}
    }
    adoptStructuredReadOwner(key, owner)
    collection.add(listener)
    return () => {
      collection.delete(listener)
      deleteIfUnused()
    }
  }
  owner = {
    trackSend: activity.trackSend,
    admit: activity.admit,
    publishCreated: (page) => {
      if (snapshot.state.epoch === null) {
        apply({ type: 'history-page', page })
      }
    },
    activate: (effects) => {
      if (disposed) {
        return () => {}
      }
      // Remounts and StrictMode re-run setup on an owner whose cleanup just forgot it.
      adoptStructuredReadOwner(key, owner)
      const token = Symbol(sessionId)
      activations.set(token, effects)
      if (activations.size === 1) {
        start(effects)
      }
      return () => {
        activations.delete(token)
        if (activations.size === 0) {
          stopActiveRun?.()
          deleteIfUnused()
        }
      }
    },
    resync: () => {
      const effects = activations.values().next().value
      if (!effects) {
        return
      }
      stopActiveRun?.()
      start(effects)
    },
    dispose: () => {
      disposed = true
      historyReaders.clear()
      activity.dispose()
      activations.clear()
      listeners.clear()
      commandListeners.clear()
      stopActiveRun?.()
    },
    getSnapshot: () => snapshot,
    trimHistory,
    retainHistory: () => {
      const reader = Symbol('history-reader')
      historyReaders.add(reader)
      return () => {
        if (historyReaders.delete(reader) && !snapshot.initialHistoryAutoLoad) {
          trimUnusedHistory()
        }
      }
    },
    subscribeCommandsChanged: (listener) => subscribeTo(commandListeners, listener),
    loadOlder: createStructuredAgentSessionOlderPageLoader({
      target,
      sessionId,
      getSnapshot: () => snapshot,
      setSnapshot,
      apply,
      captureHistoryReadGuard: () => {
        const stopped = captureActiveHistoryReadGuard()
        const generation = snapshot.olderHistoryGeneration
        return () => stopped() || generation !== snapshot.olderHistoryGeneration
      }
    }),
    subscribe: (listener) => subscribeTo(listeners, listener)
  }
  return owner
}

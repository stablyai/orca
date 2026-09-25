import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from '../../../../shared/structured-agent-session-coalescer'
import {
  AGENT_SESSION_UNATTACHED_READ_GRACE_MS,
  isUnattachedAgentSessionReadRefusal
} from '../../../../shared/structured-agent-session-read-refusal'
import { agentSessionErrorText } from '../../../../shared/agent-session-error-text'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { subscribeStructuredAgentSession } from '@/runtime/structured-agent-session-client'

function createReconnectScheduler(args: { shouldStop: () => boolean; reconnect: () => void }) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule(delay = 750): void {
      if (args.shouldStop() || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        if (!args.shouldStop()) {
          args.reconnect()
        }
      }, delay)
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

export function startStructuredAgentSessionReadTransport(args: {
  applyEvent: (event: AgentSessionSubscribeEvent) => void
  applyError: (message: string) => void
  getCursor: () => AgentJournalCursor | null
  onHistoryReadInvalidated: () => void
  hydrate?: (shouldStop: () => boolean) => Promise<void>
  sessionId: string
  target: RuntimeClientTarget
}): {
  captureHistoryReadGuard: () => () => boolean
  dispose: () => void
} {
  let stopped = false
  let connected = false
  let unattachedSince: number | null = null
  let opening = false
  let openGeneration = 0
  let stateGeneration = 0
  let unsubscribe = (): void => {}
  let shouldStopCoalescedEvent = (): boolean => true
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    if (!shouldStopCoalescedEvent()) {
      args.applyEvent(event)
    }
  })
  const reconnectScheduler = createReconnectScheduler({
    shouldStop: () => stopped || connected,
    reconnect: () => void open()
  })
  const isCurrentOpenGeneration = (candidate: number): boolean =>
    !stopped && candidate === openGeneration
  const clearUnattachedReadGrace = (): void => {
    unattachedSince = null
  }
  /**
   * A read failure, reported to the pane only once it is one.
   *
   * A refusal saying this host holds no attached session is the retry loop's own subject, not a
   * verdict: the reconnect below re-asks, and either the host opening the session or the tab
   * retirement that ends the pane resolves it. Only an older host still refuses this way. Painting the pane red inside that window turned an
   * ordinary chat close into a `Could not load conversation` the user could do nothing about.
   *
   * A window, not a mute. An unattached read still refusing past the grace is no longer
   * transitional, so the pane is owed the failure rather than a spinner that never resolves.
   */
  const reportReadFailure = (error: unknown): void => {
    if (!isUnattachedAgentSessionReadRefusal(error)) {
      clearUnattachedReadGrace()
      args.applyError(agentSessionErrorText(error))
      return
    }
    const now = Date.now()
    unattachedSince ??= now
    if (now - unattachedSince >= AGENT_SESSION_UNATTACHED_READ_GRACE_MS) {
      args.applyError(agentSessionErrorText(error))
    }
  }
  const captureHistoryReadGuard = (): (() => boolean) => {
    const readOpenGeneration = openGeneration
    const readStateGeneration = stateGeneration
    return () =>
      !isCurrentOpenGeneration(readOpenGeneration) || readStateGeneration !== stateGeneration
  }
  const handleEvent = (event: AgentSessionSubscribeEvent, eventOpenGeneration: number): void => {
    if (!isCurrentOpenGeneration(eventOpenGeneration)) {
      return
    }
    clearUnattachedReadGrace()
    if (event.type === 'snapshot' || event.type === 'reset') {
      coalescer.flush()
      if (!isCurrentOpenGeneration(eventOpenGeneration)) {
        return
      }
      stateGeneration += 1
      args.onHistoryReadInvalidated()
      if (!isCurrentOpenGeneration(eventOpenGeneration)) {
        return
      }
    } else if (event.type === 'end') {
      connected = false
      reconnectScheduler.schedule()
    }
    shouldStopCoalescedEvent = captureHistoryReadGuard()
    coalescer.push(event)
  }
  async function open(): Promise<void> {
    if (stopped || connected) {
      return
    }
    if (opening) {
      reconnectScheduler.schedule()
      return
    }
    opening = true
    coalescer.flush()
    if (stopped) {
      opening = false
      return
    }
    const currentOpenGeneration = ++openGeneration
    args.onHistoryReadInvalidated()
    unsubscribe()
    unsubscribe = (): void => {}
    try {
      if (!isCurrentOpenGeneration(currentOpenGeneration)) {
        return
      }
      let closedDuringOpen = false
      const cursor = args.getCursor()
      const handle = await subscribeStructuredAgentSession(
        args.target,
        { sessionId: args.sessionId, ...(cursor ? { cursor } : {}) },
        (event) => handleEvent(event, currentOpenGeneration),
        (error) => {
          if (!isCurrentOpenGeneration(currentOpenGeneration)) {
            return
          }
          closedDuringOpen = true
          connected = false
          reportReadFailure(error)
          reconnectScheduler.schedule()
        },
        () => {
          if (!isCurrentOpenGeneration(currentOpenGeneration)) {
            return
          }
          closedDuringOpen = true
          connected = false
          reconnectScheduler.schedule()
        }
      )
      if (!isCurrentOpenGeneration(currentOpenGeneration) || closedDuringOpen) {
        handle.unsubscribe()
        if (isCurrentOpenGeneration(currentOpenGeneration)) {
          reconnectScheduler.schedule()
        }
      } else {
        connected = true
        unsubscribe = handle.unsubscribe
      }
    } catch (error) {
      if (!isCurrentOpenGeneration(currentOpenGeneration)) {
        return
      }
      connected = false
      reportReadFailure(error)
      reconnectScheduler.schedule()
    } finally {
      if (currentOpenGeneration === openGeneration) {
        opening = false
      }
    }
  }
  if (args.hydrate) {
    const shouldStopInitialRead = captureHistoryReadGuard()
    void args
      .hydrate(shouldStopInitialRead)
      .then(() => {
        if (shouldStopInitialRead()) {
          return
        }
        clearUnattachedReadGrace()
        return open()
      })
      .catch((error) => {
        if (!shouldStopInitialRead()) {
          reportReadFailure(error)
          reconnectScheduler.schedule()
        }
      })
  } else {
    void open()
  }
  return {
    captureHistoryReadGuard,
    dispose: () => {
      stopped = true
      openGeneration += 1
      args.onHistoryReadInvalidated()
      reconnectScheduler.dispose()
      coalescer.dispose()
      unsubscribe()
    }
  }
}

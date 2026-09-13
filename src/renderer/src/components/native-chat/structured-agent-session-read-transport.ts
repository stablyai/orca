import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from '../../../../shared/structured-agent-session-coalescer'
import {
  AGENT_SESSION_UNATTACHED_READ_GRACE_MS,
  isUnattachedAgentSessionReadRefusal
} from '../../../../shared/structured-agent-session-read-refusal'
import { shouldAdvanceStructuredResumeCursor } from '../../../../shared/structured-agent-session-reducer'
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
  refreshTail: (shouldStop: () => boolean) => Promise<void>
  sessionId: string
  target: RuntimeClientTarget
}): {
  captureHistoryReadGuard: () => () => boolean
  dispose: () => void
  refresh: () => void
} {
  let stopped = false
  let connected = false
  let unattachedSince: number | null = null
  let opening = false
  let openGeneration = 0
  let stateGeneration = 0
  let unsubscribe = (): void => {}
  let resumeCursor = args.getCursor()
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
   * verdict: the reconnect below re-asks, and either the hold that attaches the session or the tab
   * retirement that ends the pane resolves it. Painting the pane red inside that window turned an
   * ordinary chat close into a `Could not load conversation` the user could do nothing about.
   *
   * A window, not a mute. An unattached read still refusing past the grace is no longer
   * transitional, so the pane is owed the failure rather than a spinner that never resolves.
   */
  const reportReadFailure = (error: unknown): void => {
    if (!isUnattachedAgentSessionReadRefusal(error)) {
      clearUnattachedReadGrace()
      args.applyError(String(error))
      return
    }
    const now = Date.now()
    unattachedSince ??= now
    if (now - unattachedSince >= AGENT_SESSION_UNATTACHED_READ_GRACE_MS) {
      args.applyError(String(error))
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
      resumeCursor = event.page.liveCursor ?? event.page.window.nextCursor
    } else if (
      event.type === 'batch' &&
      shouldAdvanceStructuredResumeCursor(resumeCursor, event.batch.cursor)
    ) {
      resumeCursor = event.batch.cursor
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
      const handle = await subscribeStructuredAgentSession(
        args.target,
        { sessionId: args.sessionId, ...(resumeCursor ? { cursor: resumeCursor } : {}) },
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
  const refresh = (): void => {
    const shouldStop = captureHistoryReadGuard()
    void args
      .refreshTail(shouldStop)
      .then(() => {
        if (shouldStop()) {
          return
        }
        clearUnattachedReadGrace()
        resumeCursor = args.getCursor()
        if (!connected) {
          reconnectScheduler.schedule(0)
        }
      })
      .catch((error) => {
        if (!shouldStop()) {
          reportReadFailure(error)
        }
      })
  }
  const shouldStopInitialRead = captureHistoryReadGuard()
  void args
    .refreshTail(shouldStopInitialRead)
    .then(() => {
      if (shouldStopInitialRead()) {
        return
      }
      clearUnattachedReadGrace()
      resumeCursor = args.getCursor()
      return open()
    })
    .catch((error) => {
      if (!shouldStopInitialRead()) {
        reportReadFailure(error)
        reconnectScheduler.schedule()
      }
    })
  return {
    captureHistoryReadGuard,
    dispose: () => {
      stopped = true
      openGeneration += 1
      args.onHistoryReadInvalidated()
      reconnectScheduler.dispose()
      coalescer.dispose()
      unsubscribe()
    },
    refresh
  }
}

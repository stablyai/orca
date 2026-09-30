import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from '../../../../shared/structured-agent-session-coalescer'
import {
  AGENT_SESSION_UNATTACHED_READ_GRACE_MS,
  isFinalAgentSessionReadRefusal,
  isUnattachedAgentSessionReadRefusal
} from '../../../../shared/structured-agent-session-read-refusal'
import type { AgentSessionRefusalReference } from '../../../../shared/agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from '../../../../shared/agent-session-write-failure'
import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { subscribeStructuredAgentSession } from '@/runtime/structured-agent-session-client'

// A stream hands its failure over as the raw `{ code, message }` payload; `String()` of that is `[object Object]`.
function readFailureText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || 'Something went wrong.'
  }
  if (typeof error === 'string') {
    return error || 'Something went wrong.'
  }
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof error.message === 'string' && error.message.length > 0) {
      return error.message
    }
    if ('code' in error && typeof error.code === 'string' && error.code.length > 0) {
      return error.code
    }
  }
  return 'Something went wrong.'
}

const RECONNECT_FIRST_DELAY_MS = 750
const RECONNECT_MAX_DELAY_MS = 30_000

/** Each reconnect waits twice the last, up to the cap, until a read delivers. */
function createReconnectScheduler(args: { shouldStop: () => boolean; reconnect: () => void }) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextDelay = RECONNECT_FIRST_DELAY_MS
  return {
    schedule(): void {
      if (args.shouldStop() || timer) {
        return
      }
      const delay = nextDelay
      nextDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
      timer = setTimeout(() => {
        timer = null
        if (!args.shouldStop()) {
          args.reconnect()
        }
      }, delay)
    },
    /** A read delivered, so the next failure is retried soon again. */
    reset(): void {
      nextDelay = RECONNECT_FIRST_DELAY_MS
    },
    /** The host is reachable again: a waiting retry runs now instead of after the grown wait. */
    retryNow(): void {
      nextDelay = RECONNECT_FIRST_DELAY_MS
      if (!timer) {
        return
      }
      clearTimeout(timer)
      timer = null
      if (!args.shouldStop()) {
        args.reconnect()
      }
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
  /** `message` is the failure's own text, for logs; `refusal` is what a surface words. */
  applyError: (message: string, refusal?: AgentSessionRefusalReference) => void
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
  // A refusal no retry reads past ends reconnecting for this run; reopening the chat starts another.
  let failedFinally = false
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
    shouldStop: () => stopped || connected || failedFinally,
    reconnect: () => void open()
  })
  // Why: an outage grows the retry wait to its cap; a host that is back should not wait it out.
  const stopHostContactWatch =
    args.target.kind === 'environment'
      ? subscribeRuntimeHostContactRegained(args.target.environmentId, () =>
          reconnectScheduler.retryNow()
        )
      : () => {}
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
  const applyReadFailure = (error: unknown): void => {
    const refusal = readAgentSessionErrorRefusal(error)
    failedFinally = isFinalAgentSessionReadRefusal(refusal)
    if (refusal) {
      args.applyError(readFailureText(error), refusal)
    } else {
      args.applyError(readFailureText(error))
    }
  }
  const reportReadFailure = (error: unknown): void => {
    if (!isUnattachedAgentSessionReadRefusal(error)) {
      clearUnattachedReadGrace()
      applyReadFailure(error)
      return
    }
    const now = Date.now()
    unattachedSince ??= now
    if (now - unattachedSince >= AGENT_SESSION_UNATTACHED_READ_GRACE_MS) {
      applyReadFailure(error)
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
    // Not on connect: a local subscribe resolves before the host's open refuses.
    if (event.type !== 'end') {
      reconnectScheduler.reset()
    }
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
      stopHostContactWatch()
      reconnectScheduler.dispose()
      coalescer.dispose()
      unsubscribe()
    }
  }
}

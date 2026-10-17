import type { AgentJournalCursor } from './agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'
import {
  AGENT_SESSION_UNATTACHED_READ_GRACE_MS,
  isFinalAgentSessionReadRefusal,
  isUnattachedAgentSessionReadRefusal
} from './structured-agent-session-read-refusal'
import type { AgentSessionRefusalReference } from './agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from './agent-session-write-failure'
import { createAgentSessionCurrentRequestsReader } from './agent-session-current-requests-reader'
import type {
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from './agent-session-current-requests-wire'
import type { StructuredAgentSessionAction } from './structured-agent-session-reducer'
import { createReconnectScheduler } from './structured-agent-session-reconnect'

/** One `agentSession.subscribe` stream, opened by whichever transport the client has. */
export type StructuredAgentSessionLiveSubscribe = (
  params: { sessionId: string; cursor?: AgentJournalCursor },
  onEvent: (event: AgentSessionSubscribeEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
) => Promise<{ unsubscribe: () => void }>

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

/**
 * The live transcript read every client shares: it reopens from the last applied cursor after the
 * stream ends or fails, waiting twice as long each time up to the cap.
 */
export function startStructuredAgentSessionLiveRead(args: {
  applyRequests?: (action: StructuredAgentSessionAction) => void
  applyEvent: (event: AgentSessionSubscribeEvent, options?: { opensSubscription: true }) => void
  /** `message` is the failure's own text, for logs; `refusal` is what a surface words. */
  applyError: (message: string, refusal?: AgentSessionRefusalReference) => void
  getCursor: () => AgentJournalCursor | null
  /** The live read is gone until a reconnect delivers: what the pane holds is stale from here. */
  onContactLost: () => void
  onHistoryReadInvalidated: () => void
  hydrate?: (shouldStop: () => boolean) => Promise<void>
  sessionId: string
  subscribe: StructuredAgentSessionLiveSubscribe
  readCurrentRequests: (
    request: AgentSessionCurrentRequestsRead
  ) => Promise<AgentSessionCurrentRequestsPiece>
  /** Calls `retryNow` when the host is likely reachable again; returns what stops listening. */
  subscribeRetryNow: (retryNow: () => void) => () => void
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
  /** The open generation whose first frame has not arrived yet. */
  let openingFrameGeneration = 0
  let stateGeneration = 0
  /** The current-request version whose failed read already reopened the subscription once. */
  let failedRequestsVersion: string | undefined
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
  const stopHostContactWatch = args.subscribeRetryNow(() => reconnectScheduler.retryNow())
  const loseContact = (): void => {
    connected = false
    // What already arrived is applied first: landing later, it would read as contact regained.
    coalescer.flush()
    requestReader.invalidate()
    args.onContactLost()
    reconnectScheduler.schedule()
  }
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
  const requestReader = createAgentSessionCurrentRequestsReader({
    read: args.readCurrentRequests,
    complete: (marker, items) => args.applyRequests?.({ type: 'requests-complete', marker, items }),
    replaceMarker: (marker) => args.applyRequests?.({ type: 'requests-marker', marker }),
    error: (error, marker) => {
      reportReadFailure(error)
      // Why: a reopen re-reads the same version, so a deterministic failure would resubscribe forever.
      if (failedRequestsVersion === marker.version) {
        return
      }
      failedRequestsVersion = marker.version
      loseContact()
    }
  })
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
      requestReader.invalidate()
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
      loseContact()
    }
    const opensSubscription = event.type !== 'end' && openingFrameGeneration === eventOpenGeneration
    if (opensSubscription) {
      openingFrameGeneration = 0
    }
    // A resumed subscription's first batch replaces state the client held while detached, so it is
    // applied alone, never merged into a later batch that would read as "unchanged".
    if (opensSubscription && event.type === 'batch') {
      coalescer.flush()
      if (isCurrentOpenGeneration(eventOpenGeneration)) {
        args.applyEvent(event, { opensSubscription: true })
        requestReader.observe(event.currentRequests)
      }
      return
    }
    shouldStopCoalescedEvent = captureHistoryReadGuard()
    coalescer.push(event)
    if (event.type !== 'end' && event.currentRequests?.sessionId === args.sessionId) {
      requestReader.observe(event.currentRequests)
    }
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
    openingFrameGeneration = currentOpenGeneration
    requestReader.invalidate()
    args.onHistoryReadInvalidated()
    unsubscribe()
    unsubscribe = (): void => {}
    try {
      if (!isCurrentOpenGeneration(currentOpenGeneration)) {
        return
      }
      let closedDuringOpen = false
      const cursor = args.getCursor()
      const handle = await args.subscribe(
        { sessionId: args.sessionId, ...(cursor ? { cursor } : {}) },
        (event) => handleEvent(event, currentOpenGeneration),
        (error) => {
          if (!isCurrentOpenGeneration(currentOpenGeneration)) {
            return
          }
          closedDuringOpen = true
          reportReadFailure(error)
          loseContact()
        },
        () => {
          if (!isCurrentOpenGeneration(currentOpenGeneration)) {
            return
          }
          closedDuringOpen = true
          loseContact()
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
      reportReadFailure(error)
      loseContact()
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
      requestReader.invalidate()
      openGeneration += 1
      args.onHistoryReadInvalidated()
      stopHostContactWatch()
      reconnectScheduler.dispose()
      coalescer.dispose()
      unsubscribe()
    }
  }
}

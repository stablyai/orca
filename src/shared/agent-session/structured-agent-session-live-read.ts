import type { AgentJournalCursor } from './journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'
import {
  type AgentSessionTextAppendCapabilities,
  createAgentSessionTextAppendReader
} from './agent-session-text-append'
import {
  AGENT_SESSION_UNATTACHED_READ_GRACE_MS,
  agentSessionReadFailureText,
  agentSessionReadInvalidArgument,
  isFinalAgentSessionReadRefusal,
  isUnattachedAgentSessionReadRefusal
} from './failures/structured-agent-session-read-refusal'
import type { AgentSessionRefusalReference } from './failures/agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from './failures/agent-session-write-failure'
import { createAgentSessionCurrentRequestsReader } from './requests/agent-session-current-requests-reader'
import type {
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from './requests/agent-session-current-requests-wire'
import type { StructuredAgentSessionAction } from './structured-agent-session-reducer'
import { createReconnectScheduler } from './structured-agent-session-reconnect'

/** One `agentSession.subscribe` stream, opened by whichever transport the client has. */
export type StructuredAgentSessionLiveSubscribe = (
  params: {
    sessionId: string
    cursor?: AgentJournalCursor
    capabilities?: AgentSessionTextAppendCapabilities
  },
  onEvent: (event: AgentSessionSubscribeEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
) => Promise<{ unsubscribe: () => void }>

/** Resume from the last applied cursor after stream end/failure with capped exponential backoff. */
export function startStructuredAgentSessionLiveRead(args: {
  applyRequests?: (action: StructuredAgentSessionAction) => void
  applyEvent: (event: AgentSessionSubscribeEvent, options?: { opensSubscription: true }) => void
  /** `message` is the failure's own text, for logs; `refusal` is what a surface words. */
  applyError: (message: string, refusal?: AgentSessionRefusalReference) => void
  getCursor: () => AgentJournalCursor | null
  /** Mark retained content stale until reconnect delivers. */
  onContactLost: () => void
  onHistoryReadInvalidated: () => void
  hydrate?: (shouldStop: () => boolean) => Promise<void>
  sessionId: string
  subscribe: StructuredAgentSessionLiveSubscribe
  /** How long streamed text batches wait to merge; defaults to the coalescer's own window. */
  coalesceMs?: number
  /** The appends the host advertises; opens wait for it, and null or a rejection means none. */
  textAppend?: Promise<AgentSessionTextAppendCapabilities | null>
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
  // Terminal refusals stop this run’s reconnects; reopening the chat starts a new run.
  let failedFinally = false
  let unattachedSince: number | null = null
  let opening = false
  let openGeneration = 0
  /** The open generation whose first frame has not arrived yet. */
  let openingFrameGeneration = 0
  let stateGeneration = 0
  let unsubscribe = (): void => {}
  let readTextAppends: ReturnType<typeof createAgentSessionTextAppendReader> | null = null
  /** An open whose stream must not be applied further; the next open replaces it. */
  let replacedOpenGeneration = 0
  // A refused append means the two sides disagree; later streams take whole items so it cannot loop.
  let appendsRefused = false
  let shouldStopCoalescedEvent = (): boolean => true
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    if (!shouldStopCoalescedEvent()) {
      args.applyEvent(event)
    }
  }, args.coalesceMs)
  const reconnectScheduler = createReconnectScheduler({
    shouldStop: () => stopped || connected || failedFinally,
    reconnect: () => void open()
  })
  // A reachable-again host should bypass outage-expanded retry delay.
  const stopHostContactWatch = args.subscribeRetryNow(() => reconnectScheduler.retryNow())
  const loseContact = (): void => {
    connected = false
    // Flush before marking contact lost or buffered frames would appear to restore contact.
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
  /** Older hosts can transiently refuse reads during attach/close. Reconnect through the grace window;
   * report persistent refusal afterwards instead of leaving an endless spinner. */
  const applyReadFailure = (error: unknown): void => {
    const refusal = readAgentSessionErrorRefusal(error)
    failedFinally = isFinalAgentSessionReadRefusal(refusal)
    if (refusal) {
      args.applyError(agentSessionReadFailureText(error), refusal)
    } else {
      args.applyError(agentSessionReadFailureText(error))
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
    error: reportReadFailure
  })
  /** Resume from the last applied cursor on a new stream, which starts with whole items. */
  const replaceStream = (eventOpenGeneration: number): void => {
    replacedOpenGeneration = eventOpenGeneration
    appendsRefused = true
    if (!connected) {
      // Still opening: retry later; the open drops its handle when it lands.
      loseContact()
      return
    }
    unsubscribe()
    unsubscribe = (): void => {}
    connected = false
    void open()
  }
  const handleEvent = (received: AgentSessionSubscribeEvent, eventOpenGeneration: number): void => {
    if (
      !isCurrentOpenGeneration(eventOpenGeneration) ||
      eventOpenGeneration === replacedOpenGeneration
    ) {
      return
    }
    const event = readTextAppends ? readTextAppends(received) : received
    if (!event) {
      replaceStream(eventOpenGeneration)
      return
    }
    clearUnattachedReadGrace()
    // Reset on delivered frames; local subscribe can resolve before the host refuses opening.
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
    // First resumed batch replaces detached state; apply alone so coalescing cannot turn it into unchanged state.
    if (opensSubscription) {
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
    let textAppend: AgentSessionTextAppendCapabilities | null = null
    // A host replaced by an older build refuses the capabilities param; reopen without it.
    const refuseAppendsOn = (error: unknown): void => {
      appendsRefused ||= textAppend !== null && agentSessionReadInvalidArgument(error)
    }
    try {
      // Local desktop reads pass none, so their subscribe still goes out in the same turn.
      // A failed support check means no appends; it must not keep the transcript closed.
      textAppend =
        args.textAppend && !appendsRefused ? await args.textAppend.catch(() => null) : null
      if (!isCurrentOpenGeneration(currentOpenGeneration)) {
        return
      }
      let closedDuringOpen = false
      const cursor = args.getCursor()
      readTextAppends = textAppend ? createAgentSessionTextAppendReader(textAppend) : null
      const handle = await args.subscribe(
        {
          sessionId: args.sessionId,
          ...(cursor ? { cursor } : {}),
          ...(textAppend ? { capabilities: textAppend } : {})
        },
        (event) => handleEvent(event, currentOpenGeneration),
        (error) => {
          if (!isCurrentOpenGeneration(currentOpenGeneration)) {
            return
          }
          closedDuringOpen = true
          refuseAppendsOn(error)
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
      if (
        !isCurrentOpenGeneration(currentOpenGeneration) ||
        closedDuringOpen ||
        replacedOpenGeneration === currentOpenGeneration
      ) {
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
      refuseAppendsOn(error)
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

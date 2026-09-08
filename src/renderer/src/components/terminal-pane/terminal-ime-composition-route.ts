import type { IDisposable, Terminal } from '@xterm/xterm'
import type { PtyTransport } from './pty-transport'

export const XTERM_COMPOSITION_SESSION_START_EVENT = 'xterm-composition-session-start'
export const XTERM_COMPOSITION_SESSION_END_EVENT = 'xterm-composition-session-end'

export type TerminalImeCompositionSessionDetail = {
  id: number
  data?: string
  dataPendingReconciliation?: boolean
}

type CapturedCompositionSession = {
  ptyId: string | null
}

export type TerminalImeCompositionSessionSnapshot = ReadonlySet<number>

// Reference-counted per session id, not a bare per-element count: a caller waiting on a
// composition must be able to tell its own sessions from ones that started after it, and two
// overlapping routes can own the same session without clearing each other's pending state.
const pendingCompositionSessionCountsByElement = new WeakMap<HTMLElement, Map<number, number>>()

function addPendingCompositionSession(terminalElement: HTMLElement, sessionId: number): void {
  const sessionCounts = pendingCompositionSessionCountsByElement.get(terminalElement) ?? new Map()
  sessionCounts.set(sessionId, (sessionCounts.get(sessionId) ?? 0) + 1)
  pendingCompositionSessionCountsByElement.set(terminalElement, sessionCounts)
}

function removePendingCompositionSession(terminalElement: HTMLElement, sessionId: number): void {
  const sessionCounts = pendingCompositionSessionCountsByElement.get(terminalElement)
  const count = sessionCounts?.get(sessionId)
  if (!sessionCounts || count === undefined) {
    return
  }
  if (count > 1) {
    sessionCounts.set(sessionId, count - 1)
  } else {
    sessionCounts.delete(sessionId)
  }
  if (!sessionCounts.size) {
    pendingCompositionSessionCountsByElement.delete(terminalElement)
  }
}

export function capturePendingTerminalImeCompositionSessions(
  terminalElement: HTMLElement | null | undefined
): TerminalImeCompositionSessionSnapshot {
  if (!terminalElement) {
    return new Set()
  }
  return new Set(pendingCompositionSessionCountsByElement.get(terminalElement)?.keys())
}

/** With a snapshot, only the sessions it captured count as pending. */
export function hasPendingTerminalImeComposition(
  terminalElement: HTMLElement | null | undefined,
  snapshot?: TerminalImeCompositionSessionSnapshot
): boolean {
  if (!terminalElement) {
    return false
  }
  const sessionCounts = pendingCompositionSessionCountsByElement.get(terminalElement)
  if (!sessionCounts) {
    return false
  }
  if (!snapshot) {
    return true
  }
  for (const sessionId of snapshot) {
    if (sessionCounts.has(sessionId)) {
      return true
    }
  }
  return false
}

export function readTerminalImeCompositionSessionDetail(
  event: Event
): TerminalImeCompositionSessionDetail | null {
  if (!(event instanceof CustomEvent)) {
    return null
  }
  const detail = event.detail as Partial<TerminalImeCompositionSessionDetail> | null
  if (!detail) {
    return null
  }
  const id = detail.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    return null
  }
  return {
    id,
    data: typeof detail.data === 'string' ? detail.data : undefined,
    dataPendingReconciliation: detail.dataPendingReconciliation === true
  }
}

export function installTerminalImeCompositionRoute(args: {
  terminalElement: HTMLElement | null | undefined
  terminal: Pick<Terminal, 'input'>
  capturedTransport: PtyTransport
  getCurrentTransport: () => PtyTransport | undefined
}): IDisposable {
  const terminalElement = args.terminalElement
  const sessions = new Map<number, CapturedCompositionSession>()
  let disposed = false

  if (
    !terminalElement ||
    typeof terminalElement.addEventListener !== 'function' ||
    typeof terminalElement.removeEventListener !== 'function'
  ) {
    return { dispose: () => undefined }
  }

  const onSessionStart = (event: Event): void => {
    const detail = readTerminalImeCompositionSessionDetail(event)
    if (!detail || disposed) {
      return
    }
    if (!sessions.has(detail.id)) {
      addPendingCompositionSession(terminalElement, detail.id)
    }
    sessions.set(detail.id, {
      ptyId: args.capturedTransport.getPtyId()
    })
  }

  const onSessionEnd = (event: Event): void => {
    const detail = readTerminalImeCompositionSessionDetail(event)
    if (!detail) {
      return
    }
    const captured = sessions.get(detail.id)
    if (!captured) {
      // Not our session — the route was installed mid-composition, so no start was seen.
      // Cancelling here would suppress xterm's own insertion with nothing to replace it.
      return
    }
    // Owned, so xterm stands down even on the drop paths below: that drop is this route's call.
    event.preventDefault()
    sessions.delete(detail.id)
    removePendingCompositionSession(terminalElement, detail.id)
    if (
      disposed ||
      detail.dataPendingReconciliation ||
      !detail.data ||
      captured.ptyId === null ||
      args.getCurrentTransport() !== args.capturedTransport ||
      args.capturedTransport.getPtyId() !== captured.ptyId
    ) {
      return
    }
    args.terminal.input(detail.data)
  }

  terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, onSessionStart)
  terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd)

  return {
    dispose: () => {
      disposed = true
      for (const sessionId of sessions.keys()) {
        removePendingCompositionSession(terminalElement, sessionId)
      }
      sessions.clear()
      terminalElement.removeEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, onSessionStart)
      terminalElement.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd)
    }
  }
}

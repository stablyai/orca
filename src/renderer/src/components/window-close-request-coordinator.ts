/** App owns the close subscription even without Terminal mounted (#5144); run unsaved-work guards, then rich confirmation or the landing-page fallback. */

import { showShutdownCheckpointFailureToast } from '@/lib/shutdown-checkpoint-failure-toast'

export type WindowCloseRequestHandler = (data: { isQuitting: boolean }) => void

export type WindowCloseGuard = () => boolean | Promise<boolean>

let activeHandler: WindowCloseRequestHandler | null = null
// Explicit app quits may degrade durable-session checkpoints to avoid trapping the user (#15352); arbitrary unload remains strict.
let windowCloseCheckpointInProgress = false

export function isWindowCloseCheckpointInProgress(): boolean {
  return windowCloseCheckpointInProgress
}

export function runWithWindowCloseCheckpointScope<T>(fn: () => T): T {
  windowCloseCheckpointInProgress = true
  try {
    return fn()
  } finally {
    windowCloseCheckpointInProgress = false
  }
}
const closeGuards = new Set<WindowCloseGuard>()
// Ignore repeated close requests while a guard’s dialog is pending.
let closeInFlight = false

/** Unmounting Terminal hands rich close handling back to App’s fallback. */
export function setWindowCloseRequestHandler(handler: WindowCloseRequestHandler | null): void {
  activeHandler = handler
}

export function getWindowCloseRequestHandler(): WindowCloseRequestHandler | null {
  return activeHandler
}

export function registerWindowCloseGuard(guard: WindowCloseGuard): () => void {
  closeGuards.add(guard)
  return () => {
    closeGuards.delete(guard)
  }
}

async function runWindowCloseGuards(): Promise<boolean> {
  for (const guard of closeGuards) {
    if (!(await guard())) {
      return false
    }
  }
  return true
}

/** Run pre-close guards, then the mounted rich handler; with no workbench, confirm directly because no tabs need protection (#5144). */
export async function dispatchWindowCloseRequest(data: { isQuitting: boolean }): Promise<void> {
  if (closeInFlight) {
    return
  }
  closeInFlight = true
  try {
    if (!(await runWindowCloseGuards())) {
      return
    }
  } finally {
    closeInFlight = false
  }
  if (activeHandler) {
    activeHandler(data)
    return
  }
  const accepted = runWithWindowCloseCheckpointScope(() =>
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
  )
  if (accepted) {
    window.api.ui.confirmWindowClose()
    return
  }
  showShutdownCheckpointFailureToast()
}

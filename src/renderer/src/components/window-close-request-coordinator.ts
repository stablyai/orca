/** App owns the close subscription even without Terminal mounted (#5144); run unsaved-work guards, then rich confirmation or the landing-page fallback. */

import { showShutdownCheckpointFailureToast } from '@/app-shell/shutdown/shutdown-checkpoint-failure-toast'
import {
  formatShutdownCheckpointFailureReason,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
  publishShutdownCheckpointFailureReason
} from '../../../shared/app-lifecycle/shutdown/renderer-shutdown-events'

export type WindowCloseRequestHandler = (data: { isQuitting: boolean }) => void

export type WindowCloseGuard = () => boolean | Promise<boolean>

let activeHandler: WindowCloseRequestHandler | null = null
// Explicit app quits may degrade durable-session checkpoints to avoid trapping the user (#15352); arbitrary unload remains strict.
let windowCloseCheckpointInProgress = false

// A second failed durable write closes anyway, as before this wait existed, so a broken disk cannot trap quit.
let durableCloseCheckpointFailed = false

export function isWindowCloseCheckpointInProgress(): boolean {
  return windowCloseCheckpointInProgress
}

let pendingCloseCheckpoint: Promise<boolean> | null = null

/** Null means an earlier close already awaits this write; main counts its answer for the newer request too. */
export async function prepareWindowCloseCheckpoint(): Promise<boolean | null> {
  if (pendingCloseCheckpoint) {
    await pendingCloseCheckpoint
    return null
  }
  pendingCloseCheckpoint = stageWindowCloseCheckpoint()
  try {
    return await pendingCloseCheckpoint
  } finally {
    pendingCloseCheckpoint = null
  }
}

/** Close proceeds only after the checkpoint it staged is durable; a failed write cancels the close once. */
async function stageWindowCloseCheckpoint(): Promise<boolean> {
  windowCloseCheckpointInProgress = true
  let accepted: boolean
  try {
    accepted = window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
  } finally {
    windowCloseCheckpointInProgress = false
  }
  if (!accepted) {
    return false
  }
  try {
    await window.api.app.awaitBeforeUnloadCheckpoint()
    durableCloseCheckpointFailed = false
    return true
  } catch (error) {
    if (durableCloseCheckpointFailed) {
      console.error('[app] Session snapshot still could not be saved; closing anyway', error)
      return true
    }
    durableCloseCheckpointFailed = true
    publishShutdownCheckpointFailureReason(formatShutdownCheckpointFailureReason(error))
    // Re-stage on the next close attempt instead of trusting the failed checkpoint.
    window.dispatchEvent(new Event(ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT))
    return false
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
      window.api.ui.cancelWindowClose()
      return
    }
    if (activeHandler) {
      activeHandler(data)
      return
    }
    const accepted = await prepareWindowCloseCheckpoint()
    if (accepted === null) {
      return
    }
    if (accepted) {
      window.api.ui.confirmWindowClose()
      return
    }
    showShutdownCheckpointFailureToast()
    window.api.ui.cancelWindowClose()
  } finally {
    closeInFlight = false
  }
}

import { readStoppedSwitchSource, watchStoppedSwitchSource } from '../stopped-switch-sources'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * A `closing` exit keeps the stopped process's screen for the replace that should remove its tab.
 * If main says no replace removed it, the pane takes the ordinary exited state: the overlay with
 * Restart and Close, at the exit code it recorded, never an automatic close or restart.
 */
export function holdClosingExit(
  session: ConnectPanePtySession,
  ptyId: string,
  exitCode: number,
  incarnationId: string | null = session.inputModeOwnerIncarnationId ?? null
): void {
  session.stopWatchingStoppedSwitchSource?.()
  session.stopWatchingStoppedSwitchSource = watchStoppedSwitchSource(
    { tabId: session.deps.tabId, leafId: session.pane.leafId, ptyId, incarnationId, exitCode },
    () => {
      session.stopWatchingStoppedSwitchSource = null
      if (session.disposed || session.handledExitPtyId !== ptyId) {
        return
      }
      session.clearExitedPanePtyLayoutBinding(ptyId)
      session.deps.clearTabPtyId(session.deps.tabId, ptyId)
      session.deps.onPaneProcessDied?.({
        paneId: session.pane.id,
        exitCode,
        startup: null,
        reason: 'process-failed'
      })
    }
  )
}

/**
 * A pane remounting onto a process a switch stopped (its exit was handled before it was parked)
 * has nothing to reattach: it stays stopped and takes main's settlement, as it would have mounted.
 */
export function remountStoppedSwitchSource(
  session: ConnectPanePtySession,
  ptyId: string | null
): boolean {
  const stopped = ptyId
    ? readStoppedSwitchSource(session.deps.tabId, session.pane.leafId, ptyId)
    : null
  if (!ptyId || !stopped) {
    return false
  }
  session.handledExitPtyId = ptyId
  holdClosingExit(session, ptyId, stopped.exitCode, stopped.incarnationId)
  return true
}

import {
  readMirroredStoppedSwitchSource,
  readStoppedSwitchSource,
  watchStoppedSwitchSource
} from '../stopped-switch-sources'
import type { AiVaultAgent } from '../../../../../shared/ai-vault-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** The pane takes the stopped state: the overlay naming the agent, with Restart and Close. */
export function showSwitchStoppedPane(
  session: ConnectPanePtySession,
  ptyId: string,
  exitCode: number,
  agent: AiVaultAgent | undefined
): void {
  session.deps.onPaneProcessDied?.({
    paneId: session.pane.id,
    exitCode,
    startup: null,
    reason: 'switch-stopped',
    replacesPtyId: ptyId,
    ...(agent ? { agent } : {})
  })
}

/**
 * A `closing` exit keeps the stopped process's screen for the replace that should remove its tab.
 * If main says no replace removed it, the pane takes the exited state: the overlay naming the
 * stopped agent, with Restart (a fresh shell here) and Close, never an automatic close or restart.
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
    (notice) => {
      session.stopWatchingStoppedSwitchSource = null
      if (session.disposed || session.handledExitPtyId !== ptyId) {
        return
      }
      session.clearExitedPanePtyLayoutBinding(ptyId)
      session.deps.clearTabPtyId(session.deps.tabId, ptyId)
      // Main keeps a `closing` stop's binding, so a Restart must name the stopped process as the
      // one it replaces; otherwise main reattaches to it and finds its session killed.
      // Only a switch's stop is named as one; a close that stopped it exits as any pane does.
      if (notice.switched) {
        showSwitchStoppedPane(session, ptyId, exitCode, notice.switched.agent)
      } else {
        session.deps.onPaneProcessDied?.({
          paneId: session.pane.id,
          exitCode,
          startup: null,
          reason: 'process-failed',
          replacesPtyId: ptyId
        })
      }
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
  if (!ptyId) {
    return false
  }
  const { tabId } = session.deps
  const { leafId } = session.pane
  // A paired client's leaf stays bound to the stopped process by main's frame: no attach, no hold.
  const mirrored = readMirroredStoppedSwitchSource(tabId, leafId, ptyId)
  const stopped = mirrored ? null : readStoppedSwitchSource(tabId, leafId, ptyId)
  if (mirrored) {
    session.handledExitPtyId = ptyId
    showSwitchStoppedPane(session, ptyId, 0, mirrored.agent)
  } else if (stopped) {
    session.handledExitPtyId = ptyId
    holdClosingExit(session, ptyId, stopped.exitCode, stopped.incarnationId)
  }
  return Boolean(mirrored || stopped)
}

import {
  readMirroredStoppedSwitchSource,
  readStoppedSwitchSource,
  watchStoppedSwitchSource
} from '../stopped-switch-sources'
import type { AiVaultAgent } from '../../../../../shared/ai-vault-types'
import type { StoppedSwitchSourceScreen } from '../../../../../shared/stopped-switch-source'
import {
  RELEASE_SYNCHRONIZED_OUTPUT,
  RESET_GRAPHIC_RENDITION
} from '../../../../../shared/terminal-mode-reset-profiles'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions
} from '../terminal-snapshot-replay-paint'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * Main's held screen replaces the visible frame of an xterm that didn't see the stop (nothing after
 * a reload, an older frame after a park), at the grid it was captured on. Saved lines stay: ED 3
 * would erase the conversation a viewer can still scroll. Nothing attaches; no process is resized.
 */
function paintStoppedScreen(session: ConnectPanePtySession, screen: StoppedSwitchSourceScreen) {
  const { terminal } = session.pane
  if (
    hasPositiveTerminalDimensions(screen.cols, screen.rows) &&
    (terminal.cols !== screen.cols || terminal.rows !== screen.rows)
  ) {
    session.suppressStructuralReplayPtyResize = true
    try {
      terminal.resize(screen.cols, screen.rows)
    } finally {
      session.suppressStructuralReplayPtyResize = false
    }
  }
  session.writeReplayData(`${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[H`)
  const paneOnAlternateScreen = session.isPaneOnAlternateScreen()
  // Captured screen-only (no history rows), so nothing in it replaces the lines saved above.
  for (const chunk of buildMainModelSnapshotReplayWrites(screen, {
    paneOnAlternateScreen,
    carriesHistory: false
  })) {
    session.writeReplayData(chunk)
  }
}

/**
 * The pane takes the stopped state: the overlay naming the agent, with Restart and Close. A pane
 * that saw the stop already shows that process's output up to the hold; only one that didn't
 * (`repaint`: a remount or a new viewer) takes main's held screen.
 */
export function showSwitchStoppedPane(
  session: ConnectPanePtySession,
  ptyId: string,
  exitCode: number,
  stopped: { agent?: AiVaultAgent; screen?: StoppedSwitchSourceScreen } | undefined,
  repaint: boolean
): void {
  const agent = stopped?.agent
  if (repaint && stopped?.screen) {
    paintStoppedScreen(session, stopped.screen)
  }
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
  remount?: { incarnationId: string | null }
): void {
  const incarnationId = remount
    ? remount.incarnationId
    : (session.inputModeOwnerIncarnationId ?? null)
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
        showSwitchStoppedPane(session, ptyId, exitCode, notice.switched, Boolean(remount))
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
    showSwitchStoppedPane(session, ptyId, 0, mirrored, true)
  } else if (stopped) {
    session.handledExitPtyId = ptyId
    holdClosingExit(session, ptyId, stopped.exitCode, { incarnationId: stopped.incarnationId })
  }
  return Boolean(mirrored || stopped)
}

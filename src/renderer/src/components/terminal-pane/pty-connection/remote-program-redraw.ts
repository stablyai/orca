import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import {
  TERMINAL_VIEWPORT_MIN_ROWS,
  clampTerminalViewport
} from '../../../../../shared/terminal-viewport'
import { onOverrideChange } from '@/lib/pane-manager/mobile-fit-overrides'
import { recordTerminalFreezeBreadcrumb } from '../terminal-freeze-breadcrumbs'
import { redactPtyIdForDiagnostics } from '../../../../../shared/pty-delivery-diagnostics'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why: the two resizes must reach the program as separate SIGWINCHs. Node's tty (Claude Code,
// Codex) re-reads the size on SIGWINCH and repaints only if it changed, so the put-back waits
// this long after the host confirmed the short grid, not after the client sent it.
export const REMOTE_PROGRAM_REDRAW_RESTORE_MS = 250
// Why: hosts that predate desktop fit answers never confirm; put the row back anyway.
export const REMOTE_PROGRAM_REDRAW_ACK_TIMEOUT_MS = 2_000

/**
 * The one place a remote pane asks its program to repaint after the host could not give the
 * pane a screen image (#26887). An idle TUI only writes diffs, so without this the pane keeps
 * whatever frame it had before the disconnect until the user happens to resize.
 */
export function bindRemoteProgramRedraw(session: ConnectPanePtySession): void {
  session.remoteProgramRedrawRestore = null

  session.remoteProgramRedrawPtyId = null

  session.requestRemoteProgramRedraw = function (reason: string): void {
    const ptyId = session.transport.getPtyId()
    if (session.remoteProgramRedrawRestore !== null && session.remoteProgramRedrawPtyId !== ptyId) {
      // Why: a nudge for a swapped-out PTY must not hold off the new one's redraw.
      session.remoteProgramRedrawRestore()
    }
    if (
      session.disposed ||
      !ptyId ||
      !isRemoteRuntimePtyId(ptyId) ||
      session.remoteProgramRedrawRestore !== null ||
      // Why: a claim sent while the stream is recovering is only deferred, and recovery replays
      // just the last grid, so the short one would never reach the program.
      !session.transport.isConnected() ||
      // Why: a hidden pane's grid is not authoritative, and a phone or another desktop that holds
      // the size must not have it taken; the repaint those viewers drive covers this pane too.
      !session.isRendererPtyResizeAuthoritative() ||
      session.shouldSuppressDesktopPtyResize()
    ) {
      return
    }
    const { cols, rows } = session.pane.terminal
    if (cols < 1 || rows < 1) {
      return
    }
    // Why rows, not cols: a height change does not rewrap the host's scrollback. Measured on the
    // host's clamped grid, or a pane at the minimum height would ask for two identical sizes.
    const hostRows = clampTerminalViewport(cols, rows).rows
    const nudgeRows = hostRows > TERMINAL_VIEWPORT_MIN_ROWS ? hostRows - 1 : hostRows + 1
    let restoreTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      unsubscribe()
      clearTimeout(ackTimer)
      if (restoreTimer !== null) {
        clearTimeout(restoreTimer)
      }
      session.remoteProgramRedrawRestore = null
    }
    const restore = (): void => {
      finish()
      // Why not forwardPtyResize: this moved the PTY by a row, so it must put it back even if the
      // pane was hidden meanwhile; only a viewer that took the size since owns it now.
      if (session.transport.getPtyId() !== ptyId || session.shouldSuppressDesktopPtyResize()) {
        return
      }
      session.transport.resize(session.pane.terminal.cols, session.pane.terminal.rows, {
        claim: true
      })
    }
    const scheduleRestore = (): void => {
      if (restoreTimer === null) {
        clearTimeout(ackTimer)
        restoreTimer = setTimeout(restore, REMOTE_PROGRAM_REDRAW_RESTORE_MS)
      }
    }
    const unsubscribe = onOverrideChange((event) => {
      if (event.ptyId !== ptyId) {
        return
      }
      if (event.mode !== 'desktop-fit') {
        // Another viewer took the size after this claim; its layout repaints the program.
        finish()
      } else if (event.rows === nudgeRows) {
        scheduleRestore()
      }
    })
    const ackTimer = setTimeout(scheduleRestore, REMOTE_PROGRAM_REDRAW_ACK_TIMEOUT_MS)
    session.remoteProgramRedrawRestore = restore
    session.remoteProgramRedrawPtyId = ptyId
    if (!session.transport.resize(cols, nudgeRows, { claim: true })) {
      finish()
      return
    }
    recordTerminalFreezeBreadcrumb('remote-program-redraw', {
      id: redactPtyIdForDiagnostics(ptyId),
      reason
    })
  }

  // Why flush rather than cancel: an unmount mid-nudge would otherwise strand the PTY a row off.
  session.flushRemoteProgramRedraw = function (): void {
    session.remoteProgramRedrawRestore?.()
  }
}

import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import {
  TERMINAL_VIEWPORT_MIN_ROWS,
  clampTerminalViewport
} from '../../../../../shared/terminal-viewport'
import { onOverrideChange } from '@/lib/pane-manager/mobile-fit-overrides'
import { recordTerminalFreezeBreadcrumb } from '../terminal-freeze-breadcrumbs'
import { redactPtyIdForDiagnostics } from '../../../../../shared/pty-delivery-diagnostics'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Wait after host-confirmed short grid before restoring height so Node TUIs observe two distinct SIGWINCH sizes.
export const REMOTE_PROGRAM_REDRAW_RESTORE_MS = 250
// Why: hosts that predate desktop fit answers never confirm; put the row back anyway.
export const REMOTE_PROGRAM_REDRAW_ACK_TIMEOUT_MS = 2_000

/** When no host image exists, nudge idle differential TUIs to repaint instead of retaining a stale frame or the loss banner until manual resize (#26887). */
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
      session.remoteProgramRedrawRestore !== null ||
      // Recovery replays only the last deferred grid; claiming mid-recovery would skip the short size and its repaint.
      !session.transport.isConnected() ||
      // Hidden panes cannot claim geometry, and a mobile/desktop owner’s repaint already covers this viewer.
      !session.isRendererPtyResizeAuthoritative() ||
      session.shouldSuppressDesktopPtyResize()
    ) {
      return
    }
    const { cols, rows } = session.pane.terminal
    if (cols < 1 || rows < 1) {
      return
    }
    // Nudge rows to avoid scrollback rewrap; use clamped host height so minimum-size panes request two distinct grids.
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
      // Restore the borrowed row even after hiding unless another viewer took ownership meanwhile.
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
    if (!isRemoteRuntimePtyId(ptyId)) {
      // Local main never confirms a desktop fit; IPC order alone keeps the two sizes distinct.
      scheduleRestore()
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

import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { replayPayloadEndsWithCursorHidden } from '../../../../../shared/terminal-mode-reset-profiles'
import { resolvePositiveTerminalDimensions } from '../terminal-snapshot-replay-paint'
import { getEagerPtyBufferHandle } from '../pty-dispatcher'
import { CURSOR_HIDE_SEQUENCE } from './foreground-output-scan'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function attachDetachedOrEagerPty(
  session: ConnectPanePtySession,
  attachPtyId: string,
  eagerLivePtyId: string | null
): void {
  try {
    session.clearPaneMode2031State()
    session.clearHiddenOutputRestoreState()
    // Why: eager-buffered bytes were rendered by a TUI at the background
    // spawn grid. Replaying them at the pane's fitted grid rewraps rows,
    // so inline TUIs (Cursor CLI) anchor their cursor rows below the input
    // box. Replay at capture dims, then fit back; defer the PTY resize so
    // SIGWINCH lands after xterm has the correctly-parsed frame.
    const isEagerAdopt = attachPtyId === eagerLivePtyId
    const eagerBufferHandle = isEagerAdopt ? getEagerPtyBufferHandle(attachPtyId) : undefined
    const eagerPeek = eagerBufferHandle?.peek() ?? ''
    // Why: Cursor Agent paints its own caret and parks the real cursor with
    // ?25l. A post-replay reset or fit that re-shows it leaves a stray
    // block under the footer (dual cursor). Peek before attach flush.
    const eagerEndsWithCursorHidden = replayPayloadEndsWithCursorHidden(eagerPeek)
    const eagerCaptureDims = resolvePositiveTerminalDimensions(
      eagerBufferHandle?.captureDims?.cols,
      eagerBufferHandle?.captureDims?.rows
    )
    const replayAtCaptureDims = Boolean(
      eagerCaptureDims &&
      (session.pane.terminal.cols !== eagerCaptureDims.cols ||
        session.pane.terminal.rows !== eagerCaptureDims.rows)
    )
    if (replayAtCaptureDims && eagerCaptureDims) {
      session.suppressStructuralReplayPtyResize = true
      try {
        session.pane.terminal.resize(eagerCaptureDims.cols, eagerCaptureDims.rows)
      } finally {
        session.suppressStructuralReplayPtyResize = false
      }
    }
    const outputCallbacks = session.captureTransportOutputCallbacks(session.reportError, null)
    session.transport.attach({
      existingPtyId: attachPtyId,
      // Why: for eager adopt, defer PTY resize until after the async
      // replay drain finishes at capture dims — otherwise SIGWINCH races
      // ahead of the xterm parse and the fit undoes capture-dim replay.
      ...(isEagerAdopt ? {} : { cols: session.cols, rows: session.rows }),
      callbacks: outputCallbacks.callbacks
    })
    const finishEagerAdopt = (): void => {
      if (session.disposed) {
        return
      }
      if (replayAtCaptureDims) {
        safeFit(session.pane)
      }
      if (eagerEndsWithCursorHidden) {
        // Why: fit/reset can leave DECTCEM shown; re-park so only the
        // TUI's painted caret remains visible.
        session.writeReplayData(CURSOR_HIDE_SEQUENCE)
      }
      const fittedCols = session.pane.terminal.cols
      const fittedRows = session.pane.terminal.rows
      if (fittedCols > 0 && fittedRows > 0) {
        session.transport.resize(fittedCols, fittedRows)
      }
    }
    if (isEagerAdopt) {
      // Why: live TUI bytes deferred across replay are re-enqueued on the
      // async output path; wait for them to parse at capture dims before
      // fit/SIGWINCH can change the grid under that frame.
      void session.replayWriteQueue
        .catch(() => undefined)
        .then(() => waitForTerminalOutputParsed(session.pane.terminal))
        .then(finishEagerAdopt)
    }
    const attachedPtyId = session.transport.getPtyId() ?? attachPtyId
    session.bindActivePanePty(attachedPtyId, {
      updateTabPtyId: 'if-missing',
      sampleVisibleForegroundAgent: true
    })
    if (attachPtyId === eagerLivePtyId || isRemoteRuntimePtyId(attachedPtyId)) {
      session.registerPaneSerializerFor(attachedPtyId)
    }
  } catch (err) {
    session.reportError(err instanceof Error ? err.message : String(err))
    session.deps.clearTabPtyId(session.deps.tabId, attachPtyId)
    session.startFreshSpawn()
  }
}

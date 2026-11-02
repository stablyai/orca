import { buildProcessBoundaryGround } from '../../../../../shared/terminal-mode-reset-profiles'
import { serializeWithAbsoluteCursor } from '../../../../../shared/terminal-serialize-absolute-cursor'
import { isTerminalWritePipelineCertifiedDead } from '@/lib/pane-manager/terminal-write-pipeline-health'
import { registerPtySerializer, registerPtyTitleSource } from '../pty-buffer-serializer'
import {
  discardTerminalOutput,
  waitForTerminalOutputParsed
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { clearTerminalScrollbackAndFollowOutput } from '@/lib/pane-manager/terminal-scrollback-clear'
import { terminalMouseEncodingRestoreAnsi } from '@/lib/pane-manager/terminal-mouse-encoding-tracker'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindRegisterPaneSerializer(session: ConnectPanePtySession): void {
  session.registerPaneSerializerFor = (ptyId: string): void => {
    // Ignore disposed StrictMode mounts whose spawn resolved late; stale serializer registration could shadow the live xterm’s owner token.
    if (session.disposed) {
      return
    }
    const unregisterSerializer = registerPtySerializer(
      ptyId,
      async (opts) => {
        try {
          if (isTerminalWritePipelineCertifiedDead(session.pane.terminal)) {
            return null
          }
          await waitForTerminalOutputParsed(session.pane.terminal)
          // Recheck dead-pipeline certification after parser waits so stale frames cannot publish.
          if (isTerminalWritePipelineCertifiedDead(session.pane.terminal)) {
            return null
          }
          // Use absolute cursor restore for wrap-pending final rows. Keep normal scrollback before alt frames; scrollback:0 loses shell history, not transient TUI bytes (#6106). Append encoding after the final alt marker.
          const serialized = serializeWithAbsoluteCursor(
            session.pane.serializeAddon,
            session.pane.terminal,
            { scrollback: opts?.scrollbackRows }
          )
          // Why non-empty only: '' means nothing to restore to its readers.
          const data = serialized
            ? serialized + terminalMouseEncodingRestoreAnsi(session.pane.terminal)
            : serialized
          const orderedSeq =
            session.rendererOrderedPtyId === ptyId ? session.rendererOrderedSeq : null
          // Publish only snapshotFlags evidence; older-host unknowns must not become proven-zero Kitty state downstream.
          const provenKittyFlags = session.kittyKeyboardModes.hasProvenBaseline
            ? session.kittyKeyboardModes.snapshotFlags
            : undefined
          const pendingEscapeTailAnsi = session.transport.getPendingEscapeTailAnsi?.()
          return {
            data,
            cols: session.pane.terminal.cols,
            rows: session.pane.terminal.rows,
            ...(orderedSeq !== null ? { seq: orderedSeq } : {}),
            ...(orderedSeq !== null && provenKittyFlags !== undefined
              ? { kittyKeyboardFlags: provenKittyFlags }
              : {}),
            ...(pendingEscapeTailAnsi ? { pendingEscapeTailAnsi } : {})
          }
        } catch {
          return null
        }
      },
      {
        clear: () => {
          session.clearHiddenOutputRestoreState()
          discardTerminalOutput(session.pane.terminal)
          clearTerminalScrollbackAndFollowOutput(session.pane.terminal)
        },
        resetInputModes: () =>
          session.writeInputModeGround(
            buildProcessBoundaryGround({ keepFocusReporting: session.isNativeWindowsConpty })
          )
      }
    )
    const unregisterTitleSource = registerPtyTitleSource(ptyId, (handler) =>
      session.pane.terminal.onTitleChange(handler)
    )
    const origOnDataDisposableDispose = session.onDataDisposable.dispose.bind(
      session.onDataDisposable
    )
    session.onDataDisposable.dispose = () => {
      unregisterTitleSource()
      unregisterSerializer()
      origOnDataDisposableDispose()
    }
  }

  session.replayWriteQueue = Promise.resolve()
}

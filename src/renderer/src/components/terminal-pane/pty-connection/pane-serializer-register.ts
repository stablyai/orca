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

/** Serializer and title-source registration for a bound PTY, plus the replay write queue. */
export function bindRegisterPaneSerializer(session: ConnectPanePtySession): void {
  session.registerPaneSerializerFor = (ptyId: string): void => {
    // Why: StrictMode mounts panes twice; the first mount is session.disposed
    // before the second runs, but its pty:spawn IPC may have resolved by
    // the time `session.disposed` flips. Without this guard, the session.disposed first
    // mount would register against a torn-down xterm and replace the live
    // second-mount registration via owner-token shadowing.
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
          // Certification can land while the serializer waits for an older
          // write; never publish a fossil frame from a dead renderer.
          if (isTerminalWritePipelineCertifiedDead(session.pane.terminal)) {
            return null
          }
          // Why serializeWithAbsoluteCursor: SerializeAddon's relative
          // cursor restore lands one column short when replay of a
          // margin-filling final row leaves the target wrap-pending.
          //
          // Why scrollback is never zeroed mid-TUI: the addon emits the normal
          // buffer first and only then the `?1049h` alt frame, and readers split
          // the two back apart (splitTerminalSnapshotAnsi). Forcing `scrollback: 0`
          // while an alt-screen TUI was up therefore dropped the pre-TUI shell
          // output from the seed instead of the transient TUI bytes, and every
          // later restore painted only the TUI screen (#6106).
          // Why appended last: SerializeAddon writes mouse tracking but not its
          // encoding, and readers keep only what follows the final `?1049h`.
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
          // Why snapshotFlags and not `flags`: this pane may itself have
          // consumed an old-host snapshot that proved nothing, and its
          // conservative `0` fallback must not be republished downstream as
          // a host-proven inactive protocol.
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

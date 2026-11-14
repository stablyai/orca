import { parseTerminalKittyKeyboardFlags } from '../../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindSnapshotKittyKeyboardModes(session: ConnectPanePtySession): void {
  session.applySnapshotKittyKeyboardModes = function (
    snapshotData: string,
    snapshot: { kittyKeyboardFlags?: number; snapshotSeq?: number }
  ): void {
    const proven =
      snapshot.snapshotSeq === undefined
        ? undefined
        : parseTerminalKittyKeyboardFlags(snapshot.kittyKeyboardFlags)
    session.kittyKeyboardModes.adoptSnapshot(snapshotData, proven)
    if (proven === undefined) {
      return
    }
    // Publish the baseline atomically with flags so quiet panes can serialize coherently without waiting for more output.
    session.recordRendererOrderedSeq({ seq: snapshot.snapshotSeq })
  }
}

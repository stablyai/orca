import { waitForTerminalReplayWritesParsed } from '../replay-guard'
import { recordTerminalOutput } from '@/lib/pane-manager/pane-scroll'
import { parseAppSshPtyId } from '../../../../../shared/ssh-pty-id'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions
} from '../terminal-snapshot-replay-paint'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindPrepaintParkedSshSnapshot(session: ConnectPanePtySession): void {
  session.prepaintParkedSshSnapshot = (ptyId: string | null): void => {
    const parsedPtyId = ptyId ? parseAppSshPtyId(ptyId) : null
    if (
      !ptyId ||
      !session.mountFollowsTerminalPark ||
      parsedPtyId?.connectionId !== session.connectionId ||
      !session.capturedDirectSshRetryLeaseMatches()
    ) {
      return
    }
    const capturedGeneration = session.authoritativeReattachGeneration
    const isCurrent = (): boolean =>
      !session.disposed &&
      session.mountFollowsTerminalPark &&
      session.authoritativeReattachGeneration === capturedGeneration &&
      session.capturedDirectSshRetryLeaseMatches()
    const fetchSnapshot = session.getSshMainModelSnapshotProbe(ptyId)
    void fetchSnapshot()
      .then(async (snapshot) => {
        if (!snapshot || !isCurrent()) {
          return
        }
        await session.structuralReplayCoordinator.run(
          async () => {
            if (!isCurrent()) {
              return
            }
            const modelData = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
            session.rememberReattachPayloadAgentSignal(modelData, { fullScreenReplay: true })
            if (
              hasPositiveTerminalDimensions(snapshot.cols, snapshot.rows) &&
              (session.pane.terminal.cols !== snapshot.cols ||
                session.pane.terminal.rows !== snapshot.rows)
            ) {
              session.suppressStructuralReplayPtyResize = true
              try {
                session.pane.terminal.resize(snapshot.cols, snapshot.rows)
              } finally {
                session.suppressStructuralReplayPtyResize = false
              }
            }
            session.applySnapshotKittyKeyboardModes(modelData, {
              kittyKeyboardFlags: snapshot.kittyKeyboardFlags,
              snapshotSeq: snapshot.seq
            })
            // Why keep a too-wide frame: preconnect SSH has no live repaint owner or post-restore fit.
            for (const replayChunk of buildMainModelSnapshotReplayWrites(snapshot, {
              paneOnAlternateScreen: session.isPaneOnAlternateScreen()
            })) {
              session.writeReplayData(replayChunk)
            }
            session.writeReplayData(session.reattachReplayResetSequence(modelData))
            if (snapshot.pendingEscapeTailAnsi) {
              session.writeReplayData(snapshot.pendingEscapeTailAnsi)
            }
            recordTerminalOutput(session.pane.terminal)
            await waitForTerminalReplayWritesParsed(session.pane.terminal)
            if (isCurrent()) {
              session.manager.rebuildPaneWebgl(session.pane.id)
            }
          },
          { shouldRestore: isCurrent }
        )
      })
      .catch(() => {})
  }
}

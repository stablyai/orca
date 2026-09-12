import { RESET_AFTER_BYTE_GAP } from '../../../../../shared/terminal-mode-reset-profiles'
import { cancelScheduledHiddenOutputRestore } from '../hidden-output-restore-scheduler'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindAbandonHiddenOutputRestore(session: ConnectPanePtySession): void {
  session.abandonHiddenOutputRestoreAndDrainPendingForeground = function (
    expectedPtyId: string,
    opts: { quiet?: boolean; rearmRemote?: boolean } = {}
  ): void {
    if (
      session.transport.getPtyId() !== expectedPtyId ||
      session.hiddenOutputRestorePtyId !== expectedPtyId
    ) {
      session.resetHiddenOutputRestoreIfPtyChanged()
      return
    }
    const rearmedRemoteRestore =
      opts.rearmRemote !== false &&
      !opts.quiet &&
      session.canUseHiddenOutputSnapshot(expectedPtyId) &&
      session.rearmRemoteHiddenOutputRestoreInsteadOfWarning(expectedPtyId, 'abandon-deadline')
    const pendingChunks = session.hiddenOutputRestorePendingOverflow
      ? []
      : session.hiddenOutputRestorePendingChunks.slice()
    const hadPendingOverflow = session.hiddenOutputRestorePendingOverflow
    const replayingSnapshot = session.hiddenOutputRestoreReplayingSnapshot
    session.hiddenOutputRestoreReplayingSnapshot = null
    session.hiddenOutputRestoreGeneration += 1
    if (
      session.hiddenOutputSnapshotScrollRestore?.valid &&
      session.hiddenOutputSnapshotScrollRestore.ptyId === expectedPtyId
    ) {
      // Why: flood abandonment stops recovery bookkeeping, but its already-queued replay must keep the rebuild bracket and final pin.
      session.hiddenOutputSnapshotScrollRestore.generation = session.hiddenOutputRestoreGeneration
    }
    session.hiddenOutputRestoreInFlight = null
    session.hiddenOutputRestoreNeeded = false
    session.hiddenOutputRestorePtyId = null
    session.hiddenOutputRestorePendingChunks = []
    session.hiddenOutputRestorePendingChars = 0
    session.hiddenOutputRestorePendingOverflow = false
    session.hiddenOutputRestoreFreshSnapshotNeeded = false
    session.hiddenOutputRestoreRetryDeferred = false
    session.hiddenOutputRestoreScheduled = false
    session.hiddenStartupRendererQueryPending = ''
    session.hiddenRendererStateDirty = false
    cancelScheduledHiddenOutputRestore(session.pane.terminal)
    session.clearHiddenOutputRestoreDeferredRetryTimer()
    session.clearHiddenOutputRestoreForegroundDeadlineTimer()
    session.hiddenOutputRestoreDeferredRetryAttempts = 0

    // Why quiet: flood cuts abandon deliberately and repaint post-flood, so the "restore unavailable" warning would be noise the repaint wipes.
    if (!opts.quiet && !rearmedRemoteRestore) {
      // Why: this abandon declares the bytes unrecoverable, so a repaint armed by earlier live
      // backpressure must not outlive it — it would re-open recovery and banner a second time.
      session.clearHiddenOutputRestoreFloodRepaintTimer()
      session.writeRestoreUnavailableWarning()
    }
    // Why an else: the branch above already grounds the gap inside
    // session.writeRestoreUnavailableWarning, and the remote re-arm grounds it in
    // session.rearmRemoteHiddenOutputRestoreInsteadOfWarning. Only the quiet
    // flood-abandon reaches neither, and it still drains chunks below.
    else if (!rearmedRemoteRestore) {
      session.writePtyOutputToXterm(RESET_AFTER_BYTE_GAP, true)
    }
    if (hadPendingOverflow) {
      return
    }
    const replayedSeq = typeof replayingSnapshot?.seq === 'number' ? replayingSnapshot.seq : null
    let pendingData = ''
    for (const chunk of pendingChunks) {
      const sliced =
        replayedSeq === null ? chunk.data : session.getChunkDataAfterSnapshot(chunk, replayedSeq)
      pendingData += sliced ?? chunk.data
    }
    if (replayingSnapshot && replayedSeq !== null) {
      session.setRestoredSnapshotBaseline(
        expectedPtyId,
        replayingSnapshot,
        replayingSnapshot.paintsContent === true
      )
      for (const chunk of pendingChunks) {
        if (typeof chunk.seq === 'number' && session.restoredSnapshotExpectedStartSeq !== null) {
          session.restoredSnapshotExpectedStartSeq = Math.max(
            session.restoredSnapshotExpectedStartSeq,
            chunk.seq
          )
        }
      }
    }
    if (pendingData) {
      session.writePtyOutputToXterm(pendingData, true)
    }
  }
}

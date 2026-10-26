import { cancelScheduledHiddenOutputRestore } from '../hidden-output-restore-scheduler'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindAbandonHiddenOutputRestore(session: ConnectPanePtySession): void {
  // Background abandonment would swallow loss disclosure; retain recovery and spent counters so reveal tries once, then heals or banners visibly.
  session.deferHiddenOutputRestoreLossToReveal = function (): boolean {
    if (shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)) {
      return false
    }
    // Cancel the throttled old deadline before it can invalidate reveal’s fresh snapshot.
    session.clearHiddenOutputRestoreForegroundDeadlineTimer()
    session.hiddenOutputRestoreNeeded = true
    return true
  }

  session.abandonHiddenOutputRestoreAndDrainPendingForeground = function (
    expectedPtyId: string,
    opts: { quiet?: boolean; rearmRemote?: boolean; preserveReplayState?: boolean } = {}
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
    session.hiddenOutputRestoreUnhideSeq = null
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
      // Final loss disclosure cancels earlier backpressure repaint so it cannot reopen recovery and duplicate the banner.
      session.clearHiddenOutputRestoreFloodRepaintTimer()
      session.writeRestoreUnavailableWarning()
    }
    // Intact replay tails must reach queued live bytes without a parser or rendition reset.
    else if (!rearmedRemoteRestore && !opts.preserveReplayState) {
      session.writeAbandonedRestoreGap()
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

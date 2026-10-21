import type { PtyModelRestoreNeededEvent } from '../../../../../shared/pty-model-restore-marker'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function handleUnhideRestoreBackpressure(
  session: ConnectPanePtySession,
  event: PtyModelRestoreNeededEvent,
  previousDropEpisode: number | null
): void {
  if (
    event.reason !== 'unhide' ||
    session.hiddenOutputRestoreInFlight === null ||
    // An in-flight restore for another PTY can't cover this marker; the quiet repaint is its only recovery.
    session.hiddenOutputRestorePtyId !== event.id ||
    typeof event.markerSeq !== 'number' ||
    !Number.isFinite(event.markerSeq)
  ) {
    if (session.hiddenOutputRestorePtyId === event.id) {
      session.hiddenOutputRestoreUnhideSeq = null
    }
    session.noteHiddenOutputRestoreFloodBackpressure()
    return
  }
  if (
    previousDropEpisode === null ||
    !Number.isFinite(previousDropEpisode) ||
    previousDropEpisode !== event.hiddenDropEpisode ||
    session.hiddenOutputRestoreFloodRepaintTimer !== null ||
    session.cancelHiddenOutputRestoreFloodRepaintPark !== null
  ) {
    // Leave recovery to the quiet timer when this snapshot cannot retire the episode.
    session.hiddenOutputRestoreUnhideSeq = null
    session.noteHiddenOutputRestoreFloodBackpressure()
    return
  }
  // A current or successor restore must cover the retained marker before finishing.
  session.hiddenOutputRestoreUnhideSeq = Math.max(
    session.hiddenOutputRestoreUnhideSeq ?? 0,
    event.markerSeq
  )
  // Still backpressure: keep later markers gated, but the covering restore replaces the quiet repaint.
  session.extendHiddenOutputRestoreFloodSuppression()
}

export function consumeSnapshotRequirement(
  session: ConnectPanePtySession,
  snapshotSeq: number | undefined
): boolean {
  const unhideSeq = session.hiddenOutputRestoreUnhideSeq
  const freshSnapshotNeeded = session.hiddenOutputRestoreFreshSnapshotNeeded
  const uncoveredUnhide =
    typeof unhideSeq === 'number' &&
    (typeof snapshotSeq !== 'number' || !Number.isFinite(snapshotSeq) || snapshotSeq < unhideSeq)
  session.hiddenOutputRestoreReplayingSnapshot = null
  session.hiddenOutputRestoreUnhideSeq = uncoveredUnhide ? unhideSeq : null
  session.hiddenOutputRestoreFreshSnapshotNeeded = false
  return freshSnapshotNeeded || uncoveredUnhide
}

export function repairUnhandledMarker(
  session: ConnectPanePtySession,
  task: Promise<void>,
  ptyId: string
): void {
  if (
    session.hiddenOutputRestoreInFlight === task &&
    !session.disposed &&
    session.transport.getPtyId() === ptyId &&
    typeof session.hiddenOutputRestoreUnhideSeq === 'number' &&
    !session.hiddenOutputRestoreNeeded &&
    !session.hiddenOutputRestoreRetryDeferred
  ) {
    session.hiddenOutputRestoreUnhideSeq = null
    session.noteHiddenOutputRestoreFloodBackpressure()
  }
}

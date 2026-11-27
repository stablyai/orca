import * as unhideCoverage from '../output-restore/hidden-unhide-snapshot-coverage'
import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { recordTerminalFreezeBreadcrumb } from '../../render-health/diagnostics/terminal-freeze-breadcrumbs'
import { redactPtyIdForDiagnostics } from '../../../../../../shared/terminal/pty/diagnostics/pty-delivery-diagnostics'
import { RESET_AFTER_BYTE_GAP } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { registerPtyModelRestoreNeededHandler } from '../../pty-transport/delivery/pty-model-restore-channel'
import type { PtyModelRestoreNeededEvent } from '../../../../../../shared/terminal/replay/pty-model-restore-marker'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { retainsHiddenGraphics } from './hidden-graphics-delivery'
import { shouldWritePtyOutputForeground } from './foreground-output-visibility'

export function bindModelRestoreNeededSubscription(
  session: ConnectPanePtySession
): (ptyId: string | null) => void {
  function handleModelRestoreNeededMarker(event: PtyModelRestoreNeededEvent): void {
    if (
      session.disposed ||
      event.id !== session.transport.getPtyId() ||
      session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
    ) {
      return
    }
    const episode = typeof event.hiddenDropEpisode === 'number' ? event.hiddenDropEpisode : null
    if (
      event.reason === 'unhide' &&
      !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current) &&
      retainsHiddenGraphics(session.transport, event.id)
    ) {
      // A late reveal notification cannot invalidate the pane's current hide claim.
      return
    }
    const previousDropEpisode = session.hiddenOutputRestoreLatestDropEpisode
    // Ignore only repeats of the disclosed gap episode; unknown markers may prove new loss and must recover.
    const disclosed = session.hiddenOutputRestoreDisclosedGap
    if (
      episode !== null &&
      disclosed !== null &&
      disclosed.ptyId === session.transport.getPtyId() &&
      disclosed.episode === episode
    ) {
      return
    }
    if (
      event.reason !== 'unhide' &&
      episode === null &&
      typeof event.markerSeq === 'number' &&
      session.restoredSnapshotBaselinePtyId === event.id &&
      session.restoredSnapshotBaselineSeq !== null &&
      event.markerSeq <= session.restoredSnapshotBaselineSeq
    ) {
      return
    }
    if (episode !== null) {
      session.hiddenOutputRestoreLatestDropEpisode = episode
    }
    recordTerminalFreezeBreadcrumb('restore-marker', {
      id: redactPtyIdForDiagnostics(session.transport.getPtyId() ?? '')
    })
    // Why: dropped bytes invalidate cross-chunk carry — a partial OSC-9999 prefix spanning the gap would corrupt the next live chunk.
    session.transport.resetCrossChunkParserState?.()
    // Why gated (rc.7.perf loop): on a visible pane these markers come from our own restore starving ACKs; re-arming per marker kept the fetch loop alive all flood, so defer to one post-flood repaint.
    if (session.isForegroundRestoreBackpressureContext()) {
      unhideCoverage.handleUnhideRestoreBackpressure(session, event, previousDropEpisode)
      return
    }
    // Ground the pen at the proven gap: lost resets can leak bold into later cells (STA-4042). Skip flood markers because snapshot replay already grounds them.
    session.streamPosition.invalidate({ grounded: true })
    session.writePtyOutputToXterm(RESET_AFTER_BYTE_GAP, true)
    // Capture restore state before marking synchronously starts one; a mid-restore drop needs a newer snapshot.
    const restoreWasInFlight = session.hiddenOutputRestoreInFlight !== null
    if (event.reason === 'unhide') {
      session.markHiddenOutputRestoreNeeded()
    } else {
      session.markHiddenOutputRestoreAfterGap(event.id)
    }
    if (restoreWasInFlight) {
      session.hiddenOutputRestoreFreshSnapshotNeeded = true
    }
  }

  return (ptyId) => {
    if (session.modelRestoreSubscribedPtyId === ptyId) {
      return
    }
    session.unregisterModelRestoreNeeded?.()
    session.unregisterModelRestoreNeeded = null
    // Marker bookkeeping is per PTY stream, like the restore state itself.
    session.hiddenOutputRestoreLatestDropEpisode = null
    session.hiddenOutputRestoreDisclosedGap = null
    session.modelRestoreSubscribedPtyId = ptyId
    // Only streams through local main have markers; remote-runtime transports are unaffected.
    if (ptyId && !isRemoteRuntimePtyId(ptyId)) {
      session.unregisterModelRestoreNeeded = registerPtyModelRestoreNeededHandler(
        ptyId,
        handleModelRestoreNeededMarker,
        () => session.agentCompletionCoordinator.observeHiddenOutputActivity()
      )
    }
  }
}

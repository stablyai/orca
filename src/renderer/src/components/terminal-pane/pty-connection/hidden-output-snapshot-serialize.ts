import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isHostAnsweredSnapshotRetryCause } from '@/runtime/remote-runtime-terminal-multiplexer-types'
import { onTerminalScrollIntentFollowOutput } from '@/lib/pane-manager/terminal-scroll-intent'

import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS } from './hidden-output-restore-limits'
import { readE2eHiddenSnapshotOverride } from './e2e-terminal-pty-harness'

import type { PtyBufferSnapshot } from '../pty-transport-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export type HiddenOutputSnapshotResult =
  | { kind: 'snapshot'; snapshot: PtyBufferSnapshot }
  | { kind: 'retry-worthy'; source: 'host' | 'local' }
  | { kind: 'permanently-unavailable' }
  | { kind: 'unknown-legacy-host' }
  | { kind: 'unavailable' }

/** Why 'host': on a modern remote transport the only reject is the request timeout — the frame went out and the host stayed silent. Elsewhere local main answered nothing. */
export function classifyHiddenOutputSnapshotReject(
  session: ConnectPanePtySession,
  ptyId: string
): HiddenOutputSnapshotResult {
  return !isRemoteRuntimePtyId(ptyId) ||
    session.hiddenOutputRestoreLegacyPtyId === ptyId ||
    typeof session.transport.serializeBufferOutcome !== 'function'
    ? { kind: 'unavailable' }
    : { kind: 'retry-worthy', source: 'host' }
}

export function bindSerializeHiddenOutputSnapshot(session: ConnectPanePtySession): void {
  session.serializeHiddenOutputSnapshot = async function (
    ptyId: string,
    opts: { scrollbackRows?: number }
  ): Promise<HiddenOutputSnapshotResult> {
    const e2eSnapshot = readE2eHiddenSnapshotOverride(ptyId)
    if (e2eSnapshot) {
      const snapshot = await e2eSnapshot
      return snapshot ? { kind: 'snapshot', snapshot } : { kind: 'unavailable' }
    }
    if (session.canUseMainBufferSnapshot(ptyId)) {
      const snapshot = await window.api.pty.getMainBufferSnapshot(ptyId, opts)
      return snapshot ? { kind: 'snapshot', snapshot } : { kind: 'unavailable' }
    }
    if (
      session.transport.getPtyId() !== ptyId ||
      typeof session.transport.serializeBuffer !== 'function'
    ) {
      return { kind: 'unavailable' }
    }
    if (
      session.hiddenOutputRestoreLegacyPtyId === ptyId ||
      typeof session.transport.serializeBufferOutcome !== 'function'
    ) {
      const snapshot = await session.transport.serializeBuffer({ ...opts, repaintsPane: true })
      return snapshot ? { kind: 'snapshot', snapshot } : { kind: 'unknown-legacy-host' }
    }
    try {
      // Why repaintsPane: every caller paints this image, so live output resumes after its seq.
      const outcome = await session.transport.serializeBufferOutcome({
        ...opts,
        repaintsPane: true
      })
      if (outcome.availability.kind === 'snapshot') {
        // A success frame with no image is still the host's own answer to a request it received.
        return outcome.snapshot
          ? { kind: 'snapshot', snapshot: outcome.snapshot }
          : { kind: 'retry-worthy', source: 'host' }
      }
      if (outcome.availability.kind === 'retry-worthy') {
        return {
          kind: 'retry-worthy',
          source: isHostAnsweredSnapshotRetryCause(outcome.availability.cause) ? 'host' : 'local'
        }
      }
      if (outcome.availability.kind === 'permanently-unavailable') {
        return { kind: 'permanently-unavailable' }
      }
      return { kind: 'unknown-legacy-host' }
    } catch {
      // Why 'host': the reject path is the request timeout — the frame went out and the host stayed silent.
      return { kind: 'retry-worthy', source: 'host' }
    }
  }

  // Declare hidden before spawn bytes so main answers startup queries from byte zero; remote-runtime streams never transit this gate.
  session.shouldDeclareHiddenAtSpawn = function (): boolean {
    return (
      session.hiddenDeliveryGateActive &&
      !session.runtimeEnvironmentId &&
      !session.disposed &&
      !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    )
  }

  // Track hidden claims per PTY so reattach/restart cannot leave old IDs gated; reveal restores bytes main withheld after ingestion.
  session.hiddenDeliverySyncedPtyId = null
  session.releaseHiddenDeliveryClaim = null
  session.modelRestoreSubscribedPtyId = null
  session.unregisterModelRestoreNeeded = null

  function isHiddenOutputRestoreFloodSuppressed(): boolean {
    return Date.now() < session.hiddenOutputRestoreFloodSuppressedUntil
  }

  // Own-restore backpressure markers must defer to quiet repaint rather than re-arm the rc.7.perf fetch loop.
  session.isForegroundRestoreBackpressureContext = function (): boolean {
    return (
      shouldWritePtyOutputForeground(session.deps.isVisibleRef.current) &&
      (session.hiddenOutputRestoreInFlight !== null || isHiddenOutputRestoreFloodSuppressed())
    )
  }

  session.clearHiddenOutputRestoreFloodRepaintTimer = function (): void {
    session.cancelHiddenOutputRestoreFloodRepaintPark?.()
    session.cancelHiddenOutputRestoreFloodRepaintPark = null
    if (session.hiddenOutputRestoreFloodRepaintTimer === null) {
      return
    }
    clearTimeout(session.hiddenOutputRestoreFloodRepaintTimer)
    session.hiddenOutputRestoreFloodRepaintTimer = null
  }
  session.cleanupHiddenOutputRestoreFloodRepaint = session.clearHiddenOutputRestoreFloodRepaintTimer

  // Why: the repaint discards the buffer and replays a full snapshot, which repositions the viewport; a user reading scrollback must not be yanked to the bottom, so hold it until their own scroll intent returns to follow-output.
  session.repaintAfterFloodWhenFollowingOutput = function (ptyId: string): void {
    session.cancelHiddenOutputRestoreFloodRepaintPark?.()
    session.cancelHiddenOutputRestoreFloodRepaintPark = null
    let repainted = false
    const cancelPark = onTerminalScrollIntentFollowOutput(session.pane.terminal, () => {
      repainted = true
      session.cancelHiddenOutputRestoreFloodRepaintPark = null
      if (session.disposed || session.transport.getPtyId() !== ptyId) {
        return
      }
      session.markHiddenOutputRestoreNeeded()
    })
    if (!repainted) {
      session.cancelHiddenOutputRestoreFloodRepaintPark = cancelPark
    }
  }

  session.extendHiddenOutputRestoreFloodSuppression = function (): void {
    session.hiddenOutputRestoreFloodSuppressedUntil =
      Date.now() + HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS
  }

  session.resetHiddenOutputRestoreFloodSuppression = function (): void {
    session.hiddenOutputRestoreFloodSuppressedUntil = 0
    session.clearHiddenOutputRestoreFloodRepaintTimer()
  }
}

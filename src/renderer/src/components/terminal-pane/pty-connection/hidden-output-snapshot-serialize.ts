import { isHostAnsweredSnapshotRetryCause } from '@/runtime/remote-runtime-terminal-multiplexer'
import { onTerminalScrollIntentFollowOutput } from '@/lib/pane-manager/terminal-scroll-intent'

import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { readE2eHiddenSnapshotOverride } from './e2e-terminal-pty-harness'

import type { PtyBufferSnapshot } from '../pty-transport'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export type HiddenOutputSnapshotResult =
  | { kind: 'snapshot'; snapshot: PtyBufferSnapshot }
  | { kind: 'retry-worthy'; source: 'host' | 'local' }
  | { kind: 'permanently-unavailable' }
  | { kind: 'unknown-legacy-host' }
  | { kind: 'unavailable' }

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
      const snapshot = await session.transport.serializeBuffer(opts)
      return snapshot ? { kind: 'snapshot', snapshot } : { kind: 'unknown-legacy-host' }
    }
    try {
      const outcome = await session.transport.serializeBufferOutcome(opts)
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

  // Why: hidden/parked panes used to mark hidden only at the first
  // session.dataCallback sync, leaving a spawn-time window where neither side
  // answered queries (the spawn-time DA1 loss). Declaring hidden on the
  // spawn IPC lets main mark the PTY before its first byte — including
  // codex spawns: the model responder answers their startup probes from
  // byte zero now that the 10s renderer query window is gone.
  // Remote-runtime PTYs are never gate-markable (no local main transit).
  session.shouldDeclareHiddenAtSpawn = function (): boolean {
    return (
      session.hiddenDeliveryGateActive &&
      !session.runtimeEnvironmentId &&
      !session.disposed &&
      !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    )
  }

  // ── Hidden-delivery gate sync (Phase 4) ─────────────────────────────
  // Why: marks this pane's PTY hidden in main while no visible view needs
  // its bytes; main then drops delivery after model ingestion and reveal
  // restores from the snapshot. The marked id is tracked locally so PTY
  // changes (reattach/restart) can never leave a stale id gated.
  session.hiddenDeliverySyncedPtyId = null
  session.releaseHiddenDeliveryClaim = null
  session.modelRestoreSubscribedPtyId = null
  session.unregisterModelRestoreNeeded = null

  function isHiddenOutputRestoreFloodSuppressed(): boolean {
    return Date.now() < session.hiddenOutputRestoreFloodSuppressedUntil
  }

  // True when a drop/gap signal on a visible pane is attributable to this
  // pane's OWN restore backpressure (a restore is replaying right now, or
  // one was just cut off for outrunning the stream). Such signals must not
  // re-arm restores — that is the rc.7.perf feedback loop.
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

  session.resetHiddenOutputRestoreFloodSuppression = function (): void {
    session.hiddenOutputRestoreFloodSuppressedUntil = 0
    session.clearHiddenOutputRestoreFloodRepaintTimer()
  }
}

import { RESET_GRAPHIC_RENDITION } from '../../../../../shared/terminal-mode-reset-profiles'
import { redactPtyIdForDiagnostics } from '../../../../../shared/pty-delivery-diagnostics'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { recordTerminalFreezeBreadcrumb } from '../terminal-freeze-breadcrumbs'
import type { PtyBufferSnapshot } from '../pty-transport'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { PARK_REVEAL_NO_HOST_IMAGE_WARNING } from './hidden-output-restore-limits'
import type { HiddenOutputSnapshotResult } from './hidden-output-snapshot-serialize'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

/** Which restore budget an unverifiable probe is charged to; null when the loop keeps its own count (legacy hosts). */
export type ParkRevealRetryLedger = 'host' | 'local' | null

/** The explicit answer that closed the door: only these two ever reach `no-host-image`. */
export type ParkRevealNoHostImageReason = 'permanently-unavailable' | 'unavailable'

/**
 * What a park-reveal's host snapshot probe proved. Three verdicts, no synonyms
 * (docs/reference/ssh-execution-boundary.md): only `host-snapshot` is positive
 * evidence of the pane's contents, and a probe that proves nothing must never
 * be read as "the pane is empty". Retention is never inferred from image
 * content: `no-host-image` is reachable only from an explicit host answer.
 */
export type ParkRevealSnapshotVerdict =
  | { kind: 'host-snapshot'; snapshot: PtyBufferSnapshot }
  /** Timeout, host declined for now, local request-lane gate, or an imageless success. */
  | { kind: 'unverifiable'; ledger: ParkRevealRetryLedger }
  /** The host answered, and repeating this request can never yield the buffer. */
  | { kind: 'no-host-image'; reason: ParkRevealNoHostImageReason }

export function classifyParkRevealSnapshot(
  result: HiddenOutputSnapshotResult,
  ptyId: string
): ParkRevealSnapshotVerdict {
  switch (result.kind) {
    case 'snapshot': {
      const { snapshot } = result
      // Why remote-only: a remote host's fallback serializer can answer `data: ''` before its
      // pane has hydrated, so an imageless success proves nothing there (applyMainBufferSnapshot
      // refuses it too) and painting it would clear the client's own copy. Local main is the
      // execution host for a local pty; its empty model is the positive answer.
      const carriesNoImage =
        isRemoteRuntimePtyId(ptyId) &&
        snapshot.alternateScreen !== true &&
        snapshot.data === '' &&
        !snapshot.scrollbackAnsi
      return carriesNoImage
        ? { kind: 'unverifiable', ledger: 'host' }
        : { kind: 'host-snapshot', snapshot }
    }
    case 'retry-worthy':
      return { kind: 'unverifiable', ledger: result.source }
    case 'unknown-legacy-host':
      return { kind: 'unverifiable', ledger: null }
    case 'permanently-unavailable':
    case 'unavailable':
      return { kind: 'no-host-image', reason: result.kind }
  }
}

export function bindParkRevealSnapshotVerdictActions(session: ConnectPanePtySession): void {
  // Why a hand-off, not a loop: the hidden-output restore loop already budgets
  // retry-worthy answers (7 host declines / 30 local gates / 5 re-arm cycles),
  // repaints from the host on success, and ends in an explicit loss banner.
  // A second loop here would double every bound.
  session.retryUnverifiableParkRevealSnapshot = function (
    ptyId: string,
    ledger: ParkRevealRetryLedger
  ): boolean {
    if (
      session.disposed ||
      session.transport.getPtyId() !== ptyId ||
      !session.canUseHiddenOutputSnapshot(ptyId)
    ) {
      return false
    }
    // Charge the reveal's own probe so the shared budget counts it: 1 + 6 = 7 host requests.
    if (ledger === 'host') {
      session.hiddenOutputRestoreRemoteOutcomeAttempts += 1
    } else if (ledger === 'local') {
      session.hiddenOutputRestoreLocalGateAttempts += 1
    }
    recordTerminalFreezeBreadcrumb('park-reveal-unverifiable', {
      id: redactPtyIdForDiagnostics(ptyId),
      ledger: ledger ?? 'none'
    })
    session.markHiddenOutputRestoreNeeded()
    return true
  }

  // Unavoidable loss must be visible: a pane the host could not image must not
  // look like an empty terminal. Remote-only because local main is the
  // execution host and a local pane's layout copy is never released, so the
  // pane already shows everything there is.
  session.warnParkRevealNoHostImage = function (
    ptyId: string,
    reason: ParkRevealNoHostImageReason
  ): boolean {
    recordTerminalFreezeBreadcrumb('park-reveal-no-host-image', {
      id: redactPtyIdForDiagnostics(ptyId),
      reason
    })
    if (
      !isRemoteRuntimePtyId(ptyId) ||
      session.disposed ||
      session.transport.getPtyId() !== ptyId
    ) {
      return false
    }
    // Why no CAN byte here: the subscribe-time push snapshot may have left a pending escape
    // tail for the next live chunk to complete; only the pen is reset.
    writeTerminalOutput(
      session.pane.terminal,
      `${RESET_GRAPHIC_RENDITION}${PARK_REVEAL_NO_HOST_IMAGE_WARNING}`,
      { foreground: true, beforeWrite: session.beforeTerminalOutputWrite }
    )
    return true
  }
}

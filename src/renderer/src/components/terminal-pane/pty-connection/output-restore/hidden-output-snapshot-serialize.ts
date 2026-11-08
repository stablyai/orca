import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isHostAnsweredSnapshotRetryCause } from '@/runtime/hosted-terminals/snapshots/remote-terminal-snapshot-outcome'
import { readE2eHiddenSnapshotOverride } from '../instrumentation/e2e-terminal-pty-harness'
import type { PtyBufferSnapshot } from '../../pty-transport/pty-transport-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

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
}

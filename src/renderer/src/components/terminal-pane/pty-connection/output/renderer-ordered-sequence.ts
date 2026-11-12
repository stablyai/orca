import type { PtyDataMeta } from '../../pty-transport/delivery/pty-dispatcher'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindRendererOrderedSequence(session: ConnectPanePtySession): void {
  session.recordRendererOrderedSeq = function (meta?: Pick<PtyDataMeta, 'seq'>): void {
    if (typeof meta?.seq !== 'number') {
      return
    }
    const ptyId = session.transport.getPtyId()
    if (!ptyId) {
      return
    }
    if (session.rendererOrderedPtyId !== ptyId) {
      session.rendererOrderedPtyId = ptyId
      session.rendererOrderedSeq = meta.seq
      return
    }
    session.rendererOrderedSeq = Math.max(session.rendererOrderedSeq ?? 0, meta.seq)
  }

  session.resetRendererOrderedSeqForPtyExit = (exitedPtyId: string): void => {
    // Why: an exit ends this ptyId's seq domain; a revived id restarts main's counter, so both seq high-water marks (ordered + restored baseline) must reset here or they drop revived bytes as duplicates.
    if (session.restoredSnapshotBaselinePtyId === exitedPtyId) {
      session.clearRestoredSnapshotBaseline()
    }
    if (session.rendererOrderedPtyId === exitedPtyId) {
      session.rendererOrderedPtyId = null
      session.rendererOrderedSeq = null
    }
    if (session.rendererChannelSeqPtyId === exitedPtyId) {
      session.rendererChannelSeqPtyId = null
      session.rendererChannelSeq = null
    }
    session.streamPosition.reset(exitedPtyId)
    session.skippedQueryCarry = null
  }

  session.observeRendererOrderedSeqRegression = function (meta: PtyDataMeta | undefined): void {
    if (typeof meta?.seq !== 'number') {
      return
    }
    const ptyId = session.transport.getPtyId()
    if (!ptyId) {
      return
    }
    if (session.rendererChannelSeqPtyId !== ptyId) {
      session.rendererChannelSeqPtyId = ptyId
      session.rendererChannelSeq = meta.seq
      return
    }
    if (session.rendererChannelSeq !== null && meta.seq < session.rendererChannelSeq) {
      // Why: pty:data is FIFO, so seq regresses only when a session revived without an observed exit and restarted its counter; drop the stale baseline.
      if (session.rendererOrderedPtyId === ptyId) {
        session.rendererOrderedPtyId = null
        session.rendererOrderedSeq = null
      }
      session.streamPosition.reset(ptyId)
      session.skippedQueryCarry = null
    }
    session.rendererChannelSeq = meta.seq
  }

  session.getHiddenRendererDataAfterOrderedSeq = function (
    data: string,
    meta: PtyDataMeta | undefined
  ): string | null {
    if (
      session.rendererOrderedPtyId === null ||
      session.rendererOrderedSeq === null ||
      session.transport.getPtyId() !== session.rendererOrderedPtyId
    ) {
      return data
    }
    return session.getChunkDataAfterSnapshot(
      { data, seq: meta?.seq, rawLength: meta?.rawLength },
      session.rendererOrderedSeq
    )
  }
}

import { useAppStore } from '@/store'
import { parseTerminalKittyKeyboardFlags } from '../../../../../shared/terminal-kitty-keyboard-flags'
import {
  containsStatefulRendererQuery,
  extractHiddenStartupRendererQueryData
} from '../../../../../shared/terminal-reply-query-extraction'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import {
  resolveTerminalColorSchemeMode,
  scanMode2031ReplyDecision
} from '../../../../../shared/terminal-color-scheme-protocol'
import { installTerminalLiveScrollbackRestore } from '@/lib/pane-manager/terminal-live-scrollback-restore'
import type { PtyDataMeta } from '../pty-dispatcher'
import { sendTerminalOscColorQueryReplies } from '../terminal-capability-replies'

import { shouldWritePtyOutputForeground } from './foreground-output-scan'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindWritePtyOutputToXterm } from './write-pty-output-to-xterm'

import { bindAbandonHiddenOutputRestore } from './hidden-output-restore-abandon'
import { bindHiddenOutputRestoreChunk } from './hidden-output-restore-chunk'
import { bindHiddenStartupRendererQueryWrite } from './hidden-startup-renderer-query-write'

import { bindHiddenOutputRestoreDrain } from './hidden-output-restore-drain'

export function bindHiddenOutputSeqAndSkip(session: ConnectPanePtySession): void {
  // Why record-only: DECSET 2031 subscribes to future color changes, it is not a query —
  // the protocol's query is `CSI ?996n`. fish arms 2031 for the ~1ms it paints a prompt, so
  // any reply lands after the withdrawal and paints `?997;1n` as literal text (#9993).
  // Why here and not in xterm's CSI handler: xterm batches several PTY chunks into one
  // synchronous parse, so a handler cannot tell where a chunk ended. One raw chunk in,
  // one order-aware final state out.
  session.observeLiveMode2031Chunk = function (data: string): void {
    // Gate-managed PTYs never see these bytes; main's '2031-subscribe' fact records them.
    if (session.isHiddenDeliveryGateManagedPty(session.transport.getPtyId())) {
      return
    }
    const result = scanMode2031ReplyDecision(session.mode2031ReplyScanState, data)
    session.mode2031ReplyScanState = result.state
    if (result.decision === 'unsubscribed') {
      session.deps.paneMode2031Ref.current.delete(session.pane.id)
      session.deps.paneLastThemeModeRef.current.delete(session.pane.id)
    }
    if (result.decision !== 'subscribed') {
      return
    }
    const settings = useAppStore.getState().settings
    // Why seed the mode: maybePushMode2031Flip only pushes on a change, so an unseeded
    // subscription would read as a flip on the next unrelated appearance re-apply.
    session.deps.paneMode2031Ref.current.set(session.pane.id, true)
    session.deps.paneLastThemeModeRef.current.set(
      session.pane.id,
      resolveTerminalColorSchemeMode(settings, getSystemPrefersDark())
    )
  }

  // Why installed here: the handler observes CSI 3 J inside xterm's parse, so a
  // redraw split across PTY chunks is reported once, with the pane's rows for
  // this write already applied.
  session.liveScrollbackRestore?.dispose()
  session.liveScrollbackRestore = installTerminalLiveScrollbackRestore(session.pane.terminal)

  // Why read it live: `?1049` is not a no-op when the pane is already on the
  // target buffer — xterm still runs restoreCursor and swaps the kitty flag
  // registers — so the replay prologue must only switch when it truly differs.
  //
  // Best-effort by design. xterm parses asynchronously, so this sees only
  // PARSED writes; a `?1049` transition still queued reads stale. Draining
  // first with a write sentinel was tried and reverted: it puts the repaint
  // behind xterm's queue, so a wedged terminal stalls recovery, and it breaks
  // the disposal/cancellation ordering the restore paths rely on. A stale read
  // costs one mis-scoped buffer switch; the barrier costs the repaint.
  session.isPaneOnAlternateScreen = function (): boolean {
    return session.pane.terminal.buffer.active.type === 'alternate'
  }

  bindWritePtyOutputToXterm(session)
  session.markHiddenOutputRestoreNeeded = function (): void {
    const ptyId = session.transport.getPtyId()
    if (!session.canUseHiddenOutputSnapshot(ptyId)) {
      return
    }
    if (session.hiddenOutputRestorePtyId !== null && session.hiddenOutputRestorePtyId !== ptyId) {
      session.clearHiddenOutputRestoreState()
    }
    session.hiddenOutputRestorePtyId = ptyId
    session.hiddenOutputRestoreNeeded = true
    if (shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)) {
      session.requestHiddenOutputRestoreIfNeeded()
    }
  }

  session.shouldSkipHiddenRendererOutput = function (foreground: boolean, data: string): boolean {
    const ptyId = session.transport.getPtyId()
    if (
      foreground ||
      (!session.shouldSnapshotHiddenCodexOutput && session.remoteOutputGatedPtyId !== ptyId) ||
      !session.canUseHiddenOutputSnapshot(ptyId)
    ) {
      return false
    }
    // Why: CPR/DECRQM replies depend on ordered state; keep a clean stateful-query chunk live, but after skipped bytes avoid stale replies.
    return session.hiddenRendererStateDirty || !containsStatefulRendererQuery(data)
  }

  session.writeHiddenStartupRendererQueries = function (data: string): void {
    const extracted = extractHiddenStartupRendererQueryData(
      data,
      session.hiddenStartupRendererQueryPending
    )
    session.hiddenStartupRendererQueryPending = extracted.pending
    if (extracted.oscColorQueryData) {
      // Why: Codex's startup palette probe has a 100ms budget; answer hidden color queries immediately so scheduling/remote-input debounce (#7329) can't miss it.
      sendTerminalOscColorQueryReplies(
        extracted.oscColorQueryData,
        session.pane.terminal,
        session.sendDesktopQueryReplyImmediate
      )
    }
    if (extracted.statelessQueryData) {
      session.writePtyOutputToXterm(extracted.statelessQueryData, false, {
        hiddenStartupRendererQuery: true
      })
    }
    // Stateful hidden queries need ordered terminal state; if the hidden xterm is dirty, skip rather than send stale CPR/DECRQM.
  }

  bindHiddenStartupRendererQueryWrite(session)
  bindHiddenOutputRestoreChunk(session)
  /**
   * Apply an authoritative snapshot to the pane's kitty mirror in the order:
   * unproven reset, replay-semantics scan of the snapshot
   * bytes (so screen selection lands first), then the owner's proven flags.
   *
   * Why the reset only happens when the owner proved something: an old host
   * omits the field, and downgrading a mirror that is already tracking live
   * output would lose correct state instead of preserving it.
   */
  session.applySnapshotKittyKeyboardModes = function (
    snapshotData: string,
    snapshot: { kittyKeyboardFlags?: number; snapshotSeq?: number }
  ): void {
    const proven =
      snapshot.snapshotSeq === undefined
        ? undefined
        : parseTerminalKittyKeyboardFlags(snapshot.kittyKeyboardFlags)
    if (proven === undefined) {
      // Why the demotion: a mirror grounded in this PTY's stream keeps its
      // state, but a constructor-fresh tracker (window reload) holds a
      // known-zero that was never proven for the reattached PTY — demote it
      // so the serializer cannot republish it downstream as host-proven
      // inactive.
      if (!session.kittyKeyboardModes.hasProvenBaseline) {
        session.kittyKeyboardModes.resetForSnapshot()
      }
      session.kittyKeyboardModes.scanReplay(snapshotData)
      return
    }
    session.kittyKeyboardModes.resetForSnapshot()
    session.kittyKeyboardModes.scanReplay(snapshotData)
    session.kittyKeyboardModes.restoreSnapshotFlags(proven)
    // Why in the same critical section: without the baseline a quiet pane
    // could not publish a coherent snapshot until unrelated output arrived.
    session.recordRendererOrderedSeq({ seq: snapshot.snapshotSeq })
  }

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

  bindHiddenOutputRestoreDrain(session)
  bindAbandonHiddenOutputRestore(session)
}

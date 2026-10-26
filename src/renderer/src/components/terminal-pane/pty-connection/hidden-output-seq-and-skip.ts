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
  // DECSET 2031 subscribes silently; late replies paint junk after fish withdraws it (#9993). Scan raw chunks because xterm batching hides per-chunk subscription state.
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
    // Seed the current mode so unrelated appearance reapply cannot masquerade as a theme flip.
    session.deps.paneMode2031Ref.current.set(session.pane.id, true)
    session.deps.paneLastThemeModeRef.current.set(
      session.pane.id,
      resolveTerminalColorSchemeMode(settings, getSystemPrefersDark())
    )
  }

  // Observe CSI 3 J inside xterm parse so split redraws report once with current rows already applied.
  session.liveScrollbackRestore?.dispose()
  session.liveScrollbackRestore = installTerminalLiveScrollbackRestore(session.pane.terminal)

  // Switch buffers only on mismatch: repeated ?1049 still restores cursor and swaps Kitty slots. Read parsed state best-effort; draining first can stall recovery and break cancellation.
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
    if (extracted.oscColorQueryData && session.shouldAnswerPaneOscColorQueries()) {
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
  /** Scan snapshot screen selection before owner-proven flags; only demote when the owner supplies evidence, preserving live-tracked state for older hosts. */
  session.applySnapshotKittyKeyboardModes = function (
    snapshotData: string,
    snapshot: { kittyKeyboardFlags?: number; snapshotSeq?: number }
  ): void {
    const proven =
      snapshot.snapshotSeq === undefined
        ? undefined
        : parseTerminalKittyKeyboardFlags(snapshot.kittyKeyboardFlags)
    if (proven === undefined) {
      // Fresh mirrors’ initial zero proves nothing about reattached PTYs; demote it before downstream serialization can claim known-inactive flags.
      if (!session.kittyKeyboardModes.hasProvenBaseline) {
        session.kittyKeyboardModes.resetForSnapshot()
      }
      session.kittyKeyboardModes.scanReplay(snapshotData)
      return
    }
    session.kittyKeyboardModes.resetForSnapshot()
    session.kittyKeyboardModes.scanReplay(snapshotData)
    session.kittyKeyboardModes.restoreSnapshotFlags(proven)
    // Publish the baseline atomically with flags so quiet panes can serialize coherently without waiting for more output.
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

import { safeFit, safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { waitForTerminalReplayWritesParsed } from '../replay-guard'
import {
  POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_DEAD_TUI_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_AFTER_BYTE_GAP
} from '../../../../../shared/terminal-mode-reset-profiles'
import {
  discardTerminalOutput,
  writeTerminalOutput
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { recordTerminalOutput } from '@/lib/pane-manager/pane-scroll'
import { presentPaneViewportPreservingSynchronizedOutput } from '@/lib/pane-manager/pane-webgl-renderer'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions,
  readProposedTerminalCols,
  shouldSkipAltFrameForWidthMismatch
} from '../terminal-snapshot-replay-paint'

import { HIDDEN_OUTPUT_RESTORE_UNAVAILABLE_WARNING } from './hidden-output-restore-limits'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { restoredSnapshotPaintsPrintableContent } from '../restored-snapshot-coverage'
import { recordTerminalFreezeBreadcrumb } from '../terminal-freeze-breadcrumbs'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindHiddenOutputRestoreSnapshot(session: ConnectPanePtySession): void {
  session.writeRestoreUnavailableWarning = function (): void {
    // The reset must parse before both the warning and any foreground drain.
    session.writePtyOutputToXterm(RESET_AFTER_BYTE_GAP, true)
    if (!shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)) {
      return
    }
    writeTerminalOutput(session.pane.terminal, HIDDEN_OUTPUT_RESTORE_UNAVAILABLE_WARNING, {
      foreground: true,
      beforeWrite: session.beforeTerminalOutputWrite
    })
  }

  session.applyMainBufferSnapshot = async function (snapshot: {
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    pendingDeliveryStartSeq?: number
    alternateScreen?: boolean
    scrollbackAnsi?: string
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  }): Promise<void> {
    const restorePtyId = session.transport.getPtyId()
    const restoreGeneration = session.hiddenOutputRestoreGeneration
    if (session.hiddenOutputSnapshotScrollRestore) {
      session.cancelSnapshotScrollRestore()
    }
    const scrollRestore = {
      ptyId: restorePtyId,
      generation: restoreGeneration,
      valid: true,
      started: false
    }
    session.hiddenOutputSnapshotScrollRestore = scrollRestore
    const colsBeforeReplay = session.pane.terminal.cols
    const rowsBeforeReplay = session.pane.terminal.rows
    const hasSnapshotDimensions = hasPositiveTerminalDimensions(snapshot.cols, snapshot.rows)
    let skippedAltFrame = false
    try {
      await session.structuralReplayCoordinator.run(
        async () => {
          if (
            !scrollRestore.valid ||
            session.disposed ||
            session.transport.getPtyId() !== scrollRestore.ptyId ||
            session.hiddenOutputRestoreGeneration !== scrollRestore.generation
          ) {
            return
          }
          scrollRestore.started = true
          if (typeof snapshot.seq === 'number') {
            session.hiddenOutputRestoreReplayingSnapshot = {
              seq: snapshot.seq,
              paintsContent: restoredSnapshotPaintsPrintableContent(snapshot),
              ...(typeof snapshot.pendingDeliveryStartSeq === 'number'
                ? { pendingDeliveryStartSeq: snapshot.pendingDeliveryStartSeq }
                : {})
            }
          }
          discardTerminalOutput(session.pane.terminal)
          if (
            hasSnapshotDimensions &&
            (session.pane.terminal.cols !== snapshot.cols ||
              session.pane.terminal.rows !== snapshot.rows)
          ) {
            // Why: xterm parses writes later; hold snapshot dimensions until the FIFO sentinel completes so serialized wraps stay exact.
            session.suppressStructuralReplayPtyResize = true
            try {
              session.pane.terminal.resize(snapshot.cols, snapshot.rows)
            } finally {
              session.suppressStructuralReplayPtyResize = false
            }
          }
          // Why here and not from the writes below: the mirror tracks what the
          // APPLICATION negotiated, so it must see the snapshot's own bytes
          // before adopting the flags main proved for this boundary.
          session.applySnapshotKittyKeyboardModes(
            `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`,
            {
              kittyKeyboardFlags: snapshot.kittyKeyboardFlags,
              snapshotSeq: snapshot.seq
            }
          )
          // Why shared: the SSH reattach model paint inlines the same
          // choreography (coordinator nesting would deadlock there); one
          // builder keeps the alt-screen branches from drifting.
          skippedAltFrame =
            snapshot.alternateScreen === true &&
            snapshot.frameRestoreAnsi !== undefined &&
            shouldSkipAltFrameForWidthMismatch(
              snapshot.cols,
              readProposedTerminalCols(session.pane)
            )
          // Why: an imageless success is not proof the pane is empty; normal replay clears screen and scrollback.
          const snapshotCarriesNoImage =
            snapshot.alternateScreen !== true && snapshot.data === '' && !snapshot.scrollbackAnsi
          if (snapshotCarriesNoImage) {
            // Why still ground: a restore only runs because bytes were dropped, so
            // the gap's pen outlives a snapshot that cannot repaint over it. The
            // live-path constant, not the replay baseline — nothing repaints here,
            // so the pane is handed back to whatever is still running.
            session.writeReplayData(RESET_AFTER_BYTE_GAP)
          } else {
            for (const replayChunk of buildMainModelSnapshotReplayWrites(snapshot, {
              skipAltFrame: skippedAltFrame,
              paneOnAlternateScreen: session.isPaneOnAlternateScreen()
            })) {
              session.writeReplayData(replayChunk)
            }
          }
          const hasLiveAgent = session.hasLiveAgentReattachStatusOrTitleSignal()
          // Why the pane-local fallback: every owner-publishing host also fills
          // alternateScreen, but the reattach site falls back to pane state for
          // an absent flag and this site must not drift from it (?1049l on a
          // normal-buffer pane still runs cursor restore).
          const postReplayReset =
            snapshot.terminalOwner === 'shell'
              ? (snapshot.alternateScreen ?? session.isPaneOnAlternateScreen())
                ? POST_REPLAY_DEAD_TUI_RESET
                : POST_REPLAY_REATTACH_RESET
              : hasLiveAgent
                ? POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET
                : POST_REPLAY_LIVE_SNAPSHOT_RESET
          session.writeReplayData(postReplayReset)
          if (snapshot.pendingEscapeTailAnsi) {
            // Why last: snapshot taken mid-escape; re-arm as the FINAL replay write (any later ESC aborts it) so the live tail completes it, not render literally (Bug E / #7329).
            session.writeReplayData(snapshot.pendingEscapeTailAnsi)
          }
          session.hiddenRendererStateDirty = false
          session.recordRendererOrderedSeq(snapshot)
          recordTerminalOutput(session.pane.terminal)
          await waitForTerminalReplayWritesParsed(session.pane.terminal)
          if (session.deps.isVisibleRef.current) {
            presentPaneViewportPreservingSynchronizedOutput(session.pane)
            recordTerminalFreezeBreadcrumb('stale-pixel-restore-present', {
              paneId: session.pane.id
            })
          }
        },
        {
          shouldRestore: () =>
            scrollRestore.valid &&
            !session.disposed &&
            session.transport.getPtyId() === scrollRestore.ptyId &&
            session.hiddenOutputRestoreGeneration === scrollRestore.generation,
          afterRestore: async () => {
            const isCurrentRestore = (): boolean =>
              scrollRestore.valid &&
              !session.disposed &&
              session.transport.getPtyId() === scrollRestore.ptyId &&
              session.hiddenOutputRestoreGeneration === scrollRestore.generation
            if (!isCurrentRestore()) {
              return
            }
            const currentPtyId = session.transport.getPtyId()
            if (!currentPtyId) {
              return
            }
            if (getFitOverrideForPty(currentPtyId)) {
              safeFit(session.pane)
              if (skippedAltFrame && !isRemoteRuntimePtyId(currentPtyId)) {
                window.api.pty.signal(currentPtyId, 'SIGWINCH')
              }
              return
            }
            const fit = safeFitAndThen(
              session.pane,
              'hidden-snapshot-pty-resize',
              () => {
                if (!isCurrentRestore() || session.transport.getPtyId() !== currentPtyId) {
                  return
                }
                const replayChangedDimensions = hasSnapshotDimensions
                  ? session.pane.terminal.cols !== snapshot.cols ||
                    session.pane.terminal.rows !== snapshot.rows
                  : session.pane.terminal.cols !== colsBeforeReplay ||
                    session.pane.terminal.rows !== rowsBeforeReplay
                if (skippedAltFrame) {
                  session.pulseVisibleLocalPtySizeForTuiRepaint(currentPtyId)
                  return
                }
                if (replayChangedDimensions && session.isRendererPtyResizeAuthoritative()) {
                  session.transport.resize(session.pane.terminal.cols, session.pane.terminal.rows)
                  if (!isRemoteRuntimePtyId(currentPtyId)) {
                    // Why: redundant SIGWINCH makes alt-screen TUIs rebuild their scroll viewport to the top on tab return.
                    window.api.pty.signal(currentPtyId, 'SIGWINCH')
                  }
                }
              },
              {
                shouldContinue: isCurrentRestore,
                retryIfUnmeasurable: true,
                // A skipped frame is blank until this fit pushes the final
                // grid/SIGWINCH, so carry the continuation through reveal.
                deferIfHidden: true
              }
            )
            session.pendingHiddenSnapshotFit = fit
            try {
              await fit.completion
            } finally {
              if (session.pendingHiddenSnapshotFit === fit) {
                session.pendingHiddenSnapshotFit = null
              }
            }
            if (isCurrentRestore()) {
              session.scheduleReattachIdleAgentCursorReset()
            }
          }
        }
      )
    } finally {
      if (session.hiddenOutputSnapshotScrollRestore === scrollRestore) {
        session.hiddenOutputSnapshotScrollRestore = null
      }
    }
  }
}

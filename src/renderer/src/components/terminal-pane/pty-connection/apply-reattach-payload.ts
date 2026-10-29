import {
  applyTerminalLaunchResult,
  captureTerminalLaunchContext
} from './terminal-launch-result-policy'
import { waitForTerminalReplayWritesParsed } from '../replay-guard'
import {
  POST_REPLAY_MODE_RESET,
  RESET_GRAPHIC_RENDITION,
  RELEASE_SYNCHRONIZED_OUTPUT
} from '../../../../../shared/terminal-mode-reset-profiles'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions,
  readProposedTerminalCols,
  resolvePositiveTerminalDimensions,
  shouldSkipAltFrameForWidthMismatch
} from '../terminal-snapshot-replay-paint'

import { restoredSnapshotPaintsPrintableContent } from '../restored-snapshot-coverage'
import { ackPaintedColdRestore } from './painted-cold-restore-ack'
import { mainStartsPane } from './main-starts-pane'
import { fitReattachedPaneToGrid, noteReattachAltFrameSkip } from './reattach-grid-fit'

import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ReattachPayloadSession } from './reattach-payload-session'

export function createReattachPayloadHandlers(
  session: ReattachPayloadSession,
  ctx: ReattachPayloadContext
): {
  applyReattachPayload: () => Promise<void>
  fitAfterReattachRestore: () => Promise<void>
} {
  const applyReattachPayload = async (): Promise<void> => {
    if (!ctx.isCurrentReattachPayload()) {
      return
    }
    if (ctx.connectResult?.snapshot) {
      const snapshotPrefixAnsi = ctx.connectResult.snapshotPrefixAnsi
      const snapshotFrameAnsi = ctx.connectResult.snapshotFrameAnsi
      const snapshotFrameRestoreAnsi = ctx.connectResult.snapshotFrameRestoreAnsi
      const hasSplitDaemonAltFrame =
        typeof snapshotPrefixAnsi === 'string' &&
        snapshotPrefixAnsi.length > 0 &&
        typeof snapshotFrameAnsi === 'string' &&
        snapshotFrameAnsi.length > 0
      const daemonSnapshotReplay = hasSplitDaemonAltFrame
        ? snapshotPrefixAnsi + snapshotFrameAnsi
        : ctx.connectResult.snapshot
      session.rememberReattachPayloadAgentSignal(daemonSnapshotReplay, { fullScreenReplay: true })
      // Replay at capture geometry to preserve wraps; suppress layout-only resize forwarding so it cannot SIGWINCH the host TUI (#7279).
      const snapshotDimensions = resolvePositiveTerminalDimensions(
        ctx.connectResult.snapshotCols,
        ctx.connectResult.snapshotRows
      )
      if (
        snapshotDimensions &&
        (session.pane.terminal.cols !== snapshotDimensions.cols ||
          session.pane.terminal.rows !== snapshotDimensions.rows)
      ) {
        session.suppressStructuralReplayPtyResize = true
        try {
          session.pane.terminal.resize(snapshotDimensions.cols, snapshotDimensions.rows)
        } finally {
          session.suppressStructuralReplayPtyResize = false
        }
      }
      session.writeReplayData(
        `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[3J\x1b[H`
      )
      // Why: re-arm the kitty keyboard mirror from the snapshot preamble so Option chords keep their encoding after a window reload.
      session.applySnapshotKittyKeyboardModes(daemonSnapshotReplay, {
        kittyKeyboardFlags: ctx.connectResult.snapshotKittyKeyboardFlags,
        snapshotSeq: ctx.connectResult.snapshotSeq
      })
      // Drop clipped foreign-width live frames for SIGWINCH repaint; dead owners retain history without showing a frozen frame as live.
      const daemonAltFrameSkippable =
        hasSplitDaemonAltFrame &&
        typeof snapshotFrameRestoreAnsi === 'string' &&
        noteReattachAltFrameSkip(
          ctx,
          shouldSkipAltFrameForWidthMismatch(
            ctx.connectResult.snapshotCols,
            readProposedTerminalCols(session.pane)
          ),
          ctx.connectResult.snapshotCols
        )
      const groundDaemonSnapshot =
        Boolean(ctx.connectResult.coldRestore) ||
        (!session.shouldPreserveAgentReattachModes() &&
          !(ctx.connectResult.isAlternateScreen ?? session.kittyKeyboardModes.isAlternateScreen))
      session.writeReplayData(
        `${groundDaemonSnapshot ? RESET_GRAPHIC_RENDITION : ''}${
          daemonAltFrameSkippable
            ? snapshotPrefixAnsi + snapshotFrameRestoreAnsi
            : daemonSnapshotReplay
        }`
      )
      session.writeReplayEpilogue(
        session.chooseReattachReplayReset(
          daemonSnapshotReplay,
          Boolean(ctx.connectResult.coldRestore),
          ctx.connectResult.isAlternateScreen,
          ctx.connectResult.snapshotTerminalOwner
        )
      )
      if (ctx.connectResult.pendingEscapeTailAnsi) {
        // Why last: re-arm the dangling mid-escape after the reset (whose ESC would abort it) so the live continuation completes it (#7329).
        session.writeReplayData(ctx.connectResult.pendingEscapeTailAnsi)
      }
      // The initial attach backlog can contain bytes already painted by this snapshot.
      session.setRestoredSnapshotBaseline(
        ctx.ptyId,
        { seq: ctx.connectResult.snapshotSeq },
        restoredSnapshotPaintsPrintableContent({ data: daemonSnapshotReplay })
      )
      session.recordRendererOrderedSeq({ seq: ctx.connectResult.snapshotSeq })
      session.sendFocusedReattachFocusInAfterReplay(ctx.ptyId, ctx.attemptGeneration)
      if (ctx.connectResult.coldRestore) {
        // Snapshot superseded the cold-restore payload; ack so the daemon doesn't redeliver it.
        ackPaintedColdRestore(session, ctx.ptyId)
      }
    } else if (ctx.connectResult?.replay || ctx.prefetchedParkModelSnapshot) {
      // Only park-reveal needs this lookup; in-place reconnect already carries its replay.
      const modelSnapshot = ctx.revealFollowsTerminalPark ? ctx.prefetchedParkModelSnapshot : null
      if (!ctx.isCurrentReattachPayload()) {
        return
      }
      if (modelSnapshot) {
        // Scan/reset needs composed snapshot bytes; actual writes use alt-screen choreography to preserve scrollback.
        const modelData = `${modelSnapshot.scrollbackAnsi ?? ''}${modelSnapshot.data}`
        session.rememberReattachPayloadAgentSignal(modelData, {
          fullScreenReplay: true,
          imageTitle: modelSnapshot.lastTitle
        })
        const modelCols = modelSnapshot.cols
        const modelRows = modelSnapshot.rows
        if (
          hasPositiveTerminalDimensions(modelCols, modelRows) &&
          (session.pane.terminal.cols !== modelCols || session.pane.terminal.rows !== modelRows)
        ) {
          // Why: replay at the snapshot's own dimensions (see the daemon-snapshot branch, #7279).
          session.suppressStructuralReplayPtyResize = true
          try {
            session.pane.terminal.resize(modelCols, modelRows)
          } finally {
            session.suppressStructuralReplayPtyResize = false
          }
        }
        session.applySnapshotKittyKeyboardModes(modelData, {
          kittyKeyboardFlags: modelSnapshot.kittyKeyboardFlags,
          snapshotSeq: modelSnapshot.seq
        })
        // Share alt-screen rebuild with model snapshots; nesting replay coordinators here would deadlock.
        for (const replayChunk of buildMainModelSnapshotReplayWrites(modelSnapshot, {
          skipAltFrame: noteReattachAltFrameSkip(
            ctx,
            shouldSkipAltFrameForWidthMismatch(modelCols, readProposedTerminalCols(session.pane)),
            modelCols
          ),
          paneOnAlternateScreen: session.isPaneOnAlternateScreen()
        })) {
          session.writeReplayData(replayChunk)
        }
        session.writeReplayEpilogue(
          session.chooseReattachReplayReset(
            modelData,
            Boolean(ctx.connectResult?.coldRestore),
            modelSnapshot.alternateScreen ?? ctx.connectResult?.isAlternateScreen,
            modelSnapshot.terminalOwner,
            modelSnapshot.lastTitle
          )
        )
        if (modelSnapshot.pendingEscapeTailAnsi) {
          // Why last: re-arm the dangling mid-escape after the reset so the live continuation completes it (#7329).
          session.writeReplayData(modelSnapshot.pendingEscapeTailAnsi)
        }
        // Why: main sampled its delivery backlog with the snapshot; the baseline drops/slices deferred and live chunks the snapshot already covers.
        session.setRestoredSnapshotBaseline(
          ctx.ptyId,
          modelSnapshot,
          restoredSnapshotPaintsPrintableContent(modelSnapshot)
        )
        session.recordRendererOrderedSeq(modelSnapshot)
        session.sendFocusedReattachFocusInAfterReplay(ctx.ptyId, ctx.attemptGeneration)
        if (ctx.connectResult?.coldRestore) {
          ackPaintedColdRestore(session, ctx.ptyId)
        }
      } else if (ctx.connectResult?.replay) {
        session.rememberReattachPayloadAgentSignal(ctx.connectResult.replay, {
          fullScreenReplay: true
        })
        // Relay replay may overlap xterm's pre-disconnect content; clear first to avoid duplication.
        session.writeReplayData(
          `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[3J\x1b[H`
        )
        // Replay Kitty pushes with set semantics to avoid stack growth; fresh mirrors stay unproven for negotiations predating replay.
        session.kittyKeyboardModes.adoptSnapshot(ctx.connectResult.replay, undefined)
        session.writeReplayData(
          `${ctx.connectResult.coldRestore ? RESET_GRAPHIC_RENDITION : ''}${ctx.connectResult.replay}`
        )
        session.writeReplayEpilogue(
          session.chooseReattachReplayReset(
            ctx.connectResult.replay,
            Boolean(ctx.connectResult.coldRestore),
            ctx.connectResult.isAlternateScreen
          )
        )
        session.sendFocusedReattachFocusInAfterReplay(ctx.ptyId, ctx.attemptGeneration)
        if (ctx.connectResult.coldRestore) {
          ackPaintedColdRestore(session, ctx.ptyId)
        }
      }
    } else if (ctx.connectResult?.coldRestore) {
      let destinationRows = session.pane.terminal.rows
      try {
        const proposedDestination = session.pane.fitAddon.proposeDimensions()
        if (
          proposedDestination &&
          Number.isFinite(proposedDestination.rows) &&
          proposedDestination.rows > 0
        ) {
          destinationRows = Math.max(destinationRows, proposedDestination.rows)
        }
      } catch {
        // The current xterm grid remains a safe lower bound for blanking.
      }
      // Why: shrinking first would promote clipped stale viewport rows into scrollback, beyond the reach of a later viewport-only clear.
      session.writeReplayData(
        `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[H`
      )
      await waitForTerminalReplayWritesParsed(session.pane.terminal)
      if (!ctx.isCurrentReattachPayload()) {
        return
      }
      const coldRestoreDimensions = resolvePositiveTerminalDimensions(
        ctx.connectResult.coldRestore.cols,
        ctx.connectResult.coldRestore.rows
      )
      if (
        coldRestoreDimensions &&
        (session.pane.terminal.cols !== coldRestoreDimensions.cols ||
          session.pane.terminal.rows !== coldRestoreDimensions.rows)
      ) {
        // Why: recovered ANSI cursor positions belong to the checkpoint's grid; keep this layout-only resize from reaching the fresh PTY.
        session.suppressStructuralReplayPtyResize = true
        try {
          session.pane.terminal.resize(coldRestoreDimensions.cols, coldRestoreDimensions.rows)
        } finally {
          session.suppressStructuralReplayPtyResize = false
        }
      }
      // Guard raw replay queries from auto-replying into the fresh shell (replay-guard.ts).
      session.writeReplayData(
        `${RESET_GRAPHIC_RENDITION}${ctx.connectResult.coldRestore.scrollback}`
      )
      // An existing owner permits history replay, not another saved continuation.
      let resumeUnavailable = Boolean(ctx.connectResult.agentResumeUnavailable)
      let preparedStartup =
        mainStartsPane(session) ||
        ctx.connectResult.isReattach === true ||
        ctx.connectResult.agentResumeRefused ||
        resumeUnavailable
          ? null
          : (ctx.coldRestoreStartup ?? session.buildColdRestoreAgentResumeStartup())
      if (preparedStartup && !ctx.coldRestoreStartup) {
        const rejected = applyTerminalLaunchResult(
          session,
          ctx.connectResult,
          captureTerminalLaunchContext(session, preparedStartup),
          'candidate'
        )
        if (rejected) {
          resumeUnavailable = true
          preparedStartup = null
        }
      }
      const didPrepareResume =
        ctx.connectResult.isReattach !== true &&
        session.applyColdRestoreAgentResumeStartup(preparedStartup)
      if (resumeUnavailable) {
        // Dropped resume argv starts a new session; the restored banner must not claim the old session returned.
        session.showSessionRestoredBanner('resume-unavailable')
      } else if (didPrepareResume && preparedStartup?.hasSleepingRecord) {
        session.showSessionRestoredBanner()
      }
      if (didPrepareResume) {
        session.clearSleepingRecordAfterColdRestoreSpawn(preparedStartup)
      }
      // Why: cold-restore spawned a fresh shell; reset mode bytes a crashed TUI (e.g. Claude's \e[?1004h) left in scrollback that no live TUI now consumes.
      session.writeInputModeGround(POST_REPLAY_MODE_RESET)
      session.consumeRestoredViewportBlankingMarker()
      // Why: a taller destination fit must not pull recovered rows back into the fresh shell's viewport after source-grid replay.
      session.writeFreshShellViewportBlanking(Math.max(destinationRows, session.pane.terminal.rows))
      ackPaintedColdRestore(session, ctx.ptyId)
      if (didPrepareResume && !ctx.coldRestoreStartup) {
        session.schedulePendingStartupCommandDelivery()
      }
    }
    if (ctx.shouldApplyStructuralPayload) {
      await waitForTerminalReplayWritesParsed(session.pane.terminal)
      if (!ctx.isCurrentReattachPayload()) {
        return
      }
      ctx.reattachPayloadApplied = true
    }
  }

  const fitAfterReattachRestore = (): Promise<void> => fitReattachedPaneToGrid(session, ctx)

  return { applyReattachPayload, fitAfterReattachRestore }
}

import { safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { waitForTerminalReplayWritesParsed } from '../replay-guard'
import {
  POST_REPLAY_MODE_RESET,
  RESET_GRAPHIC_RENDITION
} from '../../../../../shared/terminal-mode-reset-profiles'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions,
  readProposedTerminalCols,
  resolvePositiveTerminalDimensions,
  shouldSkipAltFrameForWidthMismatch
} from '../terminal-snapshot-replay-paint'

import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { restoredSnapshotPaintsPrintableContent } from '../restored-snapshot-coverage'

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
      // Why: replay at the snapshot's own dimensions to avoid rewrapping soft-wrapped rows at a different column count (#7279); suppress the PTY forward so this layout-only resize doesn't SIGWINCH the remote TUI.
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
      session.writeReplayData(`${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[3J\x1b[H`)
      // Why: re-arm the kitty keyboard mirror from the snapshot preamble so Option chords keep their encoding after a window reload.
      session.applySnapshotKittyKeyboardModes(daemonSnapshotReplay, {
        kittyKeyboardFlags: ctx.connectResult.snapshotKittyKeyboardFlags,
        snapshotSeq: ctx.connectResult.snapshotSeq
      })
      // A narrower fit clips the fixed-grid alt frame; drop it and let SIGWINCH repaint.
      // A dead-owner restore keeps history plus its restored-session treatment;
      // a frozen foreign-width frame would look live when no owner remains.
      const daemonAltFrameSkippable =
        hasSplitDaemonAltFrame &&
        typeof snapshotFrameRestoreAnsi === 'string' &&
        shouldSkipAltFrameForWidthMismatch(
          ctx.connectResult.snapshotCols,
          readProposedTerminalCols(session.pane)
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
      session.writeReplayData(
        session.reattachReplayResetSequence(
          daemonSnapshotReplay,
          Boolean(ctx.connectResult.coldRestore),
          ctx.connectResult.isAlternateScreen
        )
      )
      if (ctx.connectResult.pendingEscapeTailAnsi) {
        // Why last: re-arm the dangling mid-escape after the reset (whose ESC would abort it) so the live continuation completes it (#7329).
        session.writeReplayData(ctx.connectResult.pendingEscapeTailAnsi)
      }
      session.sendFocusedReattachFocusInAfterReplay(ctx.ptyId, ctx.attemptGeneration)
      if (ctx.connectResult.coldRestore) {
        // Snapshot superseded the cold-restore payload; ack so the daemon doesn't redeliver it.
        if (!isRemoteRuntimePtyId(ctx.ptyId)) {
          window.api.pty.ackColdRestore(ctx.ptyId)
        }
      }
    } else if (ctx.connectResult?.replay || ctx.prefetchedParkModelSnapshot) {
      // Why scoped to a park-reveal: the 100KiB relay tail loses scrollback the
      // model still holds, but an in-place reattach (network reconnect, wake,
      // reload) already has that replay in hand, so probing would only delay its
      // paint by the timeout. Memoized, so this is never a second probe.
      const modelSnapshot = ctx.revealFollowsTerminalPark
        ? (ctx.prefetchedParkModelSnapshot ??
          (isRemoteRuntimePtyId(ctx.ptyId) ? null : await ctx.fetchSshMainModelReattachSnapshot()))
        : null
      if (!ctx.isCurrentReattachPayload()) {
        return
      }
      if (modelSnapshot) {
        // Why composed for scan/reset only: kitty + reset heuristics need
        // the full byte stream; the actual writes go through the shared
        // alt-screen choreography below (scrollbackAnsi is '' for
        // normal-buffer snapshots, so composition matches data there).
        const modelData = `${modelSnapshot.scrollbackAnsi ?? ''}${modelSnapshot.data}`
        session.rememberReattachPayloadAgentSignal(modelData, { fullScreenReplay: true })
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
        // Why shared: park+reveal of an alt-screen TUI needs the same
        // ?1049l/?1049h rebuild as applyMainBufferSnapshot (main strips
        // the ?1049h marker when splitting scrollbackAnsi) — inlined here
        // because nesting structuralReplayCoordinator would deadlock.
        for (const replayChunk of buildMainModelSnapshotReplayWrites(modelSnapshot, {
          skipAltFrame: shouldSkipAltFrameForWidthMismatch(
            modelCols,
            readProposedTerminalCols(session.pane)
          ),
          paneOnAlternateScreen: session.isPaneOnAlternateScreen()
        })) {
          session.writeReplayData(replayChunk)
        }
        session.writeReplayData(
          session.reattachReplayResetSequence(
            modelData,
            Boolean(ctx.connectResult?.coldRestore),
            modelSnapshot.alternateScreen ?? ctx.connectResult?.isAlternateScreen
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
        if (ctx.connectResult?.coldRestore && !isRemoteRuntimePtyId(ctx.ptyId)) {
          window.api.pty.ackColdRestore(ctx.ptyId)
        }
      } else if (ctx.connectResult?.replay) {
        session.rememberReattachPayloadAgentSignal(ctx.connectResult.replay, {
          fullScreenReplay: true
        })
        // Relay replay may overlap xterm's pre-disconnect content; clear first to avoid duplication.
        session.writeReplayData(`${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[3J\x1b[H`)
        // Why: raw relay replay may contain the app's own kitty pushes; re-arm with set semantics so redelivery can't grow the stack.
        // A constructor-fresh mirror (window reload) first demotes to unproven:
        // the replay window proves nothing about negotiations that predate it.
        if (!session.kittyKeyboardModes.hasProvenBaseline) {
          session.kittyKeyboardModes.resetForSnapshot()
        }
        session.kittyKeyboardModes.scanReplay(ctx.connectResult.replay)
        session.writeReplayData(
          `${ctx.connectResult.coldRestore ? RESET_GRAPHIC_RENDITION : ''}${ctx.connectResult.replay}`
        )
        session.writeReplayData(
          session.reattachReplayResetSequence(
            ctx.connectResult.replay,
            Boolean(ctx.connectResult.coldRestore),
            ctx.connectResult.isAlternateScreen
          )
        )
        session.sendFocusedReattachFocusInAfterReplay(ctx.ptyId, ctx.attemptGeneration)
        if (ctx.connectResult.coldRestore) {
          if (!isRemoteRuntimePtyId(ctx.ptyId)) {
            window.api.pty.ackColdRestore(ctx.ptyId)
          }
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
      session.writeReplayData(`${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[H`)
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
      // Why: recorded scrollback is raw PTY output that may hold query sequences; xterm.write would auto-reply into the new shell's stdin. See replay-guard.ts.
      session.writeReplayData(
        `${RESET_GRAPHIC_RENDITION}${ctx.connectResult.coldRestore.scrollback}`
      )
      const preparedStartup = ctx.coldRestoreStartup ?? session.buildColdRestoreAgentResumeStartup()
      const didPrepareResume = session.applyColdRestoreAgentResumeStartup(preparedStartup)
      if (didPrepareResume) {
        if (ctx.connectResult.agentResumeUnavailable) {
          // Why: main dropped the resume argv, so this pane is a NEW session —
          // the plain restored banner would claim the old one came back.
          session.showSessionRestoredBanner('resume-unavailable')
        } else if (preparedStartup?.hasSleepingRecord) {
          session.showSessionRestoredBanner()
        }
        session.clearSleepingRecordAfterColdRestoreSpawn(preparedStartup)
      }
      // Why: cold-restore spawned a fresh shell; reset mode bytes a crashed TUI (e.g. Claude's \e[?1004h) left in scrollback that no live TUI now consumes.
      session.writeReplayData(POST_REPLAY_MODE_RESET)
      // Why: the dead run's kitty flags died with it and its scrollback was never scanned — the fresh shell starts at zero.
      session.kittyKeyboardModes.reset()
      session.consumeRestoredViewportBlankingMarker()
      // Why: a taller destination fit must not pull recovered rows back into the fresh shell's viewport after source-grid replay.
      session.writeFreshShellViewportBlanking(Math.max(destinationRows, session.pane.terminal.rows))
      if (!isRemoteRuntimePtyId(ctx.ptyId)) {
        window.api.pty.ackColdRestore(ctx.ptyId)
      }
      if (didPrepareResume && !ctx.coldRestoreStartup) {
        session.schedulePendingStartupCommandDelivery()
      }
    }
    if (ctx.hasStructuralReplay || ctx.prefetchedParkModelSnapshot) {
      await waitForTerminalReplayWritesParsed(session.pane.terminal)
      if (!ctx.isCurrentReattachPayload()) {
        return
      }
      ctx.reattachPayloadApplied = true
    }
  }

  const fitAfterReattachRestore = async (): Promise<void> => {
    if (!ctx.isCurrentReattachPayload()) {
      return
    }
    const reattachPtyId = session.transport.getPtyId()
    if (!reattachPtyId) {
      return
    }
    if (!getFitOverrideForPty(reattachPtyId)) {
      const gridPush = session.createReattachGridPush(ctx.attemptGeneration, reattachPtyId)
      const fit = safeFitAndThen(session.pane, 'reattach-pty-resize', gridPush.continuation, {
        shouldContinue: gridPush.shouldContinue,
        retryIfUnmeasurable: true,
        // Why only this caller: a restored floating workspace is display:none until the
        // user opens it, so dropping the grid push strands the PTY at the replay grid.
        deferIfHidden: true
      })
      session.pendingReattachFit = fit
      try {
        // Why: reattach resize is fire-and-forget, so the continuation itself requests the
        // applied-grid verification — it is the only point reached by both the immediate
        // and the deferred-until-revealed path.
        await fit.completion
      } finally {
        if (session.pendingReattachFit === fit) {
          session.pendingReattachFit = null
        }
      }
    } else if (ctx.isCurrentReattachPayload() && !isRemoteRuntimePtyId(reattachPtyId)) {
      window.api.pty.signal(reattachPtyId, 'SIGWINCH')
    }
  }

  return { applyReattachPayload, fitAfterReattachRestore }
}

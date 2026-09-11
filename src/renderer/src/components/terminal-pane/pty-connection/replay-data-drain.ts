import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { safeFit, safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'

import { resolvePositiveTerminalDimensions } from '../terminal-snapshot-replay-paint'

import {
  CURSOR_SHOW_SEQUENCE,
  TERMINAL_FOCUS_IN_SEQUENCE,
  FOCUS_REPORTING_DISABLE_SEQUENCE
} from './foreground-output-scan'
import {
  parsedViewportShowsParkedCursorAgentScreen,
  terminalHasFocusReportingEnabled
} from './cursor-agent-reattach-screen'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindReplayDataDrain(session: ConnectPanePtySession): void {
  session.sendFocusedReattachFocusInAfterReplay = (
    expectedPtyId: string | null = session.transport.getPtyId(),
    expectedStreamGeneration = session.transportStreamGeneration
  ): void => {
    const scheduledGeneration = session.reattachReplayPayloadSignalGeneration
    void waitForTerminalOutputParsed(session.pane.terminal).then(() => {
      const currentPtyId = session.transport.getPtyId()
      if (
        session.disposed ||
        expectedStreamGeneration !== session.transportStreamGeneration ||
        currentPtyId !== expectedPtyId
      ) {
        return
      }
      // Why: a newer replay frame owns the judgment; its own post-parse
      // callback will re-evaluate against its own viewport.
      if (scheduledGeneration !== session.reattachReplayPayloadSignalGeneration) {
        return
      }
      // Why: the replay-byte signal also matches a dead run's screen — in
      // scrollback or still painted above a fresh shell prompt. The parsed
      // viewport is the ground truth; unless it shows a parked-cursor
      // cursor-agent screen and no status/title corroborates, downgrade to
      // the plain-shell behavior (drop focus reporting, skip focus-in).
      if (
        !session.hasLiveAgentReattachStatusOrTitleSignal() &&
        session.reattachReplayPayloadHasCursorAgentSignal
      ) {
        if (parsedViewportShowsParkedCursorAgentScreen(session.pane.terminal) === false) {
          session.reattachReplayPayloadHasCursorAgentSignal = false
          // Why: the live-agent reset preserved the payload's ?25l; a plain
          // shell never re-shows the cursor itself.
          session.writeReplayData(`${CURSOR_SHOW_SEQUENCE}${FOCUS_REPORTING_DISABLE_SEQUENCE}`)
          return
        }
      }
      // Why: a live TUI such as cursor-agent parks the real terminal cursor off
      // its own input caret and moves it back only on a focus-in. Reattach
      // reuses the same live PTY and the xterm textarea already holds DOM
      // focus, so xterm never emits the focus-in the agent needs and the parked
      // cursor anchors the IME/caret to the wrong cell. Gated on ?1004h so a
      // bare shell never receives a stray \x1b[I.
      const sendFocusMode = terminalHasFocusReportingEnabled(session.pane.terminal)
      if (!session.shouldSendFocusedAgentReattachFocusIn() || !sendFocusMode) {
        return
      }
      session.transport.sendInput(TERMINAL_FOCUS_IN_SEQUENCE)
    })
  }

  session.pendingReplayData = null
  session.replayPayloadGeneration = 0
  let replayDrainQueued = false
  // Why: a payload replayed at a foreign grid leaves xterm sized to the source,
  // so the destination fit belongs after the whole transaction parses.
  let replayedAtSourceGrid = false
  const drainReplayDataQueue = async (
    expectedPtyId: string | null,
    expectedStreamGeneration: number
  ): Promise<boolean> => {
    let appliedCurrentPayload = false
    while (session.pendingReplayData !== null) {
      if (
        session.pendingReplayData.ptyId !== expectedPtyId ||
        session.pendingReplayData.streamGeneration !== expectedStreamGeneration
      ) {
        return false
      }
      if (
        session.transport.getPtyId() !== expectedPtyId ||
        session.transportStreamGeneration !== expectedStreamGeneration
      ) {
        session.pendingReplayData = null
        return false
      }
      const payload = session.pendingReplayData
      const {
        data,
        clearBeforeReplay,
        pendingEscapeTailAnsi,
        alternateScreen,
        terminalOwner,
        snapshotCols,
        snapshotRows
      } = payload
      session.pendingReplayData = null
      const isCurrentPayload = (): boolean =>
        !session.disposed &&
        payload.generation === session.replayPayloadGeneration &&
        payload.streamGeneration === session.transportStreamGeneration &&
        session.transport.getPtyId() === payload.ptyId
      if (!isCurrentPayload()) {
        continue
      }
      // Relay replay buffers may overlap with content already rendered in
      // xterm. Local eager replay decides this earlier so metadata-only frames
      // can keep restored scrollback while still using the replay guard.
      // Why ahead of the source-grid resize: the clear is grid-independent, so
      // dropping the scrollback first spares a reflow of history the very next
      // sequence discards (see use-terminal-container-fit-sync.ts on its cost).
      if (clearBeforeReplay) {
        await session.writeReplayDataAsync('\x1b[2J\x1b[3J\x1b[H')
        if (!isCurrentPayload()) {
          continue
        }
      }
      // Why before the frame: the payload's wraps and cursor moves are relative
      // to the grid the host serialized it at. Parsing it at the pane's own grid
      // clips or re-wraps the image, and an idle TUI never repaints to correct
      // it — the pane stays blank until the next byte arrives.
      const sourceGrid = resolvePositiveTerminalDimensions(snapshotCols, snapshotRows)
      if (
        sourceGrid &&
        (session.pane.terminal.cols !== sourceGrid.cols ||
          session.pane.terminal.rows !== sourceGrid.rows)
      ) {
        // Why suppressed: this resize is a layout step for parsing, not the
        // pane's real geometry — the destination fit below owns the PTY grid.
        session.suppressStructuralReplayPtyResize = true
        try {
          session.pane.terminal.resize(sourceGrid.cols, sourceGrid.rows)
        } finally {
          session.suppressStructuralReplayPtyResize = false
        }
        replayedAtSourceGrid = true
      }
      if (clearBeforeReplay || data.length > 0) {
        // Why: an empty clearing frame is still an authoritative repaint and
        // must clear a stale agent signal from an earlier payload.
        session.rememberReattachPayloadAgentSignal(data, { fullScreenReplay: clearBeforeReplay })
      }
      // Why: replayed application bytes carry the live TUI's kitty keyboard
      // negotiation; the mirror must re-arm from them after a reload. Replay
      // semantics: relay reconnects redeliver the same window, so pushes
      // apply as sets to keep the mirrored stack from accumulating frames.
      session.applySnapshotKittyKeyboardModes(data, payload)
      await session.writeReplayDataAsync(data)
      if (!isCurrentPayload()) {
        continue
      }
      if (clearBeforeReplay || data.length > 0) {
        await session.writeReplayDataAsync(
          session.reattachReplayResetSequence(data, false, alternateScreen, terminalOwner)
        )
        if (!isCurrentPayload()) {
          continue
        }
        session.sendFocusedReattachFocusInAfterReplay(payload.ptyId, payload.streamGeneration)
      }
      // Why: the daemon could not serialize a PTY read that ended mid-escape,
      // so the emulator shipped the dangling partial separately. Write it LAST
      // — after the reset, whose ESC would otherwise abort it — so the next
      // live chunk completes the sequence instead of rendering literally
      // (#7329). Guarded so a later ESC cannot leave the parser wedged.
      if (pendingEscapeTailAnsi) {
        await session.writeReplayDataAsync(pendingEscapeTailAnsi)
      }
      if (!isCurrentPayload()) {
        continue
      }
      // Why: remote-runtime snapshots can arrive after WebGL attached to an
      // empty buffer; rebuilding after replay parses seeds the glyph atlas
      // from the now-populated xterm state.
      session.manager.rebuildPaneWebgl(session.pane.id)
      appliedCurrentPayload = true
    }
    return appliedCurrentPayload
  }
  // Why the same helper the reattach payload uses: a source-grid replay leaves
  // xterm at the host's geometry, so the pane must fit back and push the
  // resulting grid to the PTY before live bytes resume.
  const fitAfterSourceGridReplay = async (
    scheduledPtyId: string | null,
    scheduledStreamGeneration: number
  ): Promise<void> => {
    if (!replayedAtSourceGrid) {
      return
    }
    replayedAtSourceGrid = false
    if (
      session.disposed ||
      !scheduledPtyId ||
      session.transport.getPtyId() !== scheduledPtyId ||
      session.transportStreamGeneration !== scheduledStreamGeneration
    ) {
      return
    }
    if (getFitOverrideForPty(scheduledPtyId)) {
      // Why fit without the grid push: a mobile driver owns the PTY geometry,
      // but the pane must still leave the host's replay grid.
      safeFit(session.pane)
      return
    }
    const gridPush = session.createReattachGridPush(scheduledStreamGeneration, scheduledPtyId)
    const fit = safeFitAndThen(session.pane, 'replay-source-grid-fit', gridPush.continuation, {
      shouldContinue: gridPush.shouldContinue,
      retryIfUnmeasurable: true,
      // Why: a hidden or parked pane must still leave the source grid once it
      // is revealed, or the PTY stays pinned to the host's replay geometry.
      deferIfHidden: true
    })
    session.pendingReattachFit = fit
    try {
      await fit.completion
    } finally {
      if (session.pendingReattachFit === fit) {
        session.pendingReattachFit = null
      }
    }
  }

  session.scheduleReplayDataDrain = (): void => {
    if (replayDrainQueued) {
      return
    }
    const scheduledPtyId = session.pendingReplayData?.ptyId ?? null
    replayDrainQueued = true
    // Why reset here: a transaction whose restore was skipped never ran its
    // afterRestore, and a stale flag would fit a later drain that never left
    // the pane's own grid.
    replayedAtSourceGrid = false
    // Why: live bytes are newer than the authoritative replay frame. Hold
    // them until clear + replay + reset have all parsed, or replay can erase them.
    const scheduledStreamGeneration =
      session.pendingReplayData?.streamGeneration ?? session.transportStreamGeneration
    session.beginReattachLiveDataDeferral(scheduledStreamGeneration)
    let replayCompleted = false
    session.replayWriteQueue = session.replayWriteQueue
      .catch(() => undefined)
      .then(() =>
        session.structuralReplayCoordinator.run(
          async () => {
            replayCompleted = await drainReplayDataQueue(scheduledPtyId, scheduledStreamGeneration)
          },
          {
            shouldRestore: () =>
              !session.disposed &&
              session.transport.getPtyId() === scheduledPtyId &&
              session.transportStreamGeneration === scheduledStreamGeneration,
            afterRestore: () => fitAfterSourceGridReplay(scheduledPtyId, scheduledStreamGeneration)
          }
        )
      )
      .then(() => {
        replayCompleted &&= !session.disposed && session.transport.getPtyId() === scheduledPtyId
      })
      .finally(() => {
        replayDrainQueued = false
        if (session.pendingReplayData !== null) {
          // Why: preserve the PTY identity captured when the callback fired;
          // re-reading it here could retag stale bytes for a replacement PTY.
          session.scheduleReplayDataDrain()
        }
        session.finishReattachLiveDataDeferral(replayCompleted, scheduledStreamGeneration)
      })
  }
}

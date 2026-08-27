import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'

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
      const { data, clearBeforeReplay, pendingEscapeTailAnsi, alternateScreen, terminalOwner } =
        payload
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
      if (clearBeforeReplay) {
        await session.writeReplayDataAsync('\x1b[2J\x1b[3J\x1b[H')
        if (!isCurrentPayload()) {
          continue
        }
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
  session.scheduleReplayDataDrain = (): void => {
    if (replayDrainQueued) {
      return
    }
    const scheduledPtyId = session.pendingReplayData?.ptyId ?? null
    replayDrainQueued = true
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
              session.transportStreamGeneration === scheduledStreamGeneration
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

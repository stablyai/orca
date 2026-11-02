import { RELEASE_SYNCHRONIZED_OUTPUT } from '../../../../../shared/terminal-mode-reset-profiles'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { safeFit, safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'

import {
  buildFoldedImageReplayWrites,
  resolvePositiveTerminalDimensions
} from '../terminal-snapshot-replay-paint'

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
    const imageTitle: string | undefined = session.reattachReplayImageTitle
    void waitForTerminalOutputParsed(session.pane.terminal).then(() => {
      const currentPtyId = session.transport.getPtyId()
      if (
        session.disposed ||
        expectedStreamGeneration !== session.transportStreamGeneration ||
        currentPtyId !== expectedPtyId
      ) {
        return
      }
      // Only the newest replay’s post-parse callback may judge its viewport.
      if (scheduledGeneration !== session.reattachReplayPayloadSignalGeneration) {
        return
      }
      // Dead replay screens can remain above shell prompts; require parsed parked-cursor screen or corroborating status/title before retaining agent focus behavior.
      if (
        !session.hasLiveAgentReattachStatusOrTitleSignal(imageTitle) &&
        session.reattachReplayPayloadHasCursorAgentSignal
      ) {
        if (parsedViewportShowsParkedCursorAgentScreen(session.pane.terminal) === false) {
          session.reattachReplayPayloadHasCursorAgentSignal = false
          // Plain shells never restore cursors hidden by a dead agent’s replay.
          session.writeReplayData(`${CURSOR_SHOW_SEQUENCE}${FOCUS_REPORTING_DISABLE_SEQUENCE}`)
          return
        }
      }
      // Reattach preserves DOM focus, so live TUIs may miss focus-in needed to unpark their cursor; inject only with ?1004h to spare bare shells.
      const sendFocusMode = terminalHasFocusReportingEnabled(session.pane.terminal)
      if (!session.shouldSendFocusedAgentReattachFocusIn(imageTitle) || !sendFocusMode) {
        return
      }
      session.transport.sendInput(TERMINAL_FOCUS_IN_SEQUENCE, 'query-reply')
    })
  }

  session.pendingReplayData = null
  session.replayPayloadGeneration = 0
  let replayDrainQueued = false
  // Fit destination geometry after the whole source-grid replay transaction parses.
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
        lastTitle,
        snapshotCols,
        snapshotRows,
        carriesNormalBuffer,
        carriesHistory
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
      // Relay replay may overlap painted output; eager replay decides earlier so metadata-only frames preserve saved scrollback.
      // Clear before source-grid resize to avoid reflowing history that replay immediately discards.
      let replayPayload = data
      if (clearBeforeReplay) {
        if (carriesNormalBuffer) {
          // Wait for queued alt-screen transitions before choosing replay’s target buffer.
          await waitForTerminalOutputParsed(session.pane.terminal)
          if (!isCurrentPayload()) {
            continue
          }
          const image = buildFoldedImageReplayWrites(
            data,
            session.isPaneOnAlternateScreen(),
            carriesHistory === true
          )
          replayPayload = image.payload
          await session.writeReplayDataAsync(image.preamble)
        } else {
          // Reconnect can sever DEC 2026 mid-frame; clear-screen does not release its latch, leaving replay invisible until timeout.
          await session.writeReplayDataAsync(`${RELEASE_SYNCHRONIZED_OUTPUT}\x1b[2J\x1b[3J\x1b[H`)
        }
        if (!isCurrentPayload()) {
          continue
        }
      }
      // Replay wraps/cursor moves require host geometry; wrong-grid clipping can persist forever on idle TUIs.
      const sourceGrid = resolvePositiveTerminalDimensions(snapshotCols, snapshotRows)
      if (
        sourceGrid &&
        (session.pane.terminal.cols !== sourceGrid.cols ||
          session.pane.terminal.rows !== sourceGrid.rows)
      ) {
        // Do not forward parsing-only resize; destination fit owns the host’s real grid.
        session.suppressStructuralReplayPtyResize = true
        try {
          session.pane.terminal.resize(sourceGrid.cols, sourceGrid.rows)
        } finally {
          session.suppressStructuralReplayPtyResize = false
        }
        replayedAtSourceGrid = true
      }
      if (clearBeforeReplay || data.length > 0) {
        // Authoritative empty clearing frames must also retire prior agent-screen evidence.
        session.rememberReattachPayloadAgentSignal(data, {
          fullScreenReplay: clearBeforeReplay,
          imageTitle: lastTitle
        })
      }
      // Re-arm Kitty from application replay using set semantics so repeated windows cannot grow its stack.
      session.applySnapshotKittyKeyboardModes(data, payload)
      await session.writeReplayDataAsync(replayPayload)
      if (!isCurrentPayload()) {
        continue
      }
      if (clearBeforeReplay || data.length > 0) {
        await session.writeReplayEpilogue(
          session.chooseReattachReplayReset(data, false, alternateScreen, terminalOwner, lastTitle),
          session.writeReplayDataAsync
        )
        if (!isCurrentPayload()) {
          continue
        }
        session.sendFocusedReattachFocusInAfterReplay(payload.ptyId, payload.streamGeneration)
      }
      // Write dangling escapes last, after reset ESCs, so live tails complete them instead of printing literally; guard cancellation (#7329).
      if (pendingEscapeTailAnsi) {
        await session.writeReplayDataAsync(pendingEscapeTailAnsi)
      }
      if (!isCurrentPayload()) {
        continue
      }
      // Rebuild WebGL after replay parses so an atlas attached to an empty buffer gains current glyphs.
      session.manager.rebuildPaneWebgl(session.pane.id)
      appliedCurrentPayload = true
    }
    return appliedCurrentPayload
  }
  // Share reattach fitting so source-grid replay restores and pushes destination geometry before live output.
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
      // Leave source replay geometry locally without changing the mobile-owned PTY grid.
      safeFit(session.pane)
      return
    }
    const gridPush = session.createReattachGridPush(scheduledStreamGeneration, scheduledPtyId)
    const fit = safeFitAndThen(session.pane, 'replay-source-grid-fit', gridPush.continuation, {
      shouldContinue: gridPush.shouldContinue,
      retryIfUnmeasurable: true,
      // Preserve deferred destination fitting through reveal so hidden panes cannot strand host replay geometry.
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
    // Skipped transactions never run afterRestore; clear their pending fit flag before a later unrelated drain.
    replayedAtSourceGrid = false
    // Hold newer live bytes until clear/replay/reset parse so replay cannot erase them.
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
          // Retain callback-time PTY identity so later rebind cannot retag stale bytes.
          session.scheduleReplayDataDrain()
        }
        session.finishReattachLiveDataDeferral(replayCompleted, scheduledStreamGeneration)
      })
  }
}

import { useAppStore } from '@/store'
import { containsStatefulRendererQuery } from '../../../../../shared/terminal-reply-query-extraction'
import { takeCurrentTerminalDeliveryCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import { recordAgentHibernationPaneOutput } from '@/lib/agent-hibernation-output-activity'
import { observeTerminalBracketedPasteModeOutput } from '../terminal-bracketed-paste'
import type { PtyDataMeta } from '../pty-dispatcher'
import { sendTerminalOscColorQueryReplies } from '../terminal-capability-replies'

import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { registerE2eTerminalPtyDataInjection } from './e2e-terminal-pty-harness'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindLiveDataCallback(session: ConnectPanePtySession): void {
  session.dataCallback = (
    data: string,
    meta?: PtyDataMeta,
    streamGeneration = session.transportStreamGeneration
  ): void => {
    if (streamGeneration !== session.transportStreamGeneration) {
      return
    }
    if (session.deferredReattachLiveData !== null) {
      const ackCredit = takeCurrentTerminalDeliveryCredit()
      session.deferredReattachLiveData.enqueue({
        data,
        ptyId: session.transport.getPtyId(),
        streamGeneration,
        ...(meta ? { meta } : {}),
        ...(ackCredit ? { ackCredit } : {})
      })
      return
    }
    if (data.length > 0) {
      session.hasReceivedPtyOutput = true
      recordAgentHibernationPaneOutput(session.cacheKey)
      // Why: output is the agent-start signal that ends the relaxed no-evidence process-scan cadence (a starting agent always prints).
      session.agentCompletionCoordinator.observeOutputActivity()
    }
    session.observeStartupDraftPasteReadiness(data)
    session.resetHiddenOutputRestoreIfPtyChanged()
    session.observeLiveMode2031Chunk(data)
    if (meta?.droppedOutput === true) {
      // Why gated (rc.7.perf loop): a visible pane's cap-drop during its own restore is self-caused backpressure; defer to one post-flood repaint instead of re-arming per sentinel.
      if (meta?.background !== true && session.isForegroundRestoreBackpressureContext()) {
        session.noteHiddenOutputRestoreFloodBackpressure()
      } else {
        // Why: main dropped buffered output at the pending cap, so the stream has a gap; repaint from the main-owned snapshot instead of writing on.
        session.markHiddenOutputRestoreNeeded()
        if (data) {
          // The sentinel can carry query bytes carved from the bulk drop (extractDroppedPtyQueryBytes in main); replies must still flow.
          session.salvageRendererQueriesFromDiscardedRestoreData(data)
        }
        return
      }
    }
    session.respondToTerminalPixelSizeQueries(data)
    observeTerminalBracketedPasteModeOutput(session.pane.terminal, data)
    // Why: under main side-effect authority these facts arrive via pty:sideEffect; byte-scanning here would double-fire. Remote PTYs / kill-switch-off keep this path.
    if (!session.mainSideEffectAuthority) {
      for (const link of session.observeTerminalGitHubPRLink(data)) {
        useAppStore.getState().observeTerminalGitHubPullRequestLink(session.deps.worktreeId, link)
      }
      session.commandLifecycle.handlePtyData(data)
    }
    session.commandCodeOutputStatusDetector?.observe(data)
    const codexBackfillNotice = session.codexBackfillErrorDetector?.observe(data)
    if (codexBackfillNotice) {
      session.reportError(codexBackfillNotice)
    }
    const agentStall = session.agentStallDetector?.observe(data)
    if (agentStall) {
      useAppStore.getState().observeAgentStall({
        paneKey: session.cacheKey,
        cause: agentStall.cause,
        signature: agentStall.signature,
        observedAt: agentStall.at
      })
    }
    // Why: split panes have visible-but-inactive panes the user watches; throttle only when the pane or whole document is hidden.
    const foreground =
      shouldWritePtyOutputForeground(session.deps.isVisibleRef.current) && meta?.background !== true
    // Why: latch the hidden-delivery gate from the byte path too, covering a PTY id that arrives after the initial sync (no-op when current).
    if (!foreground) {
      session.syncHiddenRendererPtyDelivery()
    }
    // Post-restore reconciliation: drop chunks the snapshot covers, force a fresh restore for unmappable seq gaps; runs after byte observers, before any xterm write.
    const reconciliation = session.reconcileChunkAgainstRestoredSnapshot(data, meta)
    if (reconciliation.action === 'drop-duplicate') {
      return
    }
    if (reconciliation.action === 'force-fresh-restore') {
      // Why gated (rc.7.perf loop): foreground-flood seq gaps are our own backpressure drops; snapshot-per-gap IS the loop, so retire the baseline and heal post-flood.
      if (foreground && session.isForegroundRestoreBackpressureContext()) {
        session.noteHiddenOutputRestoreFloodBackpressure()
        session.clearRestoredSnapshotBaseline()
        // fall through with the ORIGINAL data/meta — post-gap bytes are new
      } else {
        // Why: capture in-flight BEFORE the mark — on a visible pane the mark starts the restore synchronously and must not flag itself.
        const restoreWasInFlight = session.hiddenOutputRestoreInFlight !== null
        session.markHiddenOutputRestoreNeeded()
        if (restoreWasInFlight) {
          session.hiddenOutputRestoreFreshSnapshotNeeded = true
        }
        return
      }
    } else {
      data = reconciliation.data
      meta = reconciliation.meta
    }
    // Why: a hidden Codex query can split just before visibility flips; hand xterm the completed query while other bytes still follow restore.
    const pendingForegroundQuery = foreground
      ? session.takeHiddenStartupRendererQueryPendingForForeground(data)
      : null
    const rendererData = pendingForegroundQuery?.remainingData ?? data
    const rendererMeta = session.metaAfterConsumingCurrentChars(
      meta,
      pendingForegroundQuery?.consumedCurrentChars ?? 0
    )
    session.observeRendererOrderedSeqRegression(meta)
    const orderedRendererData = foreground
      ? rendererData
      : session.getHiddenRendererDataAfterOrderedSeq(rendererData, rendererMeta)
    if (orderedRendererData === null) {
      // Why: renderer filtering can't map cleaned text back to raw seq offsets; rebuild from main instead of risking stale bytes.
      session.markHiddenOutputRestoreNeeded()
      session.schedulePendingStartupCommandDelivery()
      return
    }
    if (!foreground && orderedRendererData.length === 0) {
      session.recordRendererOrderedSeq(rendererMeta)
      session.schedulePendingStartupCommandDelivery()
      return
    }
    if (pendingForegroundQuery?.statelessQueryData) {
      session.writePtyOutputToXterm(pendingForegroundQuery.statelessQueryData, true, {
        hiddenStartupRendererQuery: true
      })
    }
    if (pendingForegroundQuery?.oscColorQueryData) {
      sendTerminalOscColorQueryReplies(
        pendingForegroundQuery.oscColorQueryData,
        session.pane.terminal,
        // Why: OSC color reply sent immediately so the remote debounce can't delay it past the program's read window (#7329).
        session.sendDesktopQueryReplyImmediate
      )
    }
    const restoreAppliesToCurrentPty =
      session.hiddenOutputRestorePtyId !== null &&
      session.transport.getPtyId() === session.hiddenOutputRestorePtyId
    const skipBackgroundAlternateScreenFrame =
      meta?.background === true &&
      shouldWritePtyOutputForeground(session.deps.isVisibleRef.current) &&
      session.pane.terminal.buffer.active.type === 'alternate' &&
      !containsStatefulRendererQuery(orderedRendererData)
    if (skipBackgroundAlternateScreenFrame) {
      session.skipBackgroundAlternateScreenOutput(orderedRendererData)
    } else if (session.shouldSkipHiddenRendererOutput(foreground, orderedRendererData)) {
      session.skipHiddenRendererOutput(orderedRendererData)
    } else if (
      (session.hiddenOutputRestoreNeeded || session.hiddenOutputRestoreInFlight) &&
      restoreAppliesToCurrentPty
    ) {
      if (foreground) {
        if (pendingForegroundQuery?.statefulQueryData) {
          session.queueLiveChunkDuringRestore(pendingForegroundQuery.statefulQueryData)
        }
        session.queueLiveChunkDuringRestore(orderedRendererData, rendererMeta)
        session.requestHiddenOutputRestoreIfNeeded()
      } else if (session.hiddenOutputRestoreInFlight) {
        session.hiddenOutputRestoreNeeded = true
        session.hiddenOutputRestoreFreshSnapshotNeeded = true
      }
      // Why: hidden chunks with a restore already latched are dropped; the reveal snapshot covers their bytes.
    } else {
      // Why: hidden panes normally get no bytes (main drops post-ingestion); stragglers ride the bounded background queue, overflow latches restore.
      if (pendingForegroundQuery?.statefulQueryData) {
        session.writePtyOutputToXterm(pendingForegroundQuery.statefulQueryData, true, {
          hiddenStartupRendererQuery: true
        })
      }
      session.writePtyOutputToXterm(orderedRendererData, foreground)
      if (foreground) {
        session.recordRendererOrderedSeq(rendererMeta)
      }
    }

    session.schedulePendingStartupCommandDelivery()
  }
  session.unregisterE2ePtyDataInjection = registerE2eTerminalPtyDataInjection(
    session.cacheKey,
    (data, meta) => {
      if (!session.disposed) {
        session.dataCallback(data, meta)
      }
    }
  )
}

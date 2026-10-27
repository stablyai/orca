import {
  applyTerminalLaunchResult,
  captureTerminalLaunchContext,
  type TerminalLaunchContext
} from './terminal-launch-result-policy'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import type { PtyBufferSnapshot, PtyConnectResult } from '../pty-transport-types'
import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
// Inspect stale-account state only after a concrete PTY attaches.
import { notifyCodexPaneBoundForStaleSweep } from '@/lib/codex-stale-pane-sweep'
import { useAppStore } from '@/store'
import { resolveHiddenRestoreScrollbackRows } from '../terminal-hidden-restore-scrollback'
import { shouldIgnoreStalePanePtyLayoutBinding } from './pane-pty-layout-binding'

import { hasEmptyReattachRetireEvidence } from './empty-reattach-retire-evidence'
import { mainStartsPane } from './main-starts-pane'
import { showMainPaneResumeOutcome } from './main-pane-resume-banner'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import type { ReattachPayloadContext } from './reattach-payload-context'
import { createReattachPayloadHandlers } from './apply-reattach-payload'
import type { ReattachPayloadSession } from './reattach-payload-session'
import {
  classifyHiddenOutputSnapshotReject,
  type HiddenOutputSnapshotResult
} from './hidden-output-snapshot-serialize'
import {
  classifyParkRevealSnapshot,
  type ParkRevealNoHostImageReason,
  type ParkRevealRetryLedger
} from './park-reveal-snapshot-verdict'

type ReattachResultSession = ReattachPayloadSession &
  Pick<
    ConnectPanePtySession,
    | 'agentCompletionCoordinator'
    | 'buildColdRestoreAgentResumeStartup'
    | 'discardAgentPreReadyDraft'
    | 'mainStartAttach'
    | 'runtimeEnvironmentId'
    | 'activePanePtyBinding'
    | 'activePanePtyBindingBoundAt'
    | 'authoritativeReattachGeneration'
    | 'cacheKey'
    | 'deps'
    | 'disposed'
    | 'handleReattachResult'
    | 'mountFollowsTerminalPark'
    | 'registerEffectiveLaunchConfig'
    | 'cancelSavedResumeStartup'
    | 'registerPaneSerializerFor'
    | 'registerSideEffectFactConsumerForPty'
    | 'reportPanePtyVisibility'
    | 'retryUnverifiableParkRevealSnapshot'
    | 'sampleVisiblePaneForegroundAgent'
    | 'warnParkRevealNoHostImage'
    | 'scheduleReattachIdleAgentCursorReset'
    | 'serializeHiddenOutputSnapshot'
    | 'settlePaneAttachAttempt'
    | 'setPanePtyFitBinding'
    | 'startFreshColdRestoreAgentResume'
    | 'structuralReplayCoordinator'
    | 'syncPanePtyLayoutBinding'
    | 'clearExitedPanePtyLayoutBinding'
    | 'syncHiddenRendererPtyDelivery'
    | 'transportStreamGeneration'
  > & { remotePtyIncarnationId?: string | null }

export function bindHandleReattachResult(sessionBag: ConnectPanePtySession): void {
  const session = sessionBag as unknown as ReattachResultSession
  session.handleReattachResult = async (
    result: PtyConnectResult | string | void,
    staleSessionId?: string | null,
    coldRestoreStartup?: ColdRestoreAgentResumeStartup | null,
    attemptGeneration = session.transportStreamGeneration,
    launchContext: TerminalLaunchContext = captureTerminalLaunchContext(
      sessionBag,
      coldRestoreStartup ?? sessionBag.paneStartup
    )
  ): Promise<boolean> => {
    if (session.disposed) {
      return false
    }
    if (attemptGeneration !== session.transportStreamGeneration) {
      return false
    }
    const isCurrentReattachTransport = (): boolean =>
      !session.disposed &&
      // Require current transport ownership before old async results can mutate or retire a successor.
      session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
      attemptGeneration === session.transportStreamGeneration
    if (!isCurrentReattachTransport()) {
      return false
    }
    // Bump generation only after ownership admission so superseded results cannot cancel current snapshot prepaint.
    session.authoritativeReattachGeneration += 1
    const connectResult =
      result && typeof result === 'object' && 'id' in result ? (result as PtyConnectResult) : null
    if (connectResult?.incarnationId) {
      session.remotePtyIncarnationId = connectResult.incarnationId
    } else if (connectResult?.isReattach || typeof result === 'string') {
      // Missing legacy incarnation remains client-only unverifiable evidence until a stamped attach.
      session.remotePtyIncarnationId = null
    }

    if (connectResult) {
      applyTerminalLaunchResult(sessionBag, connectResult, launchContext, 'creator')
    }
    if (connectResult?.exitedBeforeAttach) {
      // Why: the transport already delivered the dead session's final frame + exit; treat as terminal state, not a failed reattach.
      return true
    }

    // Why: main started a plain shell instead, so nothing of the plan may be registered over it.
    const startup =
      connectResult?.agentResumeRefused ||
      connectResult?.agentResumeUnavailable ||
      connectResult?.isReattach
        ? null
        : coldRestoreStartup
    const ptyId =
      connectResult?.id ?? (typeof result === 'string' ? result : session.transport.getPtyId())
    const hasExplicitPtyId = Boolean(connectResult?.id || typeof result === 'string')
    if (!ptyId) {
      warnTerminalLifecycleAnomaly('restored PTY reattach returned no PTY id', {
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        leafId: session.deps.restoredLeafId ?? session.pane.leafId,
        paneId: session.pane.id,
        ptyId: staleSessionId ?? null
      })
      // Why: a stale restored session can fail reattach after mount; don't leave xterm alive without a backing PTY.
      if (staleSessionId) {
        session.clearExitedPanePtyLayoutBinding(staleSessionId)
      } else {
        session.syncPanePtyLayoutBinding(null)
      }
      if (staleSessionId) {
        session.deps.clearTabPtyId(session.deps.tabId, staleSessionId)
      }
      session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
        forceBlankRestoredViewport: true
      })
      return false
    }
    if (connectResult?.sessionExpired) {
      if (staleSessionId) {
        session.clearExitedPanePtyLayoutBinding(staleSessionId)
      } else {
        session.syncPanePtyLayoutBinding(null)
      }
      if (staleSessionId) {
        session.deps.clearTabPtyId(session.deps.tabId, staleSessionId)
      }
      // Why: a host can invalidate the PTY while the tab stays mounted; replace it in place, not with a stale overlay.
      session.startFreshColdRestoreAgentResume(startup, {
        forceBlankRestoredViewport: true
      })
      return false
    }
    const isCurrentReattachPayload = (): boolean => {
      const currentPtyId = session.transport.getPtyId()
      // Explicit attach results outrank transient getPtyId nulls before the async bind callback.
      return isCurrentReattachTransport() && (currentPtyId === ptyId || hasExplicitPtyId)
    }
    if (!isCurrentReattachPayload()) {
      return false
    }
    // Settle recovery success only after PTY/expiry validation; fallback failures stay pending for bounded ledger expiration.
    session.settlePaneAttachAttempt?.('success')
    // Strict precedence snapshot > replay > coldRestore: paint exactly one, else overlapping tails duplicate TUI output on worktree switch.
    const hasStructuralReplay = Boolean(
      connectResult?.snapshot || connectResult?.replay || connectResult?.coldRestore
    )
    // Why: reattach drops startup commands; only real hibernation is authority to retire an empty adopted shell and resume its provider session.
    const mainStarts = mainStartsPane(session)
    if (
      !hasStructuralReplay &&
      connectResult?.isReattach &&
      // Why: main already judged this terminal after its start; asking again would loop.
      !(mainStarts && session.mainStartAttach) &&
      hasEmptyReattachRetireEvidence(
        ptyId,
        connectResult.agentResumeRefused
          ? null
          : mainStarts
            ? session.buildColdRestoreAgentResumeStartup()
            : coldRestoreStartup
      )
    ) {
      session.transport.disconnect()
      if (mainStarts) {
        // Main retires the empty shell and resumes the agent in its place (startPane).
        session.startFreshColdRestoreAgentResume(null)
        return false
      }
      if (staleSessionId) {
        session.clearExitedPanePtyLayoutBinding(staleSessionId)
        session.deps.clearTabPtyId(session.deps.tabId, staleSessionId)
      } else {
        session.syncPanePtyLayoutBinding(null)
      }
      session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
        forceBlankRestoredViewport: true
      })
      return false
    }
    session.setPanePtyFitBinding(ptyId)
    // Commit session identity before replay can admit queued spawn callbacks.
    session.activePanePtyBinding = ptyId
    session.activePanePtyBindingBoundAt = performance.now()
    // Why discard: a cold restore can reach a bare shell that `--resume` is typed into next.
    session.discardAgentPreReadyDraft?.()
    session.reportPanePtyVisibility(ptyId, session.deps.isVisibleRef.current)
    session.registerSideEffectFactConsumerForPty(ptyId)
    session.syncHiddenRendererPtyDelivery()
    const currentTabPtyId = Object.values(useAppStore.getState().tabsByWorktree)
      .flat()
      .find((tab) => tab.id === session.deps.tabId)?.ptyId
    const existingLeafPtyId =
      useAppStore.getState().terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[
        session.pane.leafId
      ]
    // Only replace tab-level PTY identity when it belongs to this leaf; split spawn cannot rewrite its unrelated source sibling.
    const inferredReplacementPtyId =
      currentTabPtyId &&
      shouldIgnoreStalePanePtyLayoutBinding({
        existingPtyId: existingLeafPtyId,
        nextPtyId: ptyId,
        tabPtyId: currentTabPtyId
      })
        ? existingLeafPtyId
        : undefined
    const replacementPtyId =
      staleSessionId && staleSessionId !== ptyId ? staleSessionId : inferredReplacementPtyId
    if (replacementPtyId) {
      session.deps.updateTabPtyId(session.deps.tabId, ptyId, replacementPtyId)
    } else {
      session.deps.updateTabPtyId(session.deps.tabId, ptyId)
    }
    // Keep layout sync after the identity commit; replacement paths are atomic.
    session.syncPanePtyLayoutBinding(ptyId)
    useAppStore.getState().restoreAgentPaneAuthority?.(session.cacheKey)
    notifyCodexPaneBoundForStaleSweep(ptyId)
    session.agentCompletionCoordinator.startProcessTracking()
    session.sampleVisiblePaneForegroundAgent()

    // Why: mobile streaming needs xterm's exact screen state; install the serializer + lastTitle source for main-process hydration parity.
    session.registerPaneSerializerFor(ptyId)

    // Spend the park-reveal probe once; later in-place reconnects must not pay another timeout before replay.
    const revealFollowsTerminalPark =
      session.mountFollowsTerminalPark &&
      (connectResult?.isReattach === true || isRemoteRuntimePtyId(ptyId))
    session.mountFollowsTerminalPark = false
    // Parking destroys xterm; restore the host image before live bytes, preserving subscribe paint if no image was proven.
    let prefetchedParkModelSnapshot: PtyBufferSnapshot | null = null
    // Null means no proven paint, never empty; unverifiable probes need a bounded retry after payload settlement.
    let unverifiableParkRevealLedger: ParkRevealRetryLedger | undefined
    let noHostImageReason: ParkRevealNoHostImageReason | undefined
    if (revealFollowsTerminalPark && (!hasStructuralReplay || isRemoteRuntimePtyId(ptyId))) {
      let result: HiddenOutputSnapshotResult
      try {
        result = await session.serializeHiddenOutputSnapshot(ptyId, {
          scrollbackRows: resolveHiddenRestoreScrollbackRows(
            session.pane.terminal.options.scrollback
          )
        })
      } catch {
        result = classifyHiddenOutputSnapshotReject(sessionBag, ptyId)
      }
      const verdict = classifyParkRevealSnapshot(result, ptyId)
      if (verdict.kind === 'host-snapshot') {
        prefetchedParkModelSnapshot = verdict.snapshot
      } else if (verdict.kind === 'unverifiable') {
        unverifiableParkRevealLedger = verdict.ledger
      } else {
        noHostImageReason = verdict.reason
      }
      if (!isCurrentReattachPayload()) {
        return false
      }
    }
    // Keep the model paint in the structural transaction so live output cannot overtake the snapshot.
    const shouldApplyStructuralPayload = hasStructuralReplay || prefetchedParkModelSnapshot !== null
    const reattachPayload: ReattachPayloadContext = {
      isCurrentReattachPayload,
      connectResult,
      ptyId,
      attemptGeneration,
      prefetchedParkModelSnapshot,
      revealFollowsTerminalPark,
      shouldApplyStructuralPayload,
      coldRestoreStartup: startup,
      reattachPayloadApplied: !shouldApplyStructuralPayload,
      skippedAltFrameCaptureCols: null
    }
    const { applyReattachPayload, fitAfterReattachRestore } = createReattachPayloadHandlers(
      session,
      reattachPayload
    )
    if (shouldApplyStructuralPayload) {
      await session.structuralReplayCoordinator.run(applyReattachPayload, {
        shouldRestore: isCurrentReattachPayload,
        afterRestore: fitAfterReattachRestore
      })
    } else {
      await applyReattachPayload()
      await fitAfterReattachRestore()
    }
    if (!isCurrentReattachPayload() || !reattachPayload.reattachPayloadApplied) {
      return false
    }
    if (unverifiableParkRevealLedger !== undefined) {
      // After the payload, so the retry's own structural repaint queues behind this attempt instead of nesting in it.
      session.retryUnverifiableParkRevealSnapshot(ptyId, unverifiableParkRevealLedger)
    } else if (noHostImageReason !== undefined) {
      session.warnParkRevealNoHostImage(ptyId, noHostImageReason)
    }
    session.scheduleReattachIdleAgentCursorReset()
    showMainPaneResumeOutcome(sessionBag, ptyId)

    scheduleRuntimeGraphSync()
    return true
  }
}

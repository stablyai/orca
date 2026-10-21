import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import type { PtyBufferSnapshot, PtyConnectResult } from '../pty-transport-types'
import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
// Why: a restored pane's stale-account prompt can only be raised once a PTY is
// actually attached — nothing is inspectable while the session hydrates.
import { notifyCodexPaneBoundForStaleSweep } from '@/lib/codex-stale-pane-sweep'
import { useAppStore } from '@/store'
import { resolveHiddenRestoreScrollbackRows } from '../terminal-hidden-restore-scrollback'
import { shouldIgnoreStalePanePtyLayoutBinding } from './pane-pty-layout-binding'

import { hasEmptyReattachRetireEvidence } from './empty-reattach-retire-evidence'
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
    | 'activePanePtyBinding'
    | 'activePanePtyBindingBoundAt'
    | 'authoritativeReattachGeneration'
    | 'cacheKey'
    | 'deps'
    | 'disposed'
    | 'handleReattachResult'
    | 'mountFollowsTerminalPark'
    | 'registerEffectiveLaunchConfig'
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
    attemptGeneration = session.transportStreamGeneration
  ): Promise<boolean> => {
    if (session.disposed) {
      return false
    }
    if (attemptGeneration !== session.transportStreamGeneration) {
      return false
    }
    const isCurrentReattachTransport = (): boolean =>
      !session.disposed &&
      // A remount can register its successor before the old async result settles.
      // Do not let the stale session mutate or retire the successor's ownership.
      session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
      attemptGeneration === session.transportStreamGeneration
    if (!isCurrentReattachTransport()) {
      return false
    }
    // Why: bump only once this attempt owns the stream, or a superseded result
    // would cancel the current attempt's in-flight snapshot prepaint.
    session.authoritativeReattachGeneration += 1
    const connectResult =
      result && typeof result === 'object' && 'id' in result ? (result as PtyConnectResult) : null
    if (connectResult?.incarnationId) {
      session.remotePtyIncarnationId = connectResult.incarnationId
    } else if (connectResult?.isReattach || typeof result === 'string') {
      // Legacy hosts do not publish an incarnation; force client-only
      // unverifiable evidence until a fresh attach returns one.
      session.remotePtyIncarnationId = null
    }

    if (connectResult?.exitedBeforeAttach) {
      // Why: the transport already delivered the dead session's final frame + exit; treat as terminal state, not a failed reattach.
      return true
    }

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
    session.registerEffectiveLaunchConfig(connectResult?.launchConfig, {
      ...(coldRestoreStartup ? { launchToken: coldRestoreStartup.launchToken } : {}),
      ...(connectResult?.launchAgent
        ? { launchAgent: connectResult.launchAgent }
        : coldRestoreStartup
          ? { launchAgent: coldRestoreStartup.agent }
          : {})
    })
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
      session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
        forceBlankRestoredViewport: true
      })
      return false
    }
    const isCurrentReattachPayload = (): boolean => {
      const currentPtyId = session.transport.getPtyId()
      // Remote transports may publish the result object before their async
      // bind callback updates getPtyId(); the explicit result is authoritative.
      return isCurrentReattachTransport() && (currentPtyId === ptyId || hasExplicitPtyId)
    }
    if (!isCurrentReattachPayload()) {
      return false
    }
    // The first authoritative attach of the pane a recovery remount produced:
    // the observation the ledger was waiting for. Placed past the no-PTY-id and
    // session-expired branches so a failure can never be reported as a success.
    // Those branches fall through to startFreshColdRestoreAgentResume and leave
    // the attempt pending, which the ledger's bound then ages out.
    session.settlePaneAttachAttempt?.('success')
    // Strict precedence snapshot > replay > coldRestore: paint exactly one, else overlapping tails duplicate TUI output on worktree switch.
    const hasStructuralReplay = Boolean(
      connectResult?.snapshot || connectResult?.replay || connectResult?.coldRestore
    )
    // Why: reattach drops startup commands; only real hibernation is authority to retire an empty adopted shell and resume its provider session.
    if (
      !hasStructuralReplay &&
      connectResult?.isReattach &&
      hasEmptyReattachRetireEvidence(ptyId, coldRestoreStartup)
    ) {
      session.transport.disconnect()
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
    // Keep the session-local identity in step with the transport before any
    // queued spawn callback can arrive during replay.
    session.activePanePtyBinding = ptyId
    session.activePanePtyBindingBoundAt = performance.now()
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
    // A split pane has its own PTY while the legacy tab-level field still
    // names the source pane. Only infer a tab-wide replacement when that
    // field is actually bound to this leaf; an unrelated sibling must not be
    // rewritten to the new pane's PTY.
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

    // Why consume-once: only the first reattach of a reveal remount may pay
    // the probe; a later in-place reconnect on this same mount must not buy a
    // second timeout before the replay paint.
    const revealFollowsTerminalPark =
      session.mountFollowsTerminalPark &&
      (connectResult?.isReattach === true || isRemoteRuntimePtyId(ptyId))
    session.mountFollowsTerminalPark = false
    // Why: ordinary parking destroys xterm. Rebuild from the authoritative
    // host snapshot before releasing queued live bytes; null falls back to
    // the subscribe screen without keeping the old xterm mounted.
    let prefetchedParkModelSnapshot: PtyBufferSnapshot | null = null
    // Why kept apart from null: null means "paint nothing", never "the pane is
    // empty". A probe that proved nothing (timeout, host declined for now) must
    // also re-ask the host, bounded, once the payload has settled.
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
      coldRestoreStartup,
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

    scheduleRuntimeGraphSync()
    return true
  }
}

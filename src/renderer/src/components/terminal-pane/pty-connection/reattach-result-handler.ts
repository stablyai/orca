import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import type { PtyBufferSnapshot, PtyConnectResult } from '../pty-transport'
import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
// Why: a restored pane's stale-account prompt can only be raised once a PTY is
// actually attached — nothing is inspectable while the session hydrates.
import { notifyCodexPaneBoundForStaleSweep } from '@/lib/codex-stale-pane-sweep'
import { useAppStore } from '@/store'
import { isPassiveCompletedHibernationEvidence } from '@/lib/sleeping-agent-pane-ownership'
import { parseAppSshPtyId } from '../../../../../shared/ssh-pty-id'
import { resolveHiddenRestoreScrollbackRows } from '../terminal-hidden-restore-scrollback'
import { shouldIgnoreStalePanePtyLayoutBinding } from './pane-pty-layout-binding'

import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import type { ReattachPayloadContext } from './reattach-payload-context'
import { createReattachPayloadHandlers } from './apply-reattach-payload'
import type { ReattachPayloadSession } from './reattach-payload-session'
import { recoverUnverifiableDirectSshReattach } from './direct-ssh-reattach-recovery'

type ReattachResultSession = ReattachPayloadSession &
  Pick<
    ConnectPanePtySession,
    | 'agentCompletionCoordinator'
    | 'activePanePtyBinding'
    | 'activePanePtyBindingBoundAt'
    | 'authoritativeReattachGeneration'
    | 'capturedDirectSshRetryPtyAccepted'
    | 'cacheKey'
    | 'connectionId'
    | 'deps'
    | 'directSshRetryAttempt'
    | 'disposed'
    | 'getSshMainModelSnapshotProbe'
    | 'handleReattachResult'
    | 'followsDirectSshReconnect'
    | 'mountFollowsTerminalPark'
    | 'registerEffectiveLaunchConfig'
    | 'registerPaneSerializerFor'
    | 'registerSideEffectFactConsumerForPty'
    | 'rejectObsoleteDirectSshReattach'
    | 'reportPanePtyVisibility'
    | 'sampleVisiblePaneForegroundAgent'
    | 'scheduleReattachIdleAgentCursorReset'
    | 'serializeHiddenOutputSnapshot'
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

    const retryPtyId =
      connectResult?.id ??
      (typeof result === 'string' ? result : (staleSessionId ?? session.transport.getPtyId()))
    if (session.rejectObsoleteDirectSshReattach(retryPtyId)) {
      // Why: an obsolete reattach must stop consuming frames without killing the durable PTY a newer lease may adopt.
      return false
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
      if (session.connectionId) {
        recoverUnverifiableDirectSshReattach(sessionBag, staleSessionId)
        return false
      }
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
      // Why: SSH sleep/reconnect can invalidate the relay PTY while the tab stays mounted; replace the dead lease in-place, not a stale overlay.
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
    // Strict precedence snapshot > replay > coldRestore: paint exactly one, else overlapping tails duplicate TUI output on worktree switch.
    const hasStructuralReplay = Boolean(
      connectResult?.snapshot || connectResult?.replay || connectResult?.coldRestore
    )
    const resumeComesFromPassiveHibernation = Boolean(
      coldRestoreStartup &&
      !coldRestoreStartup.useLiveEntry &&
      coldRestoreStartup.sleepingRecordEntry &&
      isPassiveCompletedHibernationEvidence(coldRestoreStartup.sleepingRecordEntry.record)
    )
    // Why: reattach drops startup commands; only passive hibernation is authority to retire an empty adopted shell and resume its provider session.
    if (!hasStructuralReplay && connectResult?.isReattach && resumeComesFromPassiveHibernation) {
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
    if (session.capturedDirectSshRetryPtyAccepted && session.directSshRetryAttempt) {
      session.deps.updateTabPtyId(
        session.deps.tabId,
        ptyId,
        replacementPtyId,
        session.directSshRetryAttempt.attemptId
      )
    } else if (replacementPtyId) {
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

    // Why (C1 SSH parking): main's headless model holds ~5k rows for SSH ptys
    // while the relay replay is a 100KiB raw-byte tail; prefer the model on
    // reveal. Only a non-empty 'headless'-sourced snapshot qualifies — the
    // renderer-serializer fallback has no mounted xterm after a park. The
    // paint happens inline in the snapshot-branch style: session.applyMainBufferSnapshot
    // would nest session.structuralReplayCoordinator.run inside the reattach task and
    // deadlock on the coordinator's tail chain.
    // Memoized: the prefetch and the payload task share one probe result, so a
    // null prefetch can never buy a second timeout before the relay paint.
    const fetchSshMainModelReattachSnapshot = session.getSshMainModelSnapshotProbe(ptyId)
    // Why consume-once: only the first reattach of a reveal remount may pay
    // the probe; a later in-place reconnect on this same mount must not buy a
    // second timeout before the relay paint.
    const revealFollowsTerminalPark =
      session.mountFollowsTerminalPark &&
      (connectResult?.isReattach === true || isRemoteRuntimePtyId(ptyId))
    session.mountFollowsTerminalPark = false
    // An SSH reconnect remounts the pane (tab.generation is its React key), so it also paints into
    // a fresh xterm — but unlike a park it may only use the model for a FULL-SCREEN app. See
    // sshReconnectPaintsFromModel for why.
    //
    // NOT consume-once, unlike mountFollowsTerminalPark: followsDirectSshReconnect is captured per
    // connectPanePty and never cleared, so this re-arms if one connect reaches handleReattachResult
    // twice. Bounded by connectStarted and by the emptiness/alt-screen gates rather than by the
    // read itself. It still reads the PENDING retry rather than directSshRetryAttempt, which also
    // accepts the live binding and so stays truthy for every later remount of the generation.
    const reconnectMayUseModel =
      Boolean(session.followsDirectSshReconnect) && !revealFollowsTerminalPark
    // Why: ordinary parking destroys xterm. Rebuild from the authoritative
    // host snapshot before releasing queued live bytes; null falls back to
    // the subscribe screen without keeping the old xterm mounted.
    let prefetchedParkModelSnapshot: PtyBufferSnapshot | null = null
    if (revealFollowsTerminalPark && (!hasStructuralReplay || isRemoteRuntimePtyId(ptyId))) {
      if (parseAppSshPtyId(ptyId)) {
        prefetchedParkModelSnapshot = await fetchSshMainModelReattachSnapshot()
      } else {
        try {
          const result = await session.serializeHiddenOutputSnapshot(ptyId, {
            scrollbackRows: resolveHiddenRestoreScrollbackRows(
              session.pane.terminal.options.scrollback
            )
          })
          prefetchedParkModelSnapshot = result.kind === 'snapshot' ? result.snapshot : null
        } catch {
          prefetchedParkModelSnapshot = null
        }
      }
      if (!isCurrentReattachPayload()) {
        return false
      }
    }
    // A reconnect with no relay tail can still restore main's model. Keep that probe and paint in
    // the structural transaction so live output cannot overtake the snapshot.
    const shouldApplyStructuralPayload =
      hasStructuralReplay || prefetchedParkModelSnapshot !== null || reconnectMayUseModel
    const reattachPayload: ReattachPayloadContext = {
      isCurrentReattachPayload,
      connectResult,
      ptyId,
      attemptGeneration,
      prefetchedParkModelSnapshot,
      revealFollowsTerminalPark,
      reconnectMayUseModel,
      fetchSshMainModelReattachSnapshot,
      shouldApplyStructuralPayload,
      coldRestoreStartup,
      reattachPayloadApplied: !shouldApplyStructuralPayload
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
    session.scheduleReattachIdleAgentCursorReset()

    scheduleRuntimeGraphSync()
    return true
  }
}

import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
// Inspect stale-account state only after a concrete PTY attaches.
import { notifyCodexPaneBoundForStaleSweep } from '@/lib/codex-stale-pane-sweep'
import { setRendererPtyVisibilityClaim } from '../pty-renderer-delivery-claims'

import { shouldIgnoreStalePanePtyLayoutBinding } from './pane-pty-layout-binding'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPanePtyVisibilityBind(session: ConnectPanePtySession): void {
  session.reportPanePtyVisibility = (ptyId: string | null | undefined, visible: boolean): void => {
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      // Remote-runtime streams bypass main’s renderer-visibility registry.
      return
    }
    setRendererPtyVisibilityClaim(session.transport, ptyId, visible)
  }
  session.bindActivePanePty = (
    ptyId: string,
    options: {
      seedInitialAgentStatus?: boolean
      updateTabPtyId?: 'always' | 'if-missing'
      replacePtyId?: string
      sampleVisibleForegroundAgent?: boolean
    } = {}
  ): boolean => {
    // A disposed pane can still receive an already-queued transport callback; it no longer owns state.
    if (session.disposed) {
      return false
    }
    const state = useAppStore.getState()
    const leafId = session.pane.leafId
    const existingPtyId = leafId
      ? state.terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[leafId]
      : undefined
    const tabPtyId = Object.values(state.tabsByWorktree)
      .flat()
      .find((tab) => tab.id === session.deps.tabId)?.ptyId
    // Remounted mirrored panes may fresh-spawn while the tab names an old host handle; replace it atomically instead of retaining both identities.
    const inferredReplacementPtyId =
      existingPtyId && existingPtyId !== ptyId && tabPtyId === existingPtyId
        ? existingPtyId
        : undefined
    const replacementPtyId = options.replacePtyId ?? inferredReplacementPtyId
    if (!options.replacePtyId) {
      const activePtyId = session.activePanePtyBinding
      const isCurrentPaneTransport =
        session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
      const isStaleTransportBinding =
        !isCurrentPaneTransport || (activePtyId !== null && session.transport.getPtyId() !== ptyId)
      const isInitialCurrentTransportBinding = isCurrentPaneTransport && activePtyId === null
      if (
        isStaleTransportBinding ||
        (shouldIgnoreStalePanePtyLayoutBinding({
          existingPtyId,
          nextPtyId: ptyId,
          tabPtyId
        }) &&
          !isInitialCurrentTransportBinding)
      ) {
        return false
      }
    }
    session.bindProcessExitState(ptyId, options.replacePtyId)
    if (session.activePanePtyBinding && session.activePanePtyBinding !== ptyId) {
      session.reportPanePtyVisibility(session.activePanePtyBinding, false)
    }
    session.setPanePtyFitBinding(ptyId)
    session.activePanePtyBinding = ptyId
    session.reportPanePtyVisibility(ptyId, session.deps.isVisibleRef.current)
    // Why: record bind time on the spawn/attach chokepoint so the reconcile
    // guard knows this binding is newer than any pre-bind snapshot.
    session.activePanePtyBindingBoundAt = performance.now()
    session.registerSideEffectFactConsumerForPty(ptyId)
    session.syncHiddenRendererPtyDelivery()
    // A live bind proves this pane is current again after detach/reattach.
    useAppStore.getState().restoreAgentPaneAuthority?.(session.cacheKey)
    notifyCodexPaneBoundForStaleSweep(ptyId)
    const tabPtyIds = useAppStore.getState().ptyIdsByTabId?.[session.deps.tabId] ?? []
    const updateTabPtyBinding = (): void => {
      if (replacementPtyId) {
        session.deps.updateTabPtyId(session.deps.tabId, ptyId, replacementPtyId)
      } else {
        session.deps.updateTabPtyId(session.deps.tabId, ptyId)
      }
    }
    const shouldUpdateTabPtyId =
      options.updateTabPtyId !== 'if-missing' || !tabPtyIds.includes(ptyId)
    if (replacementPtyId) {
      // Production replacement commits tab/layout atomically; keep lightweight test dependencies and pane bookkeeping synchronized too.
      if (shouldUpdateTabPtyId) {
        updateTabPtyBinding()
      }
      session.syncPanePtyLayoutBinding(ptyId)
    } else {
      if (shouldUpdateTabPtyId) {
        updateTabPtyBinding()
      }
      // Publish the tab identity first so a late layout callback cannot leave a tab and pane split.
      session.syncPanePtyLayoutBinding(ptyId)
    }
    if (session.paneStartup && !session.startupPtyBound) {
      // Settles the captured one-shot startup only after this pane owns a concrete PTY.
      session.startupPtyBound = true
      session.deps.onStartupBound?.()
    }
    if (options.seedInitialAgentStatus) {
      session.applyInitialAgentStatus()
    }
    // Sync again at concrete binding because the frame-level sync may have run before async spawn/attach resolved.
    scheduleRuntimeGraphSync()
    session.agentCompletionCoordinator?.startProcessTracking()
    session.onAgentPreReadyDraftPtyBound?.(ptyId, session.spawnedFreshPtyId === ptyId)
    // Seed command confirmation on fresh no-OSC agent launches: its retry ladder spans boot without latching a slow-start shell and poisoning recovery (#7620, #9703). Real OSC 133;C supersedes it.
    if (options.sampleVisibleForegroundAgent === true) {
      session.sampleVisiblePaneForegroundAgent?.()
    } else if (options.seedInitialAgentStatus === true) {
      const freshSpawnLaunchAgent = session.resolveExpectedLaunchTuiAgent?.()
      if (freshSpawnLaunchAgent) {
        session.paneForegroundAgentTracker?.onCommandStarted(freshSpawnLaunchAgent)
      }
    }
    return true
  }

  session.onPtySpawn = (ptyId: string): void => {
    // Track actual fresh spawns so unused shell-startup failures remain visible; reattach/cold restore must retain ordinary exit semantics.
    session.spawnedFreshPtyId = ptyId
    // Seed Command Code working state once bound; it has no prompt-start hook, and later hooks refine it.
    const bound = session.bindActivePanePty(ptyId, { seedInitialAgentStatus: true })
    if (!bound) {
      // Late stale spawn callbacks cannot consume startup now owned by a successor pane.
      return
    }
    // Spend queued startup only after this pane owns a concrete PTY.
    try {
      session.deps.onQueuedStartupSpawned?.()
    } catch {
      // Do not strand a successful spawn because a delivery callback failed.
    }
  }
  session.onPtyRebind = (
    ptyId: string,
    replacedPtyId: string,
    incarnationId?: string | null
  ): void => {
    if (session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport) {
      return
    }
    session.remotePtyIncarnationId = incarnationId ?? null
    session.noteBoundProcessIncarnation(incarnationId)
    // Handle rotation replaces store identity within the same pane/session generation, without fresh-spawn exit semantics.
    session.bindActivePanePty(ptyId, { replacePtyId: replacedPtyId })
  }
}

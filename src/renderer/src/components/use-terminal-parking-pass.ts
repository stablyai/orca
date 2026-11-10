import { MountedTerminalWorktrees } from './terminal/split-group-mount'
import { useEffect, useRef } from 'react'
import { useTerminalParkingWorkspaceChanges } from './terminal-pane/parking/use-terminal-parking-workspace-changes'
import { invalidateTerminalParkingInputs } from './terminal-pane/parking/terminal-parking-input-events'
import { useAppStore } from '../store/index'
import {
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
  countEvictionExemptTabRoutes,
  formatEvictionExemptRouteCounts,
  selectForceParkEvictableTabIds,
  selectRetentionForceParkedTerminalWorktrees
} from './terminal-pane/parking/retention/terminal-hidden-worktree-retention'
import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { selectEvictionExemptTerminalTabIds } from './terminal-pane/parking/retention/terminal-eviction-exempt-tabs'
import { captureParkedTerminalBuffers } from './terminal-pane/parking/capture/parked-terminal-buffer-capture'
import { warnTerminalLifecycleAnomaly } from './terminal-pane/layout/reconciliation/terminal-lifecycle-diagnostics'
import { recordTerminalWorktreeParkingDebugVerdicts } from './terminal-pane/parking/instrumentation/terminal-parking-e2e-overrides'
import { getTerminalWorktreeColdParkRecheckDelayMs } from './terminal-pane/parking/retention/terminal-cold-park-recheck-deadlines'
import { haveSameIdSet } from './terminal-workspace-model'
import { collectTerminalParkingPassCandidates } from './terminal-parking-pass-candidates'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

export function useTerminalParkingPass(controller: TerminalParkingFoundation): void {
  const {
    activeView,
    activityTerminalPortals,
    backgroundMountRevision,
    parkedCaptureDoneRef,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    setEvictionExemptTerminalTabIds,
    setForceParkedTerminalWorktreeIds,
    setParkedTerminalWorktreeIds,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalProviderSnapshotCapabilityRevision,
    terminalRetentionBudgetEnabled,
    terminalSshParkingEnabled,
    workspaceSurfaceIds
  } = controller
  // Why: this effect is the sole writer, so these mirror the queued state without a render.
  const dispatchedIdSetsRef = useRef<{
    parked: ReadonlySet<string>
    forceParked: ReadonlySet<string>
    evictionExempt: ReadonlySet<string>
  } | null>(null)

  const { revision, takeChangedWorkspaces } =
    useTerminalParkingWorkspaceChanges(workspaceSurfaceIds)
  const previousController = useRef<TerminalParkingFoundation | null>(null)
  const forcedParking = useRef<ReadonlySet<string>>(new Set())
  const exemptionByWorktree = useRef(new Map<string, ReadonlySet<string>>())
  useEffect(() => {
    const previous = previousController.current
    previousController.current = controller
    const dirty = takeChangedWorkspaces()
    if (controller.mountedWorktreeIdsRef.current instanceof MountedTerminalWorktrees) {
      for (const id of controller.mountedWorktreeIdsRef.current.takeCommittedChanges('retention')) {
        dirty.add(id)
      }
    }
    if (previous) {
      if (
        previous.activeView !== activeView ||
        previous.renderedActiveWorktreeId !== renderedActiveWorktreeId
      ) {
        if (previous.renderedActiveWorktreeId) {
          dirty.add(previous.renderedActiveWorktreeId)
        }
        if (renderedActiveWorktreeId) {
          dirty.add(renderedActiveWorktreeId)
        }
      }
      if (previous.activityTerminalPortals !== activityTerminalPortals) {
        for (const portal of [...previous.activityTerminalPortals, ...activityTerminalPortals]) {
          dirty.add(portal.worktreeId)
        }
      }
      if (previous.workspaceSurfaceIds !== workspaceSurfaceIds) {
        const currentIds = controller.workspaceSurfaceIdSet
        const previousIds = previous.workspaceSurfaceIdSet
        for (const id of previous.workspaceSurfaceIds) {
          if (!currentIds.has(id)) {
            dirty.add(id)
          }
        }
        for (const id of workspaceSurfaceIds) {
          if (!previousIds.has(id)) {
            dirty.add(id)
          }
        }
      }
      if (
        previous.terminalParkingEnabled !== terminalParkingEnabled ||
        previous.terminalRetentionBudgetEnabled !== terminalRetentionBudgetEnabled
      ) {
        for (const id of controller.mountedWorktreeIdsRef.current) {
          dirty.add(id)
        }
      }
    }
    if (dirty.size === 0) {
      return
    }
    const pass = collectTerminalParkingPassCandidates(controller, dirty)
    const retentionBudgetCandidates = pass.retentionBudgetCandidates
    const forceParkedWorktreeIds =
      pass.rankingChanged ||
      previous?.terminalRetentionBudgetEnabled !== terminalRetentionBudgetEnabled ||
      previous?.terminalParkingEnabled !== terminalParkingEnabled
        ? selectRetentionForceParkedTerminalWorktrees({
            worktrees: retentionBudgetCandidates,
            parkingEnabled: terminalParkingEnabled,
            retentionBudgetEnabled: terminalRetentionBudgetEnabled,
            nowMs: pass.nowMs,
            ...pass.overrides
          })
        : forcedParking.current
    forcedParking.current = forceParkedWorktreeIds
    if (pass.rankingChanged) {
      recordTerminalWorktreeParkingDebugVerdicts(
        retentionBudgetCandidates.map((candidate) => ({
          ...candidate,
          parkCooldownUntilMs: candidate.parkCooldownUntilMs ?? null,
          forceParked: forceParkedWorktreeIds.has(candidate.worktreeId)
        }))
      )
    }
    const capturedParked = parkedCaptureDoneRef.current
    const changedParkedIds = new Set(dirty)
    const previousParked = dispatchedIdSetsRef.current?.parked ?? new Set<string>()
    for (const id of previousParked) {
      if (!forceParkedWorktreeIds.has(id) && !pass.nextParkedTerminalWorktreeIds.has(id)) {
        changedParkedIds.add(id)
      }
    }
    for (const id of pass.nextParkedTerminalWorktreeIds) {
      if (!previousParked.has(id)) {
        changedParkedIds.add(id)
      }
    }
    for (const id of forceParkedWorktreeIds) {
      if (!previousParked.has(id)) {
        changedParkedIds.add(id)
      }
    }
    for (const id of changedParkedIds) {
      if (!forceParkedWorktreeIds.has(id) && !pass.nextParkedTerminalWorktreeIds.has(id)) {
        capturedParked.delete(id)
      }
    }
    const repos = useAppStore.getState().repos
    // Capture before unmount while xterm still owns client scrollback; paired-parking capability
    // does not guarantee host buffer retention. Force-parks capture below under their eviction exemption.
    // Why localOnly: the ordinary park is the every-hide cadence; its bytes stay off the upload.
    for (const worktreeId of changedParkedIds) {
      if (!pass.nextParkedTerminalWorktreeIds.has(worktreeId) || capturedParked.has(worktreeId)) {
        continue
      }
      if (
        captureParkedTerminalBuffers({
          worktreeId,
          tabIds: (tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
          repos,
          localOnly: true
        })
      ) {
        capturedParked.add(worktreeId)
      }
    }
    for (const id of exemptionByWorktree.current.keys()) {
      if (!forceParkedWorktreeIds.has(id)) {
        exemptionByWorktree.current.delete(id)
      }
    }
    const nextEvictionExemptTabIds = new Set<string>()
    for (const worktreeId of forceParkedWorktreeIds) {
      const forceParkedTabs = tabsByWorktree[worktreeId] ?? []
      let exemptTabIds = exemptionByWorktree.current.get(worktreeId)
      if (!exemptTabIds || dirty.has(worktreeId)) {
        exemptTabIds = selectEvictionExemptTerminalTabIds(worktreeId, forceParkedTabs)
        exemptionByWorktree.current.set(worktreeId, exemptTabIds)
      }
      for (const tabId of exemptTabIds) {
        nextEvictionExemptTabIds.add(tabId)
      }
      if (!capturedParked.has(worktreeId)) {
        const evictableTabIds = selectForceParkEvictableTabIds(forceParkedTabs, (tab) =>
          exemptTabIds.has(tab.id)
        )
        // Per-route exemption counts distinguish unresolved capabilities from fail-open IDs when force-park frees no heap.
        if (evictableTabIds.length === 0 && forceParkedTabs.length > 0) {
          const exemptRouteCounts = countEvictionExemptTabRoutes(forceParkedTabs, worktreeId)
          warnTerminalLifecycleAnomaly('retention force-park freed no panes', {
            worktreeId,
            reason: `exemptTabs=${forceParkedTabs.length} ${formatEvictionExemptRouteCounts(exemptRouteCounts)}`
          })
          recordRendererCrashBreadcrumb('terminal_force_park_freed_no_panes', {
            exemptTabs: forceParkedTabs.length,
            ...exemptRouteCounts
          })
        }
        // Rare force-parks share captures so another desktop can cold-restore them.
        if (
          captureParkedTerminalBuffers({
            worktreeId,
            tabIds: evictableTabIds,
            repos,
            localOnly: false
          })
        ) {
          capturedParked.add(worktreeId)
        }
      }
      pass.nextParkedTerminalWorktreeIds.add(worktreeId)
    }
    // No-op functional updaters still queue renders in PTY-exit commit cascades and can exceed React’s nested-update limit (#185).
    const dispatched = (dispatchedIdSetsRef.current ??= {
      parked: new Set(),
      forceParked: new Set(),
      evictionExempt: new Set()
    })
    if (!haveSameIdSet(dispatched.parked, pass.nextParkedTerminalWorktreeIds)) {
      dispatched.parked = pass.nextParkedTerminalWorktreeIds
      setParkedTerminalWorktreeIds(pass.nextParkedTerminalWorktreeIds)
    }
    if (!haveSameIdSet(dispatched.forceParked, forceParkedWorktreeIds)) {
      dispatched.forceParked = forceParkedWorktreeIds
      setForceParkedTerminalWorktreeIds(forceParkedWorktreeIds)
    }
    if (!haveSameIdSet(dispatched.evictionExempt, nextEvictionExemptTabIds)) {
      dispatched.evictionExempt = nextEvictionExemptTabIds
      setEvictionExemptTerminalTabIds(nextEvictionExemptTabIds)
    }
    const retentionTtlEligibleIds = new Set(
      retentionBudgetCandidates
        .filter((candidate) => !candidate.ordinaryParkingCovers && !candidate.hasPendingSpawnWork)
        .map((candidate) => candidate.worktreeId)
    )

    for (const worktreeId of changedParkedIds) {
      const previousTimer = pass.parkingTimers.get(worktreeId)
      if (previousTimer !== undefined) {
        window.clearTimeout(previousTimer)
        pass.parkingTimers.delete(worktreeId)
      }
      const candidate = pass.candidateForWorktree(worktreeId)
      if (!candidate) {
        continue
      }
      if (
        candidate.isVisible ||
        candidate.shouldMeasureHiddenWorktree ||
        candidate.hasActivityTerminalPortal ||
        pass.nextParkedTerminalWorktreeIds.has(candidate.worktreeId)
      ) {
        continue
      }
      const delayMs = getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: terminalParkingEnabled,
        hiddenSinceMs: candidate.hiddenSinceMs,
        parkCooldownUntilMs: candidate.parkCooldownUntilMs,
        nowMs: pass.nowMs,
        ...pass.overrides,
        ...(terminalRetentionBudgetEnabled && retentionTtlEligibleIds.has(candidate.worktreeId)
          ? {
              retentionTtlMs:
                pass.overrides.retentionTtlMs ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
            }
          : {})
      })
      if (delayMs !== null && delayMs > 0) {
        const worktreeId = candidate.worktreeId
        const timer = window.setTimeout(() => {
          pass.parkingTimers.delete(worktreeId)
          invalidateTerminalParkingInputs(worktreeId)
        }, delayMs)
        pass.parkingTimers.set(worktreeId, timer)
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `controller` is rebuilt every render; the pass reads only the listed values and stable refs.
  }, [
    revision,
    takeChangedWorkspaces,
    activeView,
    activityTerminalPortals,
    backgroundMountRevision,
    parkedCaptureDoneRef,
    pendingStartupByTabId,
    pairedRuntimeParkingEnvironmentIds,
    renderedActiveWorktreeId,
    setEvictionExemptTerminalTabIds,
    setForceParkedTerminalWorktreeIds,
    setParkedTerminalWorktreeIds,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalProviderSnapshotCapabilityRevision,
    terminalRetentionBudgetEnabled,
    terminalSshParkingEnabled,
    workspaceSurfaceIds
  ])
}

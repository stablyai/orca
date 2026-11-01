import { useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import {
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
  countEvictionExemptTabRoutes,
  formatEvictionExemptRouteCounts,
  hasPendingRetentionSpawnWork,
  selectForceParkEvictableTabIds,
  selectRetentionForceParkedTerminalWorktrees,
  type TerminalWorktreeRetentionCandidate
} from './terminal-pane/terminal-hidden-worktree-retention'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { selectEvictionExemptTerminalTabIds } from './terminal-pane/terminal-eviction-exempt-tabs'
import { captureParkedTerminalBuffers } from './terminal-pane/parked-terminal-buffer-capture'
import { warnTerminalLifecycleAnomaly } from './terminal-pane/terminal-lifecycle-diagnostics'
import { recordTerminalWorktreeParkingDebugVerdicts } from './terminal-pane/terminal-parking-e2e-overrides'
import { getTerminalWorktreeColdParkRecheckDelayMs } from './terminal-pane/terminal-cold-park-recheck-deadlines'
import { haveSameIdSet } from './terminal-workspace-model'
import {
  canOrdinarilyParkRetentionCandidate,
  collectTerminalParkingPassCandidates
} from './terminal-parking-pass-candidates'
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
    setTerminalParkingRevision,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalParkingRevision,
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

  useEffect(() => {
    const pass = collectTerminalParkingPassCandidates(controller)
    const retentionBudgetCandidates: TerminalWorktreeRetentionCandidate[] =
      pass.retentionCandidates.map((candidate) => {
        const tabs = tabsByWorktree[candidate.worktreeId] ?? []
        return {
          worktreeId: candidate.worktreeId,
          hiddenSinceMs: candidate.hiddenSinceMs,
          isVisible: candidate.isVisible,
          shouldMeasureHiddenWorktree: candidate.shouldMeasureHiddenWorktree,
          hasActivityTerminalPortal: candidate.hasActivityTerminalPortal,
          parkCooldownUntilMs: candidate.parkCooldownUntilMs ?? null,
          ordinaryParkingCovers: canOrdinarilyParkRetentionCandidate(controller, pass, candidate),
          hasPendingSpawnWork: tabs.some((tab) =>
            hasPendingRetentionSpawnWork(tab, pendingStartupByTabId)
          )
        }
      })
    const forceParkedWorktreeIds = selectRetentionForceParkedTerminalWorktrees({
      worktrees: retentionBudgetCandidates,
      parkingEnabled: terminalParkingEnabled,
      retentionBudgetEnabled: terminalRetentionBudgetEnabled,
      nowMs: pass.nowMs,
      ...pass.overrides
    })
    recordTerminalWorktreeParkingDebugVerdicts(
      retentionBudgetCandidates.map((candidate) => ({
        ...candidate,
        parkCooldownUntilMs: candidate.parkCooldownUntilMs ?? null,
        forceParked: forceParkedWorktreeIds.has(candidate.worktreeId)
      }))
    )
    const capturedParked = parkedCaptureDoneRef.current
    for (const id of Array.from(capturedParked)) {
      if (!forceParkedWorktreeIds.has(id) && !pass.nextParkedTerminalWorktreeIds.has(id)) {
        capturedParked.delete(id)
      }
    }
    const repos = useAppStore.getState().repos
    // Capture before unmount while xterm still owns client scrollback; paired-parking capability
    // does not guarantee host buffer retention. Force-parks capture below under their eviction exemption.
    // Why localOnly: the ordinary park is the every-hide cadence; its bytes stay off the upload.
    for (const worktreeId of pass.nextParkedTerminalWorktreeIds) {
      if (capturedParked.has(worktreeId)) {
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
    const nextEvictionExemptTabIds = new Set<string>()
    for (const worktreeId of forceParkedWorktreeIds) {
      const forceParkedTabs = tabsByWorktree[worktreeId] ?? []
      const exemptTabIds = selectEvictionExemptTerminalTabIds(worktreeId, forceParkedTabs)
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

    for (const candidate of pass.retentionCandidates) {
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
          setTerminalParkingRevision((revision) => revision + 1)
        }, delayMs)
        pass.parkingTimers.set(worktreeId, timer)
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `controller` is rebuilt every render; the pass reads only the listed values and stable refs.
  }, [
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
    setTerminalParkingRevision,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalParkingRevision,
    terminalProviderSnapshotCapabilityRevision,
    terminalRetentionBudgetEnabled,
    terminalSshParkingEnabled,
    workspaceSurfaceIds
  ])
}

import { useEffect } from 'react'
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
import { captureForceParkedWorktreeBuffers } from './terminal-pane/force-park-buffer-capture'
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
    forceParkedCaptureDoneRef,
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
    const capturedForceParked = forceParkedCaptureDoneRef.current
    for (const id of Array.from(capturedForceParked)) {
      if (!forceParkedWorktreeIds.has(id)) {
        capturedForceParked.delete(id)
      }
    }
    const repos = useAppStore.getState().repos
    const nextEvictionExemptTabIds = new Set<string>()
    for (const worktreeId of forceParkedWorktreeIds) {
      const forceParkedTabs = tabsByWorktree[worktreeId] ?? []
      const exemptTabIds = selectEvictionExemptTerminalTabIds(worktreeId, forceParkedTabs)
      for (const tabId of exemptTabIds) {
        nextEvictionExemptTabIds.add(tabId)
      }
      if (!capturedForceParked.has(worktreeId)) {
        const evictableTabIds = selectForceParkEvictableTabIds(forceParkedTabs, (tab) =>
          exemptTabIds.has(tab.id)
        )
        // Why routed + breadcrumbed: only per-route counts in a field bundle
        // can say whether fail-open ids or unresolved snapshot capability
        // dominates the degenerate all-exempt force-park (which frees no heap).
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
        if (
          captureForceParkedWorktreeBuffers({
            worktreeId,
            tabIds: evictableTabIds,
            repos
          })
        ) {
          capturedForceParked.add(worktreeId)
        }
      }
      pass.nextParkedTerminalWorktreeIds.add(worktreeId)
    }
    setParkedTerminalWorktreeIds((current) =>
      haveSameIdSet(current, pass.nextParkedTerminalWorktreeIds)
        ? current
        : pass.nextParkedTerminalWorktreeIds
    )
    setForceParkedTerminalWorktreeIds((current) =>
      haveSameIdSet(current, forceParkedWorktreeIds) ? current : forceParkedWorktreeIds
    )
    setEvictionExemptTerminalTabIds((current) =>
      haveSameIdSet(current, nextEvictionExemptTabIds) ? current : nextEvictionExemptTabIds
    )
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [
    activeView,
    activityTerminalPortals,
    backgroundMountRevision,
    pendingStartupByTabId,
    pairedRuntimeParkingEnvironmentIds,
    renderedActiveWorktreeId,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalParkingRevision,
    terminalProviderSnapshotCapabilityRevision,
    terminalRetentionBudgetEnabled,
    terminalSshParkingEnabled,
    workspaceSurfaceIds
  ])
}

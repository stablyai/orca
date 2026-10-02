import { useAppStore } from '../store'
import {
  TERMINAL_HIDDEN_TAB_RETENTION_RECHECK_MS,
  hasPendingRetentionSpawnWork,
  selectHiddenTerminalTabsBeyondRetentionBudget
} from './terminal-pane/terminal-hidden-worktree-retention'
import { selectEvictionExemptTerminalTabIds } from './terminal-pane/terminal-eviction-exempt-tabs'
import { getMountedTerminalTabBufferEstimates } from '@/lib/pane-manager/pane-manager-registry'
import { canWatcherCoverParkedTerminalTab } from './terminal-pane/terminal-parked-tab-watchers'
import { selectSleepingRecordParkExemptTabIds } from './terminal-pane/sleeping-record-park-exemption'
import { getTerminalPaneSplitMountLeaseTabIds } from './terminal-pane/terminal-pane-split-request-routing'
import { captureParkedTerminalBuffers } from './terminal-pane/parked-terminal-buffer-capture'
import { haveSameIdSet } from './terminal-workspace-model'
import type { collectTerminalParkingPassCandidates } from './terminal-parking-pass-candidates'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

// Why: retention parks run after the ordinary captures and cover only tabs they skipped, so this
// is the last moment a remote tab's xterm — its only client-side copy — can be serialized. A tab
// whose capture is incomplete stays mounted so the recheck pass retries it.
export function withholdUncapturedRetentionParks(
  selectedTabIds: ReadonlySet<string>,
  alreadyParkedTabIds: ReadonlySet<string>,
  worktreeIdByTabId: ReadonlyMap<string, string>
): Set<string> {
  const repos = useAppStore.getState().repos ?? []
  const parked = new Set<string>()
  for (const tabId of selectedTabIds) {
    const worktreeId = worktreeIdByTabId.get(tabId)
    if (
      alreadyParkedTabIds.has(tabId) ||
      worktreeId === undefined ||
      captureParkedTerminalBuffers({ worktreeId, tabIds: [tabId], repos, localOnly: true })
    ) {
      parked.add(tabId)
    }
  }
  return parked
}

// Why: per-tab retention budget across all worktrees, so hidden tabs of any worktree can be
// parked once the warm set exceeds its tab count / buffer-bytes cap.
export function runHiddenTabRetentionPass(
  controller: TerminalParkingFoundation,
  pass: ReturnType<typeof collectTerminalParkingPassCandidates>
): void {
  const {
    activeTabId,
    activeView,
    activityTerminalPortals,
    groupsByWorktree,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    retentionParkedTerminalTabIds,
    retentionHiddenSinceByTabIdRef,
    retentionParkRecheckTimerRef,
    setRetentionParkedTerminalTabIds,
    setTerminalParkingRevision,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalRetentionBudgetEnabled,
    unifiedTabsByWorktree,
    workspaceSurfaceIds
  } = controller
  const worktreeIdByTabId = new Map<string, string>()
  const globalRetentionEnabled = terminalParkingEnabled && terminalRetentionBudgetEnabled
  const allTerminalTabIds = new Set<string>()
  for (const worktreeId of workspaceSurfaceIds) {
    for (const tab of tabsByWorktree[worktreeId] ?? []) {
      allTerminalTabIds.add(tab.id)
    }
  }
  for (const tabId of Array.from(retentionHiddenSinceByTabIdRef.current.keys())) {
    if (!allTerminalTabIds.has(tabId)) {
      retentionHiddenSinceByTabIdRef.current.delete(tabId)
    }
  }
  const mountedBufferBytesByTabId = getMountedTerminalTabBufferEstimates(allTerminalTabIds)
  const splitLeaseTabIds = getTerminalPaneSplitMountLeaseTabIds()
  const nextRetentionParkedTabIds = new Set<string>()
  const globalCandidates: {
    tabId: string
    hiddenSinceMs: number
    estimatedBufferBytes: number
  }[] = []
  let hasHiddenMountedTab = false
  for (const worktreeId of workspaceSurfaceIds) {
    const tabs = tabsByWorktree[worktreeId] ?? []
    const worktreeCandidate = pass.retentionCandidates.find(
      (candidate) => candidate.worktreeId === worktreeId
    )
    const isWorktreeVisible = activeView === 'terminal' && renderedActiveWorktreeId === worktreeId
    const activeUnifiedTabIds = new Set(
      (groupsByWorktree[worktreeId] ?? [])
        .map((group) => group.activeTabId)
        .filter((tabId): tabId is string => typeof tabId === 'string')
    )
    const visibleTerminalTabIds = new Set(
      (unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tab.contentType === 'terminal' && activeUnifiedTabIds.has(tab.id))
        .map((tab) => tab.entityId)
    )
    const portalTabIds = new Set(
      activityTerminalPortals
        .filter((portal) => portal.worktreeId === worktreeId)
        .map((portal) => portal.tabId)
    )
    const sleepingTabIds = selectSleepingRecordParkExemptTabIds(useAppStore.getState(), worktreeId)
    const exemptTabIds = selectEvictionExemptTerminalTabIds(worktreeId, tabs)
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
      const isVisible =
        isWorktreeVisible &&
        (visibleTerminalTabIds.has(tab.id) ||
          (visibleTerminalTabIds.size === 0 && tab.id === activeTabId))
      const hasPendingSpawn = hasPendingRetentionSpawnWork(tab, pendingStartupByTabId)
      const release =
        isVisible ||
        portalTabIds.has(tab.id) ||
        hasPendingSpawn ||
        sleepingTabIds.has(tab.id) ||
        splitLeaseTabIds.has(tab.id) ||
        exemptTabIds.has(tab.id)
      if (release) {
        retentionHiddenSinceByTabIdRef.current.delete(tab.id)
        continue
      }
      if (retentionParkedTerminalTabIds.has(tab.id)) {
        if (globalRetentionEnabled) {
          nextRetentionParkedTabIds.add(tab.id)
        }
        continue
      }
      const estimatedBufferBytes = mountedBufferBytesByTabId.get(tab.id)
      if (estimatedBufferBytes === undefined) {
        continue
      }
      hasHiddenMountedTab = true
      if (
        !globalRetentionEnabled ||
        worktreeCandidate?.shouldMeasureHiddenWorktree ||
        pass.nextParkedTerminalWorktreeIds.has(worktreeId) ||
        exemptTabIds.has(tab.id) ||
        !canWatcherCoverParkedTerminalTab(worktreeId, tab)
      ) {
        continue
      }
      const hiddenSinceMs = retentionHiddenSinceByTabIdRef.current.get(tab.id) ?? pass.nowMs
      retentionHiddenSinceByTabIdRef.current.set(tab.id, hiddenSinceMs)
      globalCandidates.push({ tabId: tab.id, hiddenSinceMs, estimatedBufferBytes })
    }
  }
  const budgetParkedTabIds = withholdUncapturedRetentionParks(
    selectHiddenTerminalTabsBeyondRetentionBudget({
      candidates: globalCandidates,
      nowMs: pass.nowMs,
      enabled: globalRetentionEnabled,
      ...(pass.overrides.coldParkDelayMs !== undefined
        ? { coldParkDelayMs: pass.overrides.coldParkDelayMs }
        : {})
    }),
    retentionParkedTerminalTabIds,
    worktreeIdByTabId
  )
  for (const tabId of budgetParkedTabIds) {
    nextRetentionParkedTabIds.add(tabId)
  }
  setRetentionParkedTerminalTabIds((current) =>
    haveSameIdSet(current, nextRetentionParkedTabIds) ? current : nextRetentionParkedTabIds
  )
  const retentionTimer = retentionParkRecheckTimerRef.current
  if (retentionTimer !== null) {
    window.clearTimeout(retentionTimer)
    retentionParkRecheckTimerRef.current = null
  }
  if (globalRetentionEnabled && hasHiddenMountedTab) {
    retentionParkRecheckTimerRef.current = window.setTimeout(() => {
      retentionParkRecheckTimerRef.current = null
      setTerminalParkingRevision((revision) => revision + 1)
    }, TERMINAL_HIDDEN_TAB_RETENTION_RECHECK_MS)
  }
}

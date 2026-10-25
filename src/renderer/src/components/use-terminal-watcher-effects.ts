import { useEffect, useMemo, useRef } from 'react'
import { findActivityTerminalPortal } from './activity/activity-terminal-portal'
import { shouldAutoCreateInitialTerminal } from './terminal/initial-terminal'
import {
  canWatcherCoverParkedTerminalTab,
  disposeAllParkedTerminalWatchers,
  pruneParkedTerminalWatchers,
  syncParkedTerminalTabWatchersForWorkspaces,
  terminalWatcherLiveWorkspaceIds,
  type ParkedTerminalTabWatcherSyncEntry
} from './terminal-pane/terminal-parked-tab-watchers'
import { useAppStore } from '@/store'
import { isTerminalWorkspaceEmptiedOnPurpose } from '../../../shared/closed-terminal-tab-tombstones'
import { gateWorktreeAgentActivation } from '@/lib/worktree-agent-activation-gate'
import { createWorkspaceTerminalHostAuthoritySelector } from '@/lib/workspace-terminal-host-authority'
import { hasStructuredAgentLaunchInWorktree } from '@/lib/structured-agent-session-launch'
import { isEmptyWorkspaceDefaultSurfacePending } from '@/lib/empty-workspace-default-surface-claims'
import type { TerminalColdActivationController } from './terminal-cold-activation'
import { selectParkedEquivalentMountTabIds } from './terminal/startup-terminal-tab-hold'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { createInitialTerminalThroughLayoutOwner } from '@/store/terminals/terminal-tab-create-through-layout-owner'

// Why shared: surfaces without watchable live tabs need no per-pass allocation.
const NO_PARKED_TAB_IDS: ReadonlySet<string> = new Set()

type TerminalWatcherController = Pick<
  TerminalColdActivationController,
  | 'activationDeferredMountTabIdsByWorktreeRef'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeView'
  | 'activeWorktreeId'
  | 'activityTerminalPortals'
  | 'anyMountedWorktreeHasLayout'
  | 'backgroundMountRevision'
  | 'createTab'
  | 'effectiveParkedTerminalWorktreeIds'
  | 'evictionExemptTerminalTabIds'
  | 'getEffectiveLayoutForWorktree'
  | 'groupsByWorktree'
  | 'hydrationSucceeded'
  | 'measurableBackgroundWorktreeIdsRef'
  | 'mountedWorktreeIdsRef'
  | 'pairedRuntimeParkingEnvironmentIds'
  | 'pendingStartupByTabId'
  | 'reconcileWorktreeTabModel'
  | 'renderedActiveWorktreeId'
  | 'startupTerminalTabHold'
  | 'tabsByWorktree'
  | 'terminalParkingEnabled'
  | 'terminalProviderSnapshotCapabilityRevision'
  | 'terminalSshParkingEnabled'
  | 'terminalStartupRestorationReady'
  | 'terminalTitleSnapshotAuthorityEnabled'
  | 'workspaceSessionReady'
  | 'workspaceSurfaceIds'
>

export function useTerminalWatcherEffects(controller: TerminalWatcherController): void {
  const {
    activationDeferredMountTabIdsByWorktreeRef,
    activeTabId,
    activeTabIdByWorktree,
    activeView,
    activeWorktreeId,
    activityTerminalPortals,
    anyMountedWorktreeHasLayout,
    backgroundMountRevision,
    createTab,
    effectiveParkedTerminalWorktreeIds,
    evictionExemptTerminalTabIds,
    getEffectiveLayoutForWorktree,
    groupsByWorktree,
    hydrationSucceeded,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    reconcileWorktreeTabModel,
    renderedActiveWorktreeId,
    startupTerminalTabHold,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalProviderSnapshotCapabilityRevision,
    terminalSshParkingEnabled,
    terminalStartupRestorationReady,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaceIds
  } = controller

  useEffect(() => {
    pruneParkedTerminalWatchers(terminalWatcherLiveWorkspaceIds(workspaceSurfaceIds))
    const syncEntriesByWorktreeId = new Map<string, ParkedTerminalTabWatcherSyncEntry>()
    for (const workspaceId of workspaceSurfaceIds) {
      if (
        anyMountedWorktreeHasLayout &&
        mountedWorktreeIdsRef.current.has(workspaceId) &&
        getEffectiveLayoutForWorktree(workspaceId)
      ) {
        continue
      }
      const tabs = tabsByWorktree[workspaceId] ?? []
      let parkedTabIds: ReadonlySet<string> = NO_PARKED_TAB_IDS
      let deferredTabIds: ReadonlySet<string> | null = null
      if (!anyMountedWorktreeHasLayout && mountedWorktreeIdsRef.current.has(workspaceId)) {
        const mountedParkedTabIds = new Set<string>()
        parkedTabIds = mountedParkedTabIds
        const isVisible = activeView === 'terminal' && workspaceId === renderedActiveWorktreeId
        const shouldMeasureHiddenWorktree =
          !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspaceId)
        const parked =
          !isVisible &&
          !shouldMeasureHiddenWorktree &&
          effectiveParkedTerminalWorktreeIds.has(workspaceId)
        if (parked) {
          for (const tab of tabs) {
            const activityTerminalPortal = findActivityTerminalPortal(activityTerminalPortals, {
              worktreeId: workspaceId,
              tabId: tab.id
            })
            if (!activityTerminalPortal && !evictionExemptTerminalTabIds.has(tab.id)) {
              mountedParkedTabIds.add(tab.id)
            }
          }
        }
        deferredTabIds = selectParkedEquivalentMountTabIds(
          activationDeferredMountTabIdsByWorktreeRef.current.get(workspaceId),
          startupTerminalTabHold,
          workspaceId
        )
        for (const tab of tabs) {
          if (
            deferredTabIds?.has(tab.id) &&
            !mountedParkedTabIds.has(tab.id) &&
            canWatcherCoverParkedTerminalTab(workspaceId, tab) &&
            !findActivityTerminalPortal(activityTerminalPortals, {
              worktreeId: workspaceId,
              tabId: tab.id
            })
          ) {
            mountedParkedTabIds.add(tab.id)
          }
        }
      }
      if (tabs.length > 0 && !mountedWorktreeIdsRef.current.has(workspaceId)) {
        const backgroundTabIds = tabs
          .filter(
            (tab) =>
              canWatcherCoverParkedTerminalTab(workspaceId, tab) &&
              !findActivityTerminalPortal(activityTerminalPortals, {
                worktreeId: workspaceId,
                tabId: tab.id
              })
          )
          .map((tab) => tab.id)
        if (backgroundTabIds.length > 0) {
          // CLI-created live terminals have never mounted a pane to consume host title facts.
          parkedTabIds = new Set(backgroundTabIds)
          deferredTabIds = parkedTabIds
        }
      }
      syncEntriesByWorktreeId.set(workspaceId, {
        tabs,
        parkedTabIds,
        ...(deferredTabIds ? { restoreTitleOnStartTabIds: deferredTabIds } : {})
      })
    }
    syncParkedTerminalTabWatchersForWorkspaces(syncEntriesByWorktreeId)
  }, [
    activationDeferredMountTabIdsByWorktreeRef,
    activeTabId,
    activeView,
    activityTerminalPortals,
    activeTabIdByWorktree,
    anyMountedWorktreeHasLayout,
    backgroundMountRevision,
    evictionExemptTerminalTabIds,
    getEffectiveLayoutForWorktree,
    groupsByWorktree,
    effectiveParkedTerminalWorktreeIds,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    startupTerminalTabHold,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalProviderSnapshotCapabilityRevision,
    terminalSshParkingEnabled,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaceIds
  ])
  useEffect(() => () => disposeAllParkedTerminalWatchers(), [])

  const startupActivationGateWorktreeIdsRef = useRef(new Set<string>())
  // Subscribe so host answers rerun the passes; retain owner resolution to avoid repeating catalog walks on every store write (STA-3363).
  const hostAuthoritySelector = useMemo(
    () => createWorkspaceTerminalHostAuthoritySelector(activeWorktreeId),
    [activeWorktreeId]
  )
  const activeWorktreeHostAuthority = useAppStore(hostAuthoritySelector)

  useEffect(() => {
    if (!workspaceSessionReady || !terminalStartupRestorationReady || !activeWorktreeId) {
      return
    }
    // An unanswered owner is not an empty host; seeding before its census duplicates tabs (STA-4658).
    if (activeWorktreeHostAuthority !== 'none') {
      return
    }
    if (startupActivationGateWorktreeIdsRef.current.has(activeWorktreeId)) {
      return
    }
    let cancelled = false
    void gateWorktreeAgentActivation(activeWorktreeId).then((outcome) => {
      if (
        cancelled ||
        outcome === 'blocked' ||
        useAppStore.getState().activeWorktreeId !== activeWorktreeId
      ) {
        return
      }
      // An in-flight reseed owns the surface but remains unmarked so leaving mid-wait allows retry on return.
      if (outcome === 'empty' && isEmptyWorkspaceDefaultSurfacePending(activeWorktreeId)) {
        return
      }
      // Only applied decisions consume the gate; canceled/blocked checks stay retryable and reruns share the in-flight promise.
      startupActivationGateWorktreeIdsRef.current.add(activeWorktreeId)
      if (outcome !== 'empty') {
        return
      }
      // A pending or unanswered chat create owns the surface even before its tab is published.
      if (hasStructuredAgentLaunchInWorktree(activeWorktreeId)) {
        return
      }
      // Why: the activation gate reconciles durable/live agent state first; only an actually empty, never-visited workspace receives a default shell.
      const { renderableTabCount } = reconcileWorktreeTabModel(activeWorktreeId)
      // Only recorded closes preserve emptiness; reread at decision time because rows can change while waiting.
      const activeWorktreeHasTerminalState = isTerminalWorkspaceEmptiedOnPurpose(
        useAppStore.getState(),
        activeWorktreeId
      )
      if (shouldAutoCreateInitialTerminal(renderableTabCount, activeWorktreeHasTerminalState)) {
        if (
          ORCA_LAYOUT_OWNER_IS_MAIN &&
          createInitialTerminalThroughLayoutOwner(useAppStore.getState, activeWorktreeId, () =>
            createTab(activeWorktreeId, undefined, undefined, { pendingActivationSpawn: true })
          )
        ) {
          return
        }
        // Initial default tabs must not count as user activity and reorder the sidebar; explicit New Tab still does.
        createTab(activeWorktreeId, undefined, undefined, { pendingActivationSpawn: true })
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    activeWorktreeId,
    activeWorktreeHostAuthority,
    createTab,
    reconcileWorktreeTabModel,
    terminalStartupRestorationReady,
    workspaceSessionReady
  ])

  const startupResumeWorktreeIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (
      !workspaceSessionReady ||
      !terminalStartupRestorationReady ||
      !hydrationSucceeded ||
      !activeWorktreeId
    ) {
      return
    }
    if (startupResumeWorktreeIdsRef.current.has(activeWorktreeId)) {
      return
    }
    // Do not consume recovery while the host is unanswered or sleeping agents remain stranded for this session.
    if (activeWorktreeHostAuthority === 'unverifiable') {
      return
    }
    startupResumeWorktreeIdsRef.current.add(activeWorktreeId)
    // Startup recovery needs the same host census and in-flight gate as explicit activation.
    void gateWorktreeAgentActivation(activeWorktreeId).then(
      (outcome) => {
        if (outcome === 'blocked') {
          startupResumeWorktreeIdsRef.current.delete(activeWorktreeId)
        }
      },
      () => startupResumeWorktreeIdsRef.current.delete(activeWorktreeId)
    )
  }, [
    activeWorktreeId,
    activeWorktreeHostAuthority,
    hydrationSucceeded,
    terminalStartupRestorationReady,
    workspaceSessionReady
  ])
}

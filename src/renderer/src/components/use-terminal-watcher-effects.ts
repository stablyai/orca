import { MountedTerminalWorktrees } from './terminal/split-group-mount'
import { useEffect, useRef } from 'react'
import { useTerminalStartupActivation } from './terminal/use-terminal-startup-activation'
import { useTerminalParkingWorkspaceChanges } from './terminal-pane/parking/use-terminal-parking-workspace-changes'
import { getTerminalTabOwnerWorktreeId } from '@/store/terminals/terminal-tab-owner-index'
import { findActivityTerminalPortal } from './activity/activity-terminal-portal'
import {
  canWatcherCoverParkedTerminalTab,
  syncParkedTerminalTabWatchersForWorkspaces,
  type ParkedTerminalTabWatcherSyncEntry
} from './terminal-pane/parking/output-watchers/terminal-parked-tab-watchers'
import {
  disposeAllParkedTerminalWatchers,
  pruneParkedTerminalWatchers,
  terminalWatcherLiveWorkspaceIds
} from './terminal-pane/parking/output-watchers/terminal-parked-watcher-registry'

import { useAppStore } from '@/store'
import type { TerminalColdActivationController } from './terminal-cold-activation'
import { selectParkedEquivalentMountTabIds } from './terminal/startup-terminal-tab-hold'

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
  | 'workspaceSurfaceIdSet'
  | 'workspaceSurfaceIds'
>

export function useTerminalWatcherEffects(controller: TerminalWatcherController): void {
  const {
    activationDeferredMountTabIdsByWorktreeRef,
    activeTabId,
    activeTabIdByWorktree,
    activeView,
    activityTerminalPortals,
    anyMountedWorktreeHasLayout,
    backgroundMountRevision,
    effectiveParkedTerminalWorktreeIds,
    evictionExemptTerminalTabIds,
    getEffectiveLayoutForWorktree,
    groupsByWorktree,
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
    workspaceSurfaceIdSet,
    workspaceSurfaceIds
  } = controller

  const { revision, takeChangedWorkspaces } =
    useTerminalParkingWorkspaceChanges(workspaceSurfaceIds)
  const previousWatcherInputs = useRef<TerminalWatcherController | null>(null)
  useEffect(() => {
    const previous = previousWatcherInputs.current
    previousWatcherInputs.current = controller
    const dirty = takeChangedWorkspaces()
    if (mountedWorktreeIdsRef.current instanceof MountedTerminalWorktrees) {
      for (const id of mountedWorktreeIdsRef.current.takeCommittedChanges('watcher')) {
        dirty.add(id)
      }
    }
    if (!previous || previous.workspaceSurfaceIds !== workspaceSurfaceIds) {
      const previousIds = new Set(previous?.workspaceSurfaceIds)
      for (const id of workspaceSurfaceIds) {
        if (!previousIds.has(id)) {
          dirty.add(id)
        }
      }
      pruneParkedTerminalWatchers(terminalWatcherLiveWorkspaceIds(workspaceSurfaceIds))
    }
    if (previous) {
      if (
        previous.activeTabId !== activeTabId ||
        previous.backgroundMountRevision !== backgroundMountRevision
      ) {
        if (renderedActiveWorktreeId) {
          dirty.add(renderedActiveWorktreeId)
        }
      }
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
      if (previous.startupTerminalTabHold !== startupTerminalTabHold) {
        if (previous.startupTerminalTabHold) {
          dirty.add(previous.startupTerminalTabHold.worktreeId)
        }
        if (startupTerminalTabHold) {
          dirty.add(startupTerminalTabHold.worktreeId)
        }
      }
      if (previous.activityTerminalPortals !== activityTerminalPortals) {
        for (const portal of [...previous.activityTerminalPortals, ...activityTerminalPortals]) {
          dirty.add(portal.worktreeId)
        }
      }
      if (previous.effectiveParkedTerminalWorktreeIds !== effectiveParkedTerminalWorktreeIds) {
        for (const id of previous.effectiveParkedTerminalWorktreeIds) {
          if (!effectiveParkedTerminalWorktreeIds.has(id)) {
            dirty.add(id)
          }
        }
        for (const id of effectiveParkedTerminalWorktreeIds) {
          if (!previous.effectiveParkedTerminalWorktreeIds.has(id)) {
            dirty.add(id)
          }
        }
      }
      if (previous.evictionExemptTerminalTabIds !== evictionExemptTerminalTabIds) {
        const state = useAppStore.getState()
        for (const tabId of new Set([
          ...previous.evictionExemptTerminalTabIds,
          ...evictionExemptTerminalTabIds
        ])) {
          if (
            previous.evictionExemptTerminalTabIds.has(tabId) ===
            evictionExemptTerminalTabIds.has(tabId)
          ) {
            continue
          }
          const id = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
          if (id) {
            dirty.add(id)
          }
        }
      }
      if (previous.anyMountedWorktreeHasLayout !== anyMountedWorktreeHasLayout) {
        for (const id of mountedWorktreeIdsRef.current) {
          dirty.add(id)
        }
      }
    }
    if (dirty.size === 0) {
      return
    }
    const syncEntriesByWorktreeId = new Map<string, ParkedTerminalTabWatcherSyncEntry>()
    for (const workspaceId of dirty) {
      if (!workspaceSurfaceIdSet.has(workspaceId)) {
        continue
      }
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
    controller,
    revision,
    takeChangedWorkspaces,
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
    workspaceSurfaceIdSet,
    workspaceSurfaceIds
  ])
  useEffect(() => () => disposeAllParkedTerminalWatchers(), [])

  useTerminalStartupActivation(controller)
}

import { useAppStore } from '../store'
import {
  canDeferColdActivationTabsForHost,
  canMountTerminalWorkspaceForStartup,
  planColdActivationTabDeferral,
  pruneClosedBackgroundMountTabs,
  revealActivationDeferredTabs
} from './terminal/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '../runtime/sync-runtime-graph'
import { anyMountedWorktreeHasLayout as computeAnyMountedWorktreeHasLayout } from './terminal/split-group-mount'
import { isParkRestorableTerminalPty } from './terminal-pane/terminal-hidden-view-parking'
import { canWatcherCoverParkedTerminalTab } from './terminal-pane/terminal-parked-tab-watchers'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { terminalProviderHasAuthoritativeSnapshot } from './terminal/terminal-provider-snapshot-capability'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

export function applyTerminalColdActivation(controller: TerminalParkingFoundation) {
  const {
    activationDeferredMountTabIdsByWorktreeRef,
    activeGroupIdByWorktree,
    activeTabId,
    activeTabIdByWorktree,
    activeWorktreeDeferralHostId,
    activityTerminalPortals,
    backgroundMountTabIdsByWorktreeRef,
    groupsByWorktree,
    hydrationSucceeded,
    lastActivationWorktreeIdRef,
    layoutByWorktree,
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    startupWorktreeRefreshCompleted,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaceIds,
    workspaceSurfaceIdSet
  } = controller
  if (
    renderedActiveWorktreeId &&
    canMountTerminalWorkspaceForStartup({
      workspaceSessionReady,
      hydrationSucceeded,
      startupWorktreeRefreshCompleted
    })
  ) {
    const worktreeTabs = tabsByWorktree[renderedActiveWorktreeId] ?? []
    const coldActivationDeferralEnabled =
      terminalParkingEnabled && terminalTitleSnapshotAuthorityEnabled
    const immediateTabIds = new Set<string>()
    if (activeTabId) {
      immediateTabIds.add(activeTabId)
    }
    const rememberedActiveTabId = activeTabIdByWorktree[renderedActiveWorktreeId]
    if (rememberedActiveTabId) {
      immediateTabIds.add(rememberedActiveTabId)
    }
    const unifiedTabById = new Map(
      (useAppStore.getState().unifiedTabsByWorktree[renderedActiveWorktreeId] ?? []).map(
        (unifiedTab) => [unifiedTab.id, unifiedTab]
      )
    )
    for (const group of groupsByWorktree[renderedActiveWorktreeId] ?? []) {
      if (!group.activeTabId) {
        continue
      }
      immediateTabIds.add(group.activeTabId)
      const activeUnifiedTab = unifiedTabById.get(group.activeTabId)
      if (activeUnifiedTab?.contentType === 'terminal') {
        immediateTabIds.add(activeUnifiedTab.entityId)
      }
    }
    for (const portal of activityTerminalPortals) {
      if (portal.worktreeId === renderedActiveWorktreeId) {
        immediateTabIds.add(portal.tabId)
      }
    }
    for (const tab of worktreeTabs) {
      if (pendingStartupByTabId[tab.id] !== undefined) {
        immediateTabIds.add(tab.id)
      }
    }
    const activationHostSupportsDeferral = canDeferColdActivationTabsForHost({
      executionHostId: activeWorktreeDeferralHostId,
      pairedRuntimeParkingEnvironmentIds
    })
    const isColdActivationPtyEligible = (ptyId: string): boolean =>
      isRemoteRuntimePtyId(ptyId)
        ? isParkRestorableTerminalPty(ptyId, renderedActiveWorktreeId, {
            pairedRuntimeParkingEnvironmentIds
          })
        : terminalProviderHasAuthoritativeSnapshot(ptyId)
    if (lastActivationWorktreeIdRef.current !== renderedActiveWorktreeId) {
      lastActivationWorktreeIdRef.current = renderedActiveWorktreeId
      const tabById = new Map(worktreeTabs.map((tab) => [tab.id, tab]))
      planColdActivationTabDeferral({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId: renderedActiveWorktreeId,
        allTabIds: worktreeTabs.map((tab) => tab.id),
        isTabLive: (tabId, worktreeId) => hasRegisteredRuntimeTerminalTab(tabId, worktreeId),
        // Why the coverage gate: parked byte watchers own an unmounted tab's bells/titles/completions, so a tab they can't cover must mount immediately.
        isTabDeferrable: (tabId) => {
          const tab = tabById.get(tabId)
          return (
            coldActivationDeferralEnabled &&
            activationHostSupportsDeferral &&
            tab !== undefined &&
            canWatcherCoverParkedTerminalTab(
              renderedActiveWorktreeId,
              tab,
              isColdActivationPtyEligible
            )
          )
        },
        immediateTabIds
      })
    } else if (!coldActivationDeferralEnabled || !activationHostSupportsDeferral) {
      backgroundMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
      activationDeferredMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
    } else {
      for (const tab of worktreeTabs) {
        if (
          !canWatcherCoverParkedTerminalTab(
            renderedActiveWorktreeId,
            tab,
            isColdActivationPtyEligible
          )
        ) {
          immediateTabIds.add(tab.id)
        }
      }
      revealActivationDeferredTabs({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId: renderedActiveWorktreeId,
        allTabIds: worktreeTabs.map((tab) => tab.id),
        immediateTabIds
      })
    }
    mountedWorktreeIdsRef.current.add(renderedActiveWorktreeId)
  } else {
    lastActivationWorktreeIdRef.current = null
  }
  pruneClosedBackgroundMountTabs(
    backgroundMountTabIdsByWorktreeRef.current,
    mountedWorktreeIdsRef.current,
    tabsByWorktree,
    activationDeferredMountTabIdsByWorktreeRef.current
  )
  for (const id of mountedWorktreeIdsRef.current) {
    if (!workspaceSurfaceIdSet.has(id)) {
      mountedWorktreeIdsRef.current.delete(id)
      backgroundMountTabIdsByWorktreeRef.current.delete(id)
      activationDeferredMountTabIdsByWorktreeRef.current.delete(id)
    }
  }
  const anyMountedWorktreeHasLayout = computeAnyMountedWorktreeHasLayout(
    workspaceSurfaceIds,
    mountedWorktreeIdsRef.current,
    layoutByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree
  )
  return { anyMountedWorktreeHasLayout }
}

export type TerminalColdActivationController = TerminalParkingFoundation &
  ReturnType<typeof applyTerminalColdActivation>

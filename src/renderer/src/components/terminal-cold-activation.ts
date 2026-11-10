import { useAppStore } from '../store'
import {
  canAdmitTerminalTabsForStartup,
  canDeferColdActivationTabsForHost,
  planColdActivationTabDeferral,
  pruneClosedBackgroundMountTabs,
  revealActivationDeferredTabs
} from './terminal/background-terminal-worktree-mount'
import {
  holdTerminalTabsForStartup,
  releaseStartupTerminalTabHold
} from './terminal/startup-terminal-tab-hold'
import { hasRegisteredRuntimeTerminalTab } from '../runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { anyMountedWorktreeHasLayout as computeAnyMountedWorktreeHasLayout } from './terminal/split-group-mount'
import { isParkRestorableTerminalPty } from './terminal-pane/parking/retention/terminal-hidden-view-parking'
import './terminal-pane/parking/output-watchers/terminal-parked-tab-watchers'
import { canWatcherCoverParkedTerminalTab } from './terminal-pane/parking/output-watchers/parked-terminal-tab-coverage'
import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { terminalProviderAllowsParking } from './terminal/terminal-provider-snapshot-capability'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'
import { isUnboundRestoredTerminalTab } from './terminal/unbound-restored-terminal-tab'

export function applyTerminalColdActivation(controller: TerminalParkingFoundation) {
  const {
    activationDeferralPlanRevisionRef,
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
    startupTerminalTabHoldRef,
    startupWorktreeRefreshCompleted,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaceIds,
    workspaceSurfaceIdSet
  } = controller
  // Mount hydrated non-terminal surfaces immediately; hold only terminals until startup publishes PTY ownership.
  const startupHeldWorktreeId =
    renderedActiveWorktreeId &&
    !canAdmitTerminalTabsForStartup({
      workspaceSessionReady,
      hydrationSucceeded,
      startupWorktreeRefreshCompleted
    })
      ? renderedActiveWorktreeId
      : null
  releaseStartupTerminalTabHold(
    startupTerminalTabHoldRef,
    backgroundMountTabIdsByWorktreeRef.current,
    mountedWorktreeIdsRef.current,
    startupHeldWorktreeId
  )
  if (renderedActiveWorktreeId && !startupHeldWorktreeId) {
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
    // Unbound saved tabs have no output to watch, so they wait regardless of parking support (#39166).
    const storeState = useAppStore.getState()
    const heldUnboundTabIds = new Set(
      worktreeTabs
        .filter(
          (tab) => !immediateTabIds.has(tab.id) && isUnboundRestoredTerminalTab(tab, storeState)
        )
        .map((tab) => tab.id)
    )
    const isColdActivationPtyEligible = (ptyId: string): boolean =>
      isRemoteRuntimePtyId(ptyId)
        ? isParkRestorableTerminalPty(ptyId, renderedActiveWorktreeId, {
            pairedRuntimeParkingEnvironmentIds
          })
        : terminalProviderAllowsParking(ptyId)
    if (lastActivationWorktreeIdRef.current !== renderedActiveWorktreeId) {
      lastActivationWorktreeIdRef.current = renderedActiveWorktreeId
      const tabById = new Map(worktreeTabs.map((tab) => [tab.id, tab]))
      const installedDeferralPlan = planColdActivationTabDeferral({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId: renderedActiveWorktreeId,
        allTabIds: worktreeTabs.map((tab) => tab.id),
        isTabLive: (tabId, worktreeId) => hasRegisteredRuntimeTerminalTab(tabId, worktreeId),
        // Why the coverage gate: parked byte watchers own an unmounted tab's bells/titles/completions, so a tab they can't cover must mount immediately.
        isTabDeferrable: (tabId) => {
          if (heldUnboundTabIds.has(tabId)) {
            return true
          }
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
      // Installing mutates refs only; advance a revision so the admission effect can drain the plan.
      if (installedDeferralPlan) {
        activationDeferralPlanRevisionRef.current += 1
      }
    } else if (
      (!coldActivationDeferralEnabled || !activationHostSupportsDeferral) &&
      heldUnboundTabIds.size === 0
    ) {
      backgroundMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
      activationDeferredMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
    } else {
      const parkingDeferralEnabled = coldActivationDeferralEnabled && activationHostSupportsDeferral
      for (const tab of worktreeTabs) {
        if (heldUnboundTabIds.has(tab.id)) {
          continue
        }
        if (
          !parkingDeferralEnabled ||
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
  if (startupHeldWorktreeId) {
    holdTerminalTabsForStartup(
      startupTerminalTabHoldRef,
      backgroundMountTabIdsByWorktreeRef.current,
      mountedWorktreeIdsRef.current,
      startupHeldWorktreeId,
      (tabsByWorktree[startupHeldWorktreeId] ?? []).map((tab) => tab.id)
    )
  }
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
  return {
    anyMountedWorktreeHasLayout,
    activationDeferralPlanRevision: activationDeferralPlanRevisionRef.current,
    startupTerminalTabHold: startupTerminalTabHoldRef.current
  }
}

export type TerminalColdActivationController = TerminalParkingFoundation &
  ReturnType<typeof applyTerminalColdActivation>

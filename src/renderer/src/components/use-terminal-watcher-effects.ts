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
import { gateWorktreeAgentActivation } from '@/lib/worktree-agent-activation-gate'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import { createWorkspaceTerminalHostAuthoritySelector } from '@/lib/workspace-terminal-host-authority'
import type { TerminalColdActivationController } from './terminal-cold-activation'

export function useTerminalWatcherEffects(controller: TerminalColdActivationController): void {
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
    pendingStartupByTabId,
    reconcileWorktreeTabModel,
    renderedActiveWorktreeId,
    tabsByWorktree,
    terminalParkingEnabled,
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
      const parkedTabIds = new Set<string>()
      let deferredTabIds: ReadonlySet<string> | null = null
      if (!anyMountedWorktreeHasLayout && mountedWorktreeIdsRef.current.has(workspaceId)) {
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
              parkedTabIds.add(tab.id)
            }
          }
        }
        deferredTabIds = activationDeferredMountTabIdsByWorktreeRef.current.get(workspaceId) ?? null
        for (const tab of tabs) {
          if (
            deferredTabIds?.has(tab.id) &&
            !parkedTabIds.has(tab.id) &&
            canWatcherCoverParkedTerminalTab(workspaceId, tab) &&
            !findActivityTerminalPortal(activityTerminalPortals, {
              worktreeId: workspaceId,
              tabId: tab.id
            })
          ) {
            parkedTabIds.add(tab.id)
          }
        }
      }
      syncEntriesByWorktreeId.set(workspaceId, {
        tabs,
        parkedTabIds,
        ...(deferredTabIds ? { restoreTitleOnStartTabIds: deferredTabIds } : {})
      })
    }
    syncParkedTerminalTabWatchersForWorkspaces(syncEntriesByWorktreeId)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
  }, [
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
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaceIds
  ])
  useEffect(() => () => disposeAllParkedTerminalWatchers(), [])

  const startupActivationGateWorktreeIdsRef = useRef(new Set<string>())
  // Why (main): a missing row means never initialized, an explicit empty row means the user
  // closed the last terminal — so the gate must not re-seed one in the second case.
  const activeWorktreeHasTerminalState = activeWorktreeId
    ? Object.hasOwn(tabsByWorktree, activeWorktreeId)
    : false
  // Why a store subscription rather than a read inside the effects: the verdict flips to `none` the
  // moment the execution host answers, and that transition is what re-runs the passes below.
  // Why the retained selector: resolution walks the owner catalogs, so recomputing it on every store
  // write would be the STA-3363 render-path multiplier again.
  const hostAuthoritySelector = useMemo(
    () => createWorkspaceTerminalHostAuthoritySelector(activeWorktreeId),
    [activeWorktreeId]
  )
  const activeWorktreeHostAuthority = useAppStore(hostAuthoritySelector)

  useEffect(() => {
    if (!workspaceSessionReady || !terminalStartupRestorationReady || !activeWorktreeId) {
      return
    }
    // Why: the execution host owns terminal creation, and a host that has not answered is not a host
    // with no terminals — seeding into that gap duplicates its tabs on every launch (STA-4658).
    if (activeWorktreeHostAuthority !== 'none') {
      return
    }
    if (startupActivationGateWorktreeIdsRef.current.has(activeWorktreeId)) {
      return
    }
    startupActivationGateWorktreeIdsRef.current.add(activeWorktreeId)
    let cancelled = false
    void gateWorktreeAgentActivation(activeWorktreeId).then((outcome) => {
      if (
        cancelled ||
        outcome !== 'empty' ||
        useAppStore.getState().activeWorktreeId !== activeWorktreeId
      ) {
        return
      }
      // Why: the activation gate reconciles durable/live agent state first; only an actually empty, never-visited workspace receives a default shell.
      const { renderableTabCount } = reconcileWorktreeTabModel(activeWorktreeId)
      if (shouldAutoCreateInitialTerminal(renderableTabCount, activeWorktreeHasTerminalState)) {
        // Why: tag this never-visited-worktree tab so its PTY spawn doesn't count as activity and reshuffle the sidebar (explicit New Tab still bumps).
        createTab(activeWorktreeId, undefined, undefined, { pendingActivationSpawn: true })
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    activeWorktreeId,
    activeWorktreeHasTerminalState,
    activeWorktreeHostAuthority,
    createTab,
    reconcileWorktreeTabModel,
    terminalStartupRestorationReady,
    workspaceSessionReady
  ])

  const startupResumeWorktreeIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!workspaceSessionReady || !hydrationSucceeded || !activeWorktreeId) {
      return
    }
    if (startupResumeWorktreeIdsRef.current.has(activeWorktreeId)) {
      return
    }
    // Why not consume the one-shot here: the sweep declines outright while the host is unanswered,
    // so marking it done would strand every sleeping agent on the workspace for the session.
    if (activeWorktreeHostAuthority === 'unverifiable') {
      return
    }
    startupResumeWorktreeIdsRef.current.add(activeWorktreeId)
    // Why: startup hydration restores the worktree without activateAndRevealWorktree, so orphaned live/quit records need a terminal-surface pass after cold restore.
    resumeSleepingAgentSessionsForWorktree(activeWorktreeId)
  }, [activeWorktreeId, activeWorktreeHostAuthority, hydrationSucceeded, workspaceSessionReady])
}

import { useEffect, useMemo, useRef } from 'react'
import { findActivityTerminalPortal } from './activity/activity-terminal-portal'
import {
  canWatcherCoverParkedTerminalTab,
  disposeAllParkedTerminalWatchers,
  pruneParkedTerminalWatchers,
  syncParkedTerminalTabWatchersForWorkspaces,
  terminalWatcherLiveWorkspaceIds,
  type ParkedTerminalTabWatcherSyncEntry
} from './terminal-pane/terminal-parked-tab-watchers'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import { createWorkspaceTerminalHostAuthoritySelector } from '@/lib/workspace-terminal-host-authority'
import type { TerminalColdActivationController } from './terminal-cold-activation'
import { recoverWorkspaceActivation } from '@/lib/worktree-activation-recovery'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { startWorkspaceActivationSurfaceProducer } from '@/lib/workspace-activation-surface-producer'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

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
  | 'effectiveParkedTerminalWorktreeIds'
  | 'evictionExemptTerminalTabIds'
  | 'getEffectiveLayoutForWorktree'
  | 'groupsByWorktree'
  | 'hydrationSucceeded'
  | 'measurableBackgroundWorktreeIdsRef'
  | 'mountedWorktreeIdsRef'
  | 'pairedRuntimeParkingEnvironmentIds'
  | 'pendingStartupByTabId'
  | 'renderedActiveWorktreeId'
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
    effectiveParkedTerminalWorktreeIds,
    evictionExemptTerminalTabIds,
    getEffectiveLayoutForWorktree,
    groupsByWorktree,
    hydrationSucceeded,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalProviderSnapshotCapabilityRevision,
    terminalSshParkingEnabled,
    terminalStartupRestorationReady,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaceIds
  } = controller
  const startupRecoveryTargetRef = useRef<string | null>(null)

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
        deferredTabIds = activationDeferredMountTabIdsByWorktreeRef.current.get(workspaceId) ?? null
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
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalProviderSnapshotCapabilityRevision,
    terminalSshParkingEnabled,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaceIds
  ])
  useEffect(() => () => disposeAllParkedTerminalWatchers(), [])

  // Why a store subscription rather than a read inside the effects: the verdict flips to `none` the
  // moment the execution host answers, and that transition is what re-runs the passes below.
  // Why the retained selector: resolution walks the owner catalogs, so recomputing it on every store
  // write would be the STA-3363 render-path multiplier again.
  const hostAuthoritySelector = useMemo(
    () => createWorkspaceTerminalHostAuthoritySelector(activeWorktreeId),
    [activeWorktreeId]
  )
  const activeWorktreeHostAuthority = useAppStore(hostAuthoritySelector)
  const activeWorkspaceExecutionHostId = useAppStore(
    (state) => state.activeWorkspaceExecutionHostId
  )
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const activeRuntimeRoute = useMemo(() => {
    const routeKey = `${activeWorkspaceExecutionHostId ?? ''}|${activeWorktreeHostAuthority}`
    if (!activeWorktreeId) {
      return { routeKey, revision: null }
    }
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
      useAppStore.getState(),
      activeWorktreeId
    )
    const environment = runtimeEnvironments.find(({ id }) => id === runtimeEnvironmentId)
    return {
      routeKey,
      revision: environment
        ? (environment.pairingRevision ?? environment.createdAt)
        : runtimeEnvironmentId
          ? (getRuntimeEnvironmentRevision(runtimeEnvironmentId) ?? null)
          : null
    }
  }, [
    activeWorkspaceExecutionHostId,
    activeWorktreeHostAuthority,
    activeWorktreeId,
    runtimeEnvironments
  ])

  useEffect(() => {
    if (!workspaceSessionReady || !terminalStartupRestorationReady) {
      startupRecoveryTargetRef.current = null
      return
    }
    if (!activeWorktreeId) {
      return
    }
    const state = useAppStore.getState()
    const identity = {
      workspaceKey: activeWorktreeId,
      executionHostId: getExecutionHostIdForWorktree(state, activeWorktreeId),
      runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId),
      attemptId: createBrowserUuid()
    }
    const target = JSON.stringify([
      identity.executionHostId,
      identity.runtimeEnvironmentId,
      activeRuntimeRoute.revision,
      activeWorktreeId,
      activeRuntimeRoute.routeKey
    ])
    if (startupRecoveryTargetRef.current === target) {
      return
    }
    startupRecoveryTargetRef.current = target
    const abort = new AbortController()
    startWorkspaceActivationSurfaceProducer(identity, { mode: 'startup' })
    void recoverWorkspaceActivation(identity, {
      mode: 'startup',
      signal: abort.signal
    }).catch(() => undefined)
    return () => {
      abort.abort()
    }
  }, [
    activeWorkspaceExecutionHostId,
    activeRuntimeRoute,
    activeWorktreeHostAuthority,
    activeWorktreeId,
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

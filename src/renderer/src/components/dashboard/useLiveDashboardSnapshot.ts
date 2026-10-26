import { watchSnapshotInputs } from './useDashboardPopoutBridge'
import { createDashboardChatProgramHolds } from './dashboard-chat-program-acquisition'
import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useStructuredChatTabNames } from '@/runtime/structured-chat-name-observation'
import type { DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'
import { useChatProgramFactsVersion } from '@/lib/host-chat-program-acquisition'
import { createWorktreeAgentRowsCache } from './worktree-agent-rows-cache'
import { selectAgentLaunchRouteView } from '@/lib/agent-launch-route-input'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

/** Build in-window snapshots from the store; pop-out windows instead receive the bridge’s serialized version of the same builder. */
export function useLiveDashboardSnapshot(): DashboardSnapshot {
  const rowsCacheRef = useRef<ReturnType<typeof createWorktreeAgentRowsCache>>(undefined!)
  rowsCacheRef.current ??= createWorktreeAgentRowsCache()
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const migrationUnsupportedByPtyId = useAppStore((s) => s.migrationUnsupportedByPtyId)
  const runtimeAgentOrchestrationByPaneKey = useAppStore(
    (s) => s.runtimeAgentOrchestrationByPaneKey
  )
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const acknowledgedAgentsByPaneKey = useAppStore((s) => s.acknowledgedAgentsByPaneKey)
  const hostedReviewCache = useAppStore((s) => s.hostedReviewCache)
  const prCache = useAppStore((s) => s.prCache)
  // Why: controls idle visibility and gates generated conversation names.
  const settings = useAppStore((s) => s.settings)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  // Watch every host-profile input like the pop-out bridge; an idle board has no later status event to repair stale byte routing.
  const detectedWorktreesByRepo = useAppStore((s) => selectDetectedWorktreesByRepo(s))
  // Folder workspace host resolution uses these slices instead of git-worktree rows.
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const projectGroups = useAppStore((s) => s.projectGroups)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshStateByEnvironment = useAppStore((s) => s.sshStateByEnvironment)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const restoredRuntimeHostIdByWorkspaceSessionKey = useAppStore(
    (s) => s.restoredRuntimeHostIdByWorkspaceSessionKey
  )
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeEnvironmentCatalogHydrated = useAppStore((s) => s.runtimeEnvironmentCatalogHydrated)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  const paneForegroundAgentByPaneKey = useAppStore((s) => s.paneForegroundAgentByPaneKey)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const remoteDetectedAgentIds = useAppStore((s) => s.remoteDetectedAgentIds)
  const runtimeDetectedAgentIds = useAppStore((s) => s.runtimeDetectedAgentIds)
  // Freshness can change buckets without map writes; the epoch invalidates stale-decay memos.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const chatNames = useStructuredChatTabNames()
  // Why: launch options read only this view, so any route input change rebuilds them.
  const launchRouteStore = useAppStore(selectAgentLaunchRouteView)
  useEffect(() => {
    const holds = createDashboardChatProgramHolds()
    const reconcile = (): void => holds.reconcile(useAppStore.getState())
    const stopWatching = watchSnapshotInputs(reconcile)
    reconcile()
    return () => {
      stopWatching()
      holds.release()
    }
  }, [])
  const chatProgramFactsVersion = useChatProgramFactsVersion()

  return useMemo(
    // Read the clock when the freshness epoch invalidates this memo, matching row derivation.
    () =>
      buildDashboardSnapshot(
        {
          chatNames,
          repos,
          worktreesByRepo,
          tabsByWorktree,
          unifiedTabsByWorktree,
          agentStatusByPaneKey,
          retainedAgentsByPaneKey,
          migrationUnsupportedByPtyId,
          runtimeAgentOrchestrationByPaneKey,
          terminalLayoutsByTabId,
          ptyIdsByTabId,
          runtimePaneTitlesByTabId,
          acknowledgedAgentsByPaneKey,
          hostedReviewCache,
          prCache,
          settings,
          workspaceStatuses,
          detectedWorktreesByRepo,
          folderWorkspaces,
          projectGroups,
          sshTargetLabels,
          sshConnectionStates,
          sshStateByEnvironment,
          runtimeStatusByEnvironmentId,
          restoredRuntimeHostIdByWorkspaceSessionKey,
          runtimeEnvironments,
          runtimeEnvironmentCatalogHydrated,
          removedRuntimeEnvironmentIds,
          paneForegroundAgentByPaneKey,
          detectedAgentIds,
          remoteDetectedAgentIds,
          runtimeDetectedAgentIds,
          // Read launch identity non-reactively because Shift+Enter routing does not depend on it; match the bridge gate.
          agentLaunchConfigByPaneKey: useAppStore.getState().agentLaunchConfigByPaneKey
        },
        Date.now(),
        // Reuse unchanged worktree rows while assembling cards fresh from current review/host/status slices.
        { rowsCache: rowsCacheRef.current, rowsGeneration: agentStatusEpoch, launchRouteStore }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      repos,
      worktreesByRepo,
      tabsByWorktree,
      unifiedTabsByWorktree,
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey,
      terminalLayoutsByTabId,
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      acknowledgedAgentsByPaneKey,
      hostedReviewCache,
      prCache,
      settings,
      workspaceStatuses,
      detectedWorktreesByRepo,
      folderWorkspaces,
      projectGroups,
      sshTargetLabels,
      sshConnectionStates,
      sshStateByEnvironment,
      runtimeStatusByEnvironmentId,
      restoredRuntimeHostIdByWorkspaceSessionKey,
      runtimeEnvironments,
      runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds,
      paneForegroundAgentByPaneKey,
      detectedAgentIds,
      remoteDetectedAgentIds,
      runtimeDetectedAgentIds,
      chatNames,
      chatProgramFactsVersion,
      launchRouteStore,
      agentStatusEpoch
    ]
  )
}

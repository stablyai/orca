import { useMemo, useRef } from 'react'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useAppStore } from '@/store/index'
import { useStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import type { DashboardSnapshot } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'
import { createDashboardSnapshotReuse } from './dashboard-snapshot-reuse'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

/** Build in-window snapshots from the store; pop-out windows instead receive the bridge’s serialized version of the same builder. */
export function useLiveDashboardSnapshot(): DashboardSnapshot {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const statusProjection = useAppStore((s) => s.agentStatusByPaneKey.projection)
  const statusCursor = useAppStore((s) => s.agentStatusByPaneKey.projection.changeCursor())
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
  const runtimeStatusByEnvironmentId = useRuntimeStatusByEnvironmentId()
  const restoredRuntimeHostIdByWorkspaceSessionKey = useAppStore(
    (s) => s.restoredRuntimeHostIdByWorkspaceSessionKey
  )
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeEnvironmentCatalogHydrated = useAppStore((s) => s.runtimeEnvironmentCatalogHydrated)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  const paneForegroundAgentByPaneKey = useAppStore((s) => s.paneForegroundAgentByPaneKey)
  // Freshness can change buckets without map writes; the epoch invalidates stale-decay memos.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const chatNames = useStructuredChatTabNames()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceExecutionHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)

  const reuse = useRef<ReturnType<typeof createDashboardSnapshotReuse>>(undefined!)
  reuse.current ??= createDashboardSnapshotReuse()

  return useMemo(
    // Read the clock when the freshness epoch invalidates this memo, matching row derivation.
    () =>
      buildDashboardSnapshot(
        {
          chatNames,
          activeWorktreeId,
          activeWorkspaceExecutionHostId,
          repos,
          worktreesByRepo,
          tabsByWorktree,
          unifiedTabsByWorktree,
          agentStatusByPaneKey: useAppStore.getState().agentStatusByPaneKey,
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
          // Read launch identity non-reactively because Shift+Enter routing does not depend on it; match the bridge gate.
          agentLaunchConfigByPaneKey: useAppStore.getState().agentLaunchConfigByPaneKey
        },
        Date.now(),
        { reuse: reuse.current }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      repos,
      worktreesByRepo,
      tabsByWorktree,
      unifiedTabsByWorktree,
      statusProjection,
      statusCursor,
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
      chatNames,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      agentStatusEpoch
    ]
  )
}

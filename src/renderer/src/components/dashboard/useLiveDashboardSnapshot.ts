import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'

/**
 * Builds the dashboard snapshot directly from the live renderer store for the
 * in-window screen popover. The pop-out window can't read this store, so it
 * relays a serialized snapshot instead (useDashboardSnapshot); in-window there
 * is no relay, so we derive it here from the same builder the bridge uses.
 */
export function useLiveDashboardSnapshot(): DashboardSnapshot {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
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
  // Why: each card carries the host-input profile its preview terminal keys
  // against, so the drawer must watch every slice that resolves an execution
  // host — exactly the set useDashboardPopoutBridge republishes on. Agent
  // activity alone cannot heal these: a board whose agents are idle never
  // rebuilds, so an SSH handshake or host swap would leave the preview encoding
  // bytes for the host the pty used to run on. All are low-frequency (each
  // writer bails out when nothing changed) next to agentStatusByPaneKey, which
  // already rebuilds this memo on every status ping.
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  // Why: a folder workspace is not a git worktree — its host resolves through
  // these two instead of worktreesByRepo.
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
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
  // Why: freshness can flip a bucket without any backing map changing; the epoch
  // ticks on the freshness boundary so the memo re-derives stale-decayed cards.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  return useMemo(
    // Why: Date.now() is read inside the memo (not a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks, matching useDashboardData.
    () =>
      buildDashboardSnapshot(
        {
          repos,
          worktreesByRepo,
          tabsByWorktree,
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
          // Why: read non-reactively — resolveWindowsShiftEnterEncoding takes
          // launch identity but never routes on it, so subscribing would only
          // rebuild the board. Matches the bridge's republish gate.
          agentLaunchConfigByPaneKey: useAppStore.getState().agentLaunchConfigByPaneKey
        },
        Date.now()
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      repos,
      worktreesByRepo,
      tabsByWorktree,
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
      agentStatusEpoch
    ]
  )
}

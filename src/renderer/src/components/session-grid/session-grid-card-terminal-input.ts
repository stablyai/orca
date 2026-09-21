import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { readDashboardClientHost } from '@/components/dashboard/dashboard-client-host'
import { resolveDashboardCardTerminalInput } from '@/components/dashboard/dashboard-card-terminal-input'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import type { SessionGridItem } from '../../../../shared/session-grid-types'

/** Resolved per card, not in the grid's item memo: the resolver reads a dozen slices that memo must not rerun every card on. */
export function useSessionGridCardTerminalInput(
  item: SessionGridItem
): DashboardCardTerminalInput | null {
  const { ptyId, paneKey, worktreeId, cwd, shellOverride, launchAgent } = item
  const state = useAppStore(
    useShallow((s) => ({
      repos: s.repos,
      worktreesByRepo: s.worktreesByRepo,
      detectedWorktreesByRepo: s.detectedWorktreesByRepo,
      folderWorkspaces: s.folderWorkspaces,
      projectGroups: s.projectGroups,
      settings: s.settings,
      sshConnectionStates: s.sshConnectionStates,
      sshStateByEnvironment: s.sshStateByEnvironment,
      runtimeStatusByEnvironmentId: s.runtimeStatusByEnvironmentId,
      restoredRuntimeHostIdByWorkspaceSessionKey: s.restoredRuntimeHostIdByWorkspaceSessionKey,
      runtimeEnvironments: s.runtimeEnvironments,
      runtimeEnvironmentCatalogHydrated: s.runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds: s.removedRuntimeEnvironmentIds,
      foregroundAgent: paneKey ? s.paneForegroundAgentByPaneKey[paneKey] : undefined,
      agentStatus: paneKey ? s.agentStatusByPaneKey[paneKey] : undefined,
      launchConfig: paneKey ? s.agentLaunchConfigByPaneKey[paneKey] : undefined
    }))
  )

  return useMemo(() => {
    if (!ptyId || !paneKey) {
      return null
    }
    const clientHost = readDashboardClientHost()
    return resolveDashboardCardTerminalInput(
      {
        ...state,
        paneForegroundAgentByPaneKey: state.foregroundAgent
          ? { [paneKey]: state.foregroundAgent }
          : {},
        agentStatusByPaneKey: state.agentStatus ? { [paneKey]: state.agentStatus } : {},
        agentLaunchConfigByPaneKey: state.launchConfig ? { [paneKey]: state.launchConfig } : {}
      },
      {
        ptyId,
        worktreeId,
        paneKey,
        cwd,
        shellOverride,
        launchAgent,
        clientPlatform: clientHost.platform,
        userAgent: clientHost.userAgent,
        osRelease: clientHost.osRelease
      }
    )
  }, [state, ptyId, paneKey, worktreeId, cwd, shellOverride, launchAgent])
}

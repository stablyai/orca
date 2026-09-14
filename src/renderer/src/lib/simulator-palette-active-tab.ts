import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TabGroup, WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { isPaletteCurrentWorktree } from './palette-repo-resolution'

export function getActiveSimulatorTabId({
  worktreeId,
  worktreeHostId,
  worktreeRuntimeOwnerEnvironmentId,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  activeGroupId,
  groups
}: {
  worktreeId: string
  worktreeHostId?: Worktree['hostId']
  worktreeRuntimeOwnerEnvironmentId?: Worktree['runtimeOwnerEnvironmentId']
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeTabType: WorkspaceVisibleTabType
  activeGroupId?: string
  groups?: readonly TabGroup[]
}): string | null {
  if (
    !isPaletteCurrentWorktree(
      {
        id: worktreeId,
        hostId: worktreeHostId,
        runtimeOwnerEnvironmentId: worktreeRuntimeOwnerEnvironmentId
      },
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    ) ||
    activeTabType !== 'simulator'
  ) {
    return null
  }
  return activeGroupId
    ? (groups?.find((group) => group.id === activeGroupId)?.activeTabId ?? null)
    : null
}

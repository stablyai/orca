import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  FolderWorkspace,
  GlobalSettings,
  PinnedTerminalPanel,
  ProjectGroup,
  Repo,
  Worktree
} from '../../../shared/types'

export type WorktreeRuntimeOwnerState = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  settings?:
    | (Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> & {
        pinnedTerminalPanels?: readonly PinnedTerminalPanel[]
      })
    | null
  /** Hydrated SSH target id->label map; panel host resolution. */
  sshTargetLabels?: ReadonlyMap<string, string>
  worktreesByRepo?: Record<
    string,
    readonly Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>[]
  >
  detectedWorktreesByRepo?: Record<
    string,
    {
      worktrees: readonly Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>[]
    }
  >
  folderWorkspaces?: readonly Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'connectionId'>[]
  projectGroups?: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
  runtimeEnvironments?: readonly { id: string }[]
  runtimeEnvironmentCatalogHydrated?: boolean
  removedRuntimeEnvironmentIds?: ReadonlySet<string>
}

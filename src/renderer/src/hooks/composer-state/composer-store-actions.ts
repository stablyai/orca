import type { UISlice } from '../../store/slices/ui'
import type { RepoUpdate } from '../../store/repos/repo-state'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type ComposerStoreActions = {
  setNewWorkspaceDraft: (draft: NonNullable<UISlice['newWorkspaceDraft']>) => void
  clearNewWorkspaceDraft: () => void
  updateRepo: (
    projectId: string,
    updates: RepoUpdate,
    options?: { hostId?: ExecutionHostId }
  ) => Promise<boolean>
  createFolderWorkspace: (
    args: {
      projectGroupId: string
      name?: string
      folderPath?: string | null
      connectionId?: string | null
      linkedTask?: FolderWorkspace['linkedTask']
      linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
      createdWithAgent?: FolderWorkspace['createdWithAgent']
      pendingFirstAgentMessageRename?: boolean
    },
    options?: { runtimeEnvironmentId?: string | null }
  ) => Promise<FolderWorkspace | null>
  closeModal: () => void
  openSettingsPage: () => void
  openSettingsTarget: (target: NonNullable<UISlice['settingsNavigationTarget']>) => void
  setActiveRuntimeEnvironmentPreference: (environmentId: string | null) => Promise<boolean>
  prefetchWorktreeCreateBase: (repoId: string, baseBranch?: string) => Promise<void>
  prefetchWorkItems: (
    repoId: string,
    repoPath: string,
    limit?: number,
    query?: string,
    options?: { sourceContext?: TaskSourceContext | null }
  ) => void
  fetchSparsePresets: (repoId: string) => Promise<void>
}

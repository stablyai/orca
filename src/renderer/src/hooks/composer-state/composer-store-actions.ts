import type { RepoSlice, RepoUpdate } from '../../store/repos/repo-state'
import type { UISlice } from '../../store/slices/ui/ui-slice-contract'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'

export type ComposerStoreActions = {
  setNewWorkspaceDraft: (draft: NonNullable<UISlice['newWorkspaceDraft']>) => void
  clearNewWorkspaceDraft: () => void
  updateRepo: (
    projectId: string,
    updates: RepoUpdate,
    options?: { hostId?: ExecutionHostId }
  ) => Promise<boolean>
  createFolderWorkspace: RepoSlice['createFolderWorkspace']
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

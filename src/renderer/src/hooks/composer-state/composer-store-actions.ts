import type { UISlice } from '../../store/slices/ui'
import type {
  CreateSparseCheckoutRequest,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  SetupDecision
} from '../../../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type {
  WorkspaceLinkedItem,
  GitPushTarget,
  WorkspaceStatus
} from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { RepoUpdate } from '../../store/repos/repo-state'
import type { WorktreeMetaUpdateOptions } from '../../store/slices/worktree-helpers'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../shared/workspace-source'

export type ComposerStoreActions = {
  setNewWorkspaceDraft: (draft: NonNullable<UISlice['newWorkspaceDraft']>) => void
  clearNewWorkspaceDraft: () => void
  createWorktree: (
    repoId: string,
    name: string,
    baseBranch?: string,
    setupDecision?: SetupDecision,
    sparseCheckout?: CreateSparseCheckoutRequest,
    telemetrySource?: WorkspaceCreateTelemetrySource,
    displayName?: string,
    linkedIssue?: number,
    linkedPR?: number,
    pushTarget?: GitPushTarget,
    createdWithAgent?: TuiAgent,
    linkedLinearIssue?: string,
    branchNameOverride?: string,
    workspaceStatus?: WorkspaceStatus,
    linkedGitLabMR?: number,
    linkedGitLabIssue?: number,
    startup?: WorktreeStartupLaunch,
    pendingFirstAgentMessageRename?: boolean,
    creationId?: string,
    linkedLinearIssueWorkspaceId?: string | null,
    linkedLinearIssueOrganizationUrlKey?: string | null,
    linkedBitbucketPR?: number | null,
    linkedAzureDevOpsPR?: number | null,
    linkedGiteaPR?: number | null,
    compareBaseRef?: string,
    options?: {
      automationProvenanceRequest?: CreateWorktreeArgs['automationProvenanceRequest']
      linkedWorkItem?: WorkspaceLinkedItem | null
      linkedTaskSourceContext?: TaskSourceContext | null
      startupDraft?: string
      nameWasGenerated?: boolean
      provisionedRoot?: {
        runtimeId: string
        executionHostId: ExecutionHostId
        expectedPath: string
      }
    }
  ) => Promise<CreateWorktreeResult>
  updateRepo: (
    projectId: string,
    updates: RepoUpdate,
    options?: { hostId?: ExecutionHostId }
  ) => Promise<boolean>
  updateWorktreeMeta: (
    worktreeId: string,
    updates: Partial<WorktreeMeta>,
    options?: WorktreeMetaUpdateOptions
  ) => Promise<{ ok: true } | { ok: false; error: string }>
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
  setSidebarOpen: (open: boolean) => void
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

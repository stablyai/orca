import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/SmartWorkspaceNameField'
export type ComposerSourceModel = {
  addComposerAttachments: (paths: string[]) => void
  applyLinkedGitLabWorkItem: (item: GitLabWorkItem) => void
  applyLinkedWorkItem: (
    item: GitHubWorkItem,
    options?: { preserveBranchNameOverride?: boolean | undefined }
  ) => void
  applyLocalComposerDrop: (paths: string[], canApply?: () => boolean) => Promise<void>
  applyWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => Promise<void>
  canPrefetchSelectedRepoWorkItems: boolean
  folderCreateDisabled: boolean
  handleAddAttachment: () => Promise<void>
  handleBaseBranchChange: (next: string | undefined) => void
  handleBaseBranchMrSelect: (
    nextBaseBranch: string,
    item: GitLabWorkItem,
    nextPushTarget?: GitPushTarget | undefined,
    nextCompareBaseRef?: string | undefined
  ) => void
  handleBaseBranchPrSelect: (
    nextBaseBranch: string,
    item: GitHubWorkItem,
    nextPushTarget?: GitPushTarget | undefined,
    nextBranchNameOverride?: string | undefined,
    nextCompareBaseRef?: string | undefined
  ) => void
  handleBranchNameOverrideChange: (value: string | undefined) => void
  handleClearSmartNameSelection: () => void
  handleFolderSourceRepoChange: (value: string) => void
  handleLinkPopoverChange: (open: boolean) => void
  handleNameValueChange: (nextName: string) => void
  handleOpenAgentSettings: () => void
  handleOpenJiraSettings: () => void
  handleProjectChange: (projectId: string) => void
  handleProjectHostSetupChange: (setupId: string) => void
  handleRemoveLinkedWorkItem: () => void
  handleRepoChange: (
    value: string,
    options?: { preserveStartFrom?: boolean | undefined; forceResetStartFrom?: boolean | undefined }
  ) => void
  handleReuseSelectedBranchChange: (next: boolean) => void
  handleSelectLinkedItem: (item: GitHubWorkItem) => void
  handleSmartBranchSelect: (refName: string, localBranchName: string) => void
  handleSmartGitHubItemSelect: (item: GitHubWorkItem) => void
  handleSmartGitLabItemSelect: (item: GitLabWorkItem) => void
  handleSmartJiraIssueSelect: (issue: JiraIssue, sourceContext: TaskSourceContext) => void
  handleSmartLinearIssueSelect: (issue: LinearIssue) => void
  handleSparseSelectPreset: (preset: SparsePreset | null) => void
  insertComposerFolderPaths: (folderPaths: string[]) => void
  onConnectSelectedProjectGroup: () => Promise<void>
  onConnectSelectedRepo: () => Promise<void>
  prefetchSshConnectedGeneration: number
  resolvePendingSmartGitHubSubmit: () => Promise<PendingSmartGitHubSubmitResolution>
  selectAddedProjectRepo: (nextRepoId: string) => void
  showProjectRequiredError: () => void
  smartNameSelection: SmartWorkspaceNameSelection | null
  uploadComposerPaths: (
    sourcePaths: string[],
    targetSettings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
    targetConnectionId?: string | null,
    targetRepoPath?: string | null,
    canReportFailure?: () => boolean
  ) => Promise<{ filePaths: string[]; folderPaths: string[] } | null>
}

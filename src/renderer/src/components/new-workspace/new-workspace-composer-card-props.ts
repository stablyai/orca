import type RepoCombobox from '@/components/repo/RepoCombobox'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type {
  NeedsSetupProjectHostOption,
  ProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { SetupConfig } from '@/lib/new-workspace'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'
import type { SmartNameMode } from '@/components/new-workspace/smart-workspace-source-results'
import type SmartWorkspaceNameField from '@/components/new-workspace/SmartWorkspaceNameField'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/SmartWorkspaceNameField'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { OrcaHooks, SetupAgentStartupPolicy } from '../../../../shared/orca-yaml-hook-types'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type RepoOption = React.ComponentProps<typeof RepoCombobox>['repos'][number]
export type EphemeralVmRecipeOption = NonNullable<OrcaHooks['environmentRecipes']>[number]

export const EMPTY_PROJECT_OPTIONS: NewWorkspaceProjectOption[] = []
export const EMPTY_PROJECT_HOST_SETUP_OPTIONS: ProjectHostSetupOption[] = []
export const EMPTY_EPHEMERAL_VM_RECIPES: EphemeralVmRecipeOption[] = []

export type NewWorkspaceComposerCardProps = {
  contextualTourSource?: string
  containerClassName?: string
  composerRef?: React.RefObject<HTMLDivElement | null>
  onComposerNodeChange?: (node: HTMLDivElement | null) => void
  nameInputRef?: React.RefObject<HTMLInputElement | null>
  quickAgent: TuiAgent | null
  onQuickAgentChange: (agent: TuiAgent | null) => void
  eligibleRepos: readonly RepoOption[]
  repoId: string
  projectOptions?: NewWorkspaceProjectOption[]
  selectedProjectId?: string | null
  selectedRepoIsGit: boolean
  onRepoChange: (value: string) => void
  onProjectChange: (value: string) => void
  projectHostSetupOptions?: ProjectHostSetupOption[]
  selectedProjectHostSetupId?: string | null
  onProjectHostSetupChange?: (setupId: string) => void
  ephemeralVmRecipes?: EphemeralVmRecipeOption[]
  selectedEphemeralVmRecipeId?: string | null
  onEphemeralVmRecipeChange?: (recipeId: string | null) => void
  ephemeralVmRecipeError?: string | null
  repoBackedSearchRepos?: readonly RepoOption[]
  repoBackedSourcesDisabled?: boolean
  allowSmartNameAddProject?: boolean
  smartNameRepoSwitchTarget?: 'project' | 'task-source'
  primaryActionLabel: string
  projectLabel?: string
  projectPlaceholder?: string
  emptyProjectMessage?: string
  showAddProjectButton?: boolean
  name: string
  onNameValueChange: (value: string) => void
  branchNameOverride: string | undefined
  onBranchNameOverrideChange: (value: string | undefined) => void
  parentWorktreeId?: string | null
  onParentWorktreeIdChange?: (value: string | null) => void
  selectedRepoExecutionHostId?: ExecutionHostId | null
  selectedRepoProjectId?: string | null
  activeFolderWorkspaceId?: string | null
  onSmartGitHubItemSelect: (item: GitHubWorkItem) => void
  onSmartGitLabItemSelect: (item: GitLabWorkItem) => void
  onSmartBranchSelect: (refName: string, localBranchName: string) => void
  onSmartNameModeChange?: (mode: SmartNameMode) => void
  onSmartLinearIssueSelect: (issue: LinearIssue) => void
  onSmartJiraIssueSelect?: (issue: JiraIssue, sourceContext: TaskSourceContext) => void
  onOpenJiraSettings?: () => void
  smartNameSelection: SmartWorkspaceNameSelection | null
  onClearSmartNameSelection: () => void
  canReuseSelectedBranch: boolean
  reuseSelectedBranch: boolean
  onReuseSelectedBranchChange: (next: boolean) => void
  showCreateMultiple?: boolean
  createMultiple?: boolean
  onCreateMultipleChange?: (next: boolean) => void
  smartNameGitHubSourceContext?: TaskSourceContext | null
  smartNameJiraSourceContext?: TaskSourceContext | null
  forkPushWarning: string | null
  detectedAgentIds: Set<TuiAgent> | null
  onOpenAgentSettings: () => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
  createDisabled: boolean
  projectError: string | null
  creating: boolean
  onCreate: () => void
  note: string
  onNoteChange: (value: string) => void
  setupConfig: SetupConfig | null
  requiresExplicitSetupChoice: boolean
  setupDecision: 'run' | 'skip' | null
  onSetupDecisionChange: (value: 'run' | 'skip') => void
  setupAgentStartupPolicy: SetupAgentStartupPolicy
  onSetupAgentStartupPolicyChange: (value: SetupAgentStartupPolicy) => void
  shouldWaitForSetupCheck: boolean
  resolvedSetupDecision: 'run' | 'skip' | null
  createError: WorkspaceCreateErrorDisplay | null
  selectedRepoConnectionId: string | null
  selectedRepoSshStatus: SshConnectionStatus | null
  selectedRepoRequiresConnection: boolean
  selectedRepoConnectInProgress: boolean
  onConnectSelectedRepo: () => Promise<void>
  branchesEnabled?: boolean
  setupControlsEnabled?: boolean
  canUseSparseCheckout: boolean
  sparsePresets: SparsePreset[]
  sparseSelectedPresetId: string | null
  onSparseSelectPreset: (preset: SparsePreset | null) => void
  sparseControlsEnabled?: boolean
  onAddProjectOverride?: () => void
  onNestedDialogOpenChange?: (open: boolean) => void
}

export type NeedsProjectHostOption = NeedsSetupProjectHostOption
export type ReadyProjectHostOption = Extract<ProjectHostSetupOption, { kind: 'ready' }>
export type SmartWorkspaceNameFieldProps = React.ComponentProps<typeof SmartWorkspaceNameField>

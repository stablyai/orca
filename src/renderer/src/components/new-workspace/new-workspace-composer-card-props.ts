import type { AgentComboboxSurfaceRows } from '@/components/agent/agent-combobox-surface-items'
import type { ComposerAgentEntry } from '@/hooks/composer-state/composer-agent-entries'
import type { ComposerAgentRows } from '@/hooks/composer-state/composer-agent-rows-target'
import type RepoCombobox from '@/components/repo/RepoCombobox'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type {
  NeedsSetupProjectHostOption,
  ProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { SetupConfig } from '../../../../shared/orca-hook-setup-config'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'
import type SmartWorkspaceNameField from './SmartWorkspaceNameField'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/smart-workspace-name-field-model'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
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
/** Guardrail, not a limit users hit: eight rows suffice for every supported harness combination. */
export const MAX_COMPOSER_AGENT_ROWS = 8

export type NewWorkspaceComposerCardProps = {
  contextualTourSource?: string
  containerClassName?: string
  contentClassName?: string
  selectedRepoPath?: string | null
  onNativeFileDrop?: (paths: string[], isCurrent: () => boolean) => Promise<void>
  composerRef?: React.RefObject<HTMLDivElement | null>
  onComposerNodeChange?: (node: HTMLDivElement | null) => void
  nameInputRef?: React.RefObject<HTMLInputElement | null>
  /** Row 0's agent pick and the "Blank Terminal" representation; detection may resolve it late. */
  quickAgent: TuiAgent | null
  agentSurfaceRows?: AgentComboboxSurfaceRows
  onQuickAgentChange: (
    agent: TuiAgent | null,
    surface?: AgentComboboxSurfaceRows['surface']
  ) => void
  /** Ordered agent rows of the multi-agent composer; omitted keeps the legacy single-agent picker. */
  agentEntries?: ComposerAgentEntry[]
  /** Replaces one row's draft or display name; the row id keeps repeated harnesses distinct. */
  onAgentEntryChange?: (id: string, patch: Partial<ComposerAgentEntry>) => void
  onAddAgentEntry?: () => void
  onRemoveAgentEntry?: (id: string) => void
  /** Folder, provisioned-root and ephemeral-VM targets collapse the list to row 0 with a notice. */
  agentEntriesLocked?: boolean
  /** Where the quick agent would start; null keeps the picker's plain agent list. */
  agentRows?: ComposerAgentRows | null
  /** Cleared picker: skip the agent and the extra shell when setup runs. */
  quickSetupOnly?: boolean
  onQuickSetupOnlySelect?: () => void
  eligibleRepos: readonly RepoOption[]
  selectedRepo?: RepoOption | null
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
  baseBranch?: string
  onBaseBranchChange?: (value: string | undefined) => void
  startFromResetHint?: string | null
  parentWorktreeId?: string | null
  onParentWorktreeIdChange?: (value: string | null) => void
  selectedRepoExecutionHostId?: ExecutionHostId | null
  selectedRepoProjectId?: string | null
  activeFolderWorkspaceId?: string | null
  onSmartGitHubItemSelect: (item: GitHubWorkItem) => void
  onSmartGitLabItemSelect: (item: GitLabWorkItem) => void
  onSmartBranchSelect: (refName: string, localBranchName: string) => void
  onSmartNameModeChange?: (mode: SmartNameMode) => void
  smartNameMode?: SmartNameMode
  onSmartLinearIssueSelect: (issue: LinearIssue) => void
  onSmartJiraIssueSelect?: (issue: JiraIssue, sourceContext: TaskSourceContext) => void
  onOpenJiraSettings?: () => void
  smartNameSelection: SmartWorkspaceNameSelection | null
  onClearSmartNameSelection: () => void
  reuseEligibleBranch?: string | null
  canReuseSelectedBranch: boolean
  reuseSelectedBranch: boolean
  onReuseSelectedBranchChange: (next: boolean) => void
  onOpenSelectedBranchWorkspace?: () => void
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

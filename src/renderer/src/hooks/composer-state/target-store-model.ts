import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { UISlice } from '../../store/slices/ui'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/worktree/types'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host-registry'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { ComposerDecisions } from './composer-decisions'
import type { ComposerStoreActions } from './composer-store-actions'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../store/slices/runtime-status'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { WorkspaceHostScope } from '../../../../shared/ui-chrome-types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../shared/workspace-source'

export type ComposerTargetStoreModel = {
  initialRepoId: string | undefined
  initialEphemeralVmRecipeId: string | undefined
  initialName: string
  initialPrompt: string
  initialLinkedWorkItem: LinkedWorkItemSummary | null
  initialGitHubWorkItem: GitHubWorkItem | null
  initialTaskSourceContext: TaskSourceContext | null
  initialWorkspaceStatus: WorkspaceStatus | undefined
  initialBaseBranch: string | undefined
  persistDraft: boolean
  onCreated: (() => void) | undefined
  isSubmissionCancelled: () => boolean
  repoIdOverride: string | undefined
  onRepoIdOverrideChange: ((value: string) => void) | undefined
  telemetrySource: WorkspaceCreateTelemetrySource | undefined
  enableIssueAutomation: boolean
  createGateMode: 'full' | 'quick'
  initialProjectGroupId: string | undefined
  decisions: ComposerDecisions
  actions: ComposerStoreActions
  setNewWorkspaceDraft: ComposerStoreActions['setNewWorkspaceDraft']
  clearNewWorkspaceDraft: ComposerStoreActions['clearNewWorkspaceDraft']
  createWorktree: ComposerStoreActions['createWorktree']
  updateRepo: ComposerStoreActions['updateRepo']
  updateWorktreeMeta: ComposerStoreActions['updateWorktreeMeta']
  createFolderWorkspace: ComposerStoreActions['createFolderWorkspace']
  setSidebarOpen: ComposerStoreActions['setSidebarOpen']
  closeModal: ComposerStoreActions['closeModal']
  openSettingsPage: ComposerStoreActions['openSettingsPage']
  openSettingsTarget: ComposerStoreActions['openSettingsTarget']
  setActiveRuntimeEnvironmentPreference: ComposerStoreActions['setActiveRuntimeEnvironmentPreference']
  prefetchWorktreeCreateBase: ComposerStoreActions['prefetchWorktreeCreateBase']
  prefetchWorkItems: ComposerStoreActions['prefetchWorkItems']
  fetchSparsePresets: ComposerStoreActions['fetchSparsePresets']
  repos: readonly Repo[]
  projects: readonly Project[]
  projectGroups: readonly ProjectGroup[]
  projectHostSetups: readonly ProjectHostSetup[]
  activeRepoId: string | null
  settings: GlobalSettings | null
  newWorkspaceDraft: UISlice['newWorkspaceDraft']
  worktreesByRepo: Record<string, Worktree[]>
  sparsePresetsByRepo: Record<string, SparsePreset[]>
  workspaceStatuses: WorkspaceStatusDefinition[]
  sshConnectionStates: Map<string, SshConnectionState>
  sshTargetLabels: Map<string, string>
  sshConnectedGeneration: number
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
  runtimeStatusByEnvironmentId: Map<string, RuntimeEnvironmentStatus>
  workspaceHostScope: WorkspaceHostScope
  eligibleRepos: Repo[]
  hostOptions: ExecutionHostRegistryEntry[]
  actionableHostIds: Set<ExecutionHostId>
  seedActiveRepoId: string | null
}

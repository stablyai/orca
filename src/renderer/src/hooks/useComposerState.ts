/* eslint-disable max-lines -- Why: co-locates all NewWorkspaceComposerCard state so the full-page composer and quick-composer modal share one source of truth. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: composer state synchronizes selected repo metadata, setup policy, issue-command hooks, and provider link lookups from async runtime IPC. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getDefaultRepoHookSettings } from '../../../shared/constants'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  parseGitHubIssueOrPRNumber,
  parseGitHubIssueOrPRLink,
  normalizeGitHubLinkQuery
} from '@/lib/github-links'
import { activateAndRevealWorktree, type AgentStartedTelemetry } from '@/lib/worktree-activation'
import { runBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { filterEnabledTuiAgents, isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { resolveNativeChatSessionOptionDefaults } from '../../../shared/native-chat-session-option-defaults'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { resolveWorktreeCreateBaseBranch } from '@/runtime/worktree-create-base'
import {
  buildTaskSourceContextFromRepo,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type {
  GitHubRepositoryIdentity,
  GitHubWorkItem,
  GitHubPrStartPoint,
  GitPushTarget,
  GitLabWorkItem,
  LinearIssue,
  OrcaHooks,
  RepoHookSettings,
  SetupAgentStartupPolicy,
  SetupDecision,
  SetupRunPolicy,
  SparsePreset,
  TuiAgent,
  WorktreeMeta,
  WorkspaceStatus,
  WorkspaceCreateTelemetrySource,
  ProjectGroup
} from '../../../shared/types'
import { githubRepoIdentityKey } from '../../../shared/github-repository-identity-key'
import { isWorkspaceStatusId } from '../../../shared/workspace-statuses'
import {
  CLIENT_PLATFORM,
  DEFAULT_ISSUE_COMMAND_TEMPLATE,
  buildAgentPromptWithContext,
  ensureAgentStartupInTerminal,
  getAttachmentLabel,
  getLinkedWorkItemProvider,
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName,
  getSetupConfig,
  getWorkspaceSeedName,
  isGitLabIssueUrl,
  PER_REPO_FETCH_LIMIT,
  renderIssueCommandTemplate,
  type LinkedWorkItemSummary,
  type SetupConfig
} from '@/lib/new-workspace'
import {
  getLinkedWorkItemPromptContext,
  resolveQuickCreateLinkedWorkItemPrompt
} from '@/lib/linked-work-item-context'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import {
  buildLinearIssueLinkedWorkItem,
  getLinearLinkedWorkItemBranchName,
  isLinearLinkedWorkItem
} from '@/lib/linear-linked-work-item'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import {
  getFullComposerCreateDisabled,
  getQuickComposerCreateDisabled
} from '@/lib/new-workspace-create-gates'
import {
  lookupSmartGitHubSubmitItem,
  getSmartGitHubSubmitIntent,
  getSmartGitHubSubmitResolution,
  type SmartGitHubSubmitResolution
} from '@/lib/smart-github-submit'
import {
  lookupGitHubWorkItemByOwnerRepoForSource,
  lookupGitHubWorkItemForSource
} from '@/lib/github-work-item-source-lookup'
import {
  resolveGitHubWorkItemIdentity,
  type GitHubWorkItemIdentity
} from '@/lib/github-work-item-identity'
import { resolveGitHubPrStartPointForRepo } from '@/lib/github-pr-start-point'
import { isWorkItemLookupText } from '@/lib/work-item-lookup-text'
import {
  canUseRepoBackedComposerSources,
  getSelectedRepoSshGate,
  isSshConnectInProgress
} from '@/lib/new-workspace-ssh-gate'
import {
  getComposerEligibleRepos,
  resolveComposerActiveRepoId
} from '@/lib/new-workspace-composer-repo'
import {
  resolveWorkspaceCreationRepoId,
  resolveWorkspaceCreationTarget
} from '@/lib/project-host-workspace-target'
import {
  buildProjectHostSetupOptions,
  type ProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import {
  buildNewWorkspaceCreateTargetOptions,
  getProjectGroupIdFromNewWorkspaceOptionId,
  type NewWorkspaceProjectOption
} from '@/lib/new-workspace-project-options'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import {
  getFolderSourceRepos,
  getLinkedItemDisplayName,
  getSmartNameSelection as getFolderSmartNameSelection,
  toGitHubLinkedWorkItem,
  toGitLabLinkedWorkItem,
  toLinearLinkedWorkItem
} from '@/components/sidebar/folder-workspace-composer-helpers'
import { useFolderWorkspaceComposerPathStatus } from '@/components/sidebar/folder-workspace-composer-path-status'
import { submitFolderWorkspaceCreate } from '@/components/sidebar/folder-workspace-composer-submit'
import { buildExecutionHostRegistry } from '../../../shared/execution-host-registry'
import {
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { queueNewWorkspaceTerminalFocus } from '@/lib/new-workspace-terminal-focus'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { getSuggestedCreatureName } from '@/components/sidebar/worktree-name-suggestions'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/SmartWorkspaceNameField'
import type { SmartNameMode } from '@/components/new-workspace/smart-workspace-source-results'
import { getForkPushWarning } from './fork-push-warning'
import {
  buildWorkspaceSourceSelection,
  shouldApplyWorkspaceSourceAutoName,
  shouldPreserveWorkspaceSourceOnRepoChange
} from '../../../shared/new-workspace/workspace-source'
import { CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT } from '@/components/contextual-tours/contextual-tour-composer-events'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { normalizeSparseDirectoryLines, sparseDirectoriesMatch } from '@/lib/sparse-paths'
import { joinPath } from '@/lib/path'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import {
  checkRuntimeHooks,
  readRuntimeIssueCommand,
  type HookCheckResult
} from '@/runtime/runtime-hooks-client'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage,
  type WorkspaceCreateErrorDisplay
} from '@/lib/workspace-create-error-format'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import {
  resolveComposerBranchNameOverrideForCreate,
  resolveComposerBranchPick,
  resolveComposerManualBranchNameChange,
  getComposerRepoWorktreeBranches
} from './composer-branch-selection'
import { isCurrentComposerDropOwner } from './composer-drop-owner'
import { applyComposerNativeFileDrop } from './composer-native-file-drop'
import {
  collectComposerDropUploadResult,
  shouldReportComposerDropUploadFailure
} from './composer-drop-upload-result'
import { translate } from '@/i18n/i18n'

export function canResolveFolderSmartGitHubSubmit({
  hasFolderSourceRepos
}: {
  hasFolderSourceRepos: boolean
}): boolean {
  return hasFolderSourceRepos
}

type PendingSmartGitHubSubmitResolution =
  | { kind: 'none' }
  | (SmartGitHubSubmitResolution & { kind: 'metadata-only' })
  | (SmartGitHubSubmitResolution & {
      kind: 'pr-start-point'
      baseBranch: string
      compareBaseRef?: string
      pushTarget?: GitPushTarget
      branchNameOverride?: string
    })

type SmartGitHubPrStartPointSelection = {
  repoId: string
  item: GitHubWorkItem
  resolved?: GitHubPrStartPoint
}

export type UseComposerStateOptions = {
  initialRepoId?: string
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  initialName?: string
  initialPrompt?: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
  initialTaskSourceContext?: TaskSourceContext | null
  initialWorkspaceStatus?: WorkspaceStatus
  /** Seeds the Start-from selection on open; the Create-from → Quick fallback uses it so a PR pick lands with the resolved PR head as base. */
  initialBaseBranch?: string
  /** The full-page composer persists drafts across navigation; the transient quick-composer modal must not clobber that draft. */
  persistDraft: boolean
  /** Invoked after a successful createWorktree; the caller usually closes its surface (palette modal, full page, etc.). */
  onCreated?: () => void
  /** External repoId override — used by TaskPage's work-item list, which drives repo selection from the page header, not the card. */
  repoIdOverride?: string
  onRepoIdOverrideChange?: (value: string) => void
  /** Telemetry surface that opened this composer; threaded into createWorktree so workspace_created.source reflects the entry point. Defaults to unknown. */
  telemetrySource?: WorkspaceCreateTelemetrySource
  /** Quick-create skips the issueCommand probe (no automation), which the full composer needs for linked-item prompt previews. */
  enableIssueAutomation?: boolean
  createGateMode?: 'full' | 'quick'
}

export type ComposerCardProps = {
  eligibleRepos: ReturnType<typeof useAppStore.getState>['repos']
  repoId: string
  projectOptions: NewWorkspaceProjectOption[]
  selectedProjectId: string | null
  selectedRepoIsGit: boolean
  onRepoChange: (value: string) => void
  onProjectChange: (value: string) => void
  projectHostSetupOptions: ProjectHostSetupOption[]
  selectedProjectHostSetupId: string | null
  onProjectHostSetupChange: (setupId: string) => void
  ephemeralVmRecipes: NonNullable<OrcaHooks['environmentRecipes']>
  selectedEphemeralVmRecipeId: string | null
  onEphemeralVmRecipeChange: (recipeId: string | null) => void
  ephemeralVmRecipeError: string | null
  repoBackedSearchRepos?: ReturnType<typeof useAppStore.getState>['repos']
  repoBackedSourcesDisabled?: boolean
  allowSmartNameAddProject?: boolean
  smartNameRepoSwitchTarget?: 'project' | 'task-source'
  name: string
  onNameValueChange: (value: string) => void
  branchNameOverride: string | undefined
  onBranchNameOverrideChange: (value: string | undefined) => void
  onSmartGitHubItemSelect: (item: GitHubWorkItem) => void
  onSmartGitLabItemSelect: (item: GitLabWorkItem) => void
  onSmartBranchSelect: (refName: string, localBranchName: string) => void
  onSmartNameModeChange?: (mode: SmartNameMode) => void
  onSmartLinearIssueSelect: (issue: LinearIssue) => void
  smartNameGitHubSourceContext?: TaskSourceContext | null
  /** GitLab parallel of onBaseBranchPrSelect. */
  onBaseBranchMrSelect?: (
    baseBranch: string,
    item: GitLabWorkItem,
    pushTarget?: GitPushTarget,
    compareBaseRef?: string
  ) => void
  smartNameSelection: SmartWorkspaceNameSelection | null
  onClearSmartNameSelection: () => void
  /** True when the selected source is an existing LOCAL branch that can be reused (checked out) — gates the reuse checkbox. */
  canReuseSelectedBranch: boolean
  /** Whether the selected existing local branch is reused (checked out) rather than branched from. */
  reuseSelectedBranch: boolean
  onReuseSelectedBranchChange: (next: boolean) => void
  /** Whether the "create multiple" toggle shows — worktree (git) targets only; folder workspaces create-and-close. */
  showCreateMultiple: boolean
  /** When on, the modal stays open after each create and resets identity fields to allow creating several in a row. */
  createMultiple: boolean
  onCreateMultipleChange: (next: boolean) => void
  agentPrompt: string
  onAgentPromptChange: (value: string) => void
  /** Rendered issueCommand template previewed in the empty prompt when a work item is linked but nothing typed. */
  linkedOnlyTemplatePreview: string | null
  attachmentPaths: string[]
  getAttachmentLabel: (pathValue: string) => string
  onAddAttachment: () => void
  onRemoveAttachment: (pathValue: string) => void
  linkedWorkItem: LinkedWorkItemSummary | null
  onRemoveLinkedWorkItem: () => void
  linkPopoverOpen: boolean
  onLinkPopoverOpenChange: (open: boolean) => void
  linkQuery: string
  onLinkQueryChange: (value: string) => void
  filteredLinkItems: GitHubWorkItem[]
  linkItemsLoading: boolean
  linkDirectLoading: boolean
  normalizedLinkQuery: { query: string }
  onSelectLinkedItem: (item: GitHubWorkItem) => void
  tuiAgent: TuiAgent
  onTuiAgentChange: (value: TuiAgent) => void
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
  baseBranch: string | undefined
  onBaseBranchChange: (next: string | undefined) => void
  /** Called when a PR is selected in the Start-from picker; updates baseBranch and linkedWorkItem/linkedPR in one pass. */
  onBaseBranchPrSelect: (
    baseBranch: string,
    item: GitHubWorkItem,
    pushTarget?: GitPushTarget,
    branchNameOverride?: string,
    compareBaseRef?: string
  ) => void
  /** PR number selected via the Start-from picker, so the field can render "PR #N" copy. */
  baseBranchLinkedPrNumber: number | null
  /** Absolute path of the selected repo, used by Start-from picker for SWR. */
  selectedRepoPath: string | null
  /** True when the selected repo is a remote SSH repo. */
  selectedRepoIsRemote: boolean
  selectedRepoConnectionId: string | null
  selectedRepoSshStatus: SshConnectionStatus | null
  selectedRepoRequiresConnection: boolean
  selectedRepoConnectInProgress: boolean
  onConnectSelectedRepo: () => Promise<void>
  branchesEnabled?: boolean
  /** Inline hint next to the Start-from trigger after a repo switch resets a prior selection (e.g. "was PR #8778"). Null when none. */
  startFromResetHint: string | null
  /** Warning when a selected fork PR has "Allow edits from maintainers" off, so a push may be rejected. Null when none. */
  forkPushWarning: string | null
  setupConfig: SetupConfig | null
  setupControlsEnabled?: boolean
  requiresExplicitSetupChoice: boolean
  setupDecision: 'run' | 'skip' | null
  onSetupDecisionChange: (value: 'run' | 'skip') => void
  setupAgentStartupPolicy: SetupAgentStartupPolicy
  onSetupAgentStartupPolicyChange: (value: SetupAgentStartupPolicy) => void
  shouldWaitForSetupCheck: boolean
  resolvedSetupDecision: 'run' | 'skip' | null
  createError: WorkspaceCreateErrorDisplay | null
  canUseSparseCheckout: boolean
  /** Saved sparse presets for the selected repo; empty when none exist or the repo is remote. */
  sparsePresets: SparsePreset[]
  /** ID of the selected sparse preset. Null means sparse checkout is off. */
  sparseSelectedPresetId: string | null
  onSparseSelectPreset: (preset: SparsePreset | null) => void
  sparseControlsEnabled?: boolean
}

export type UseComposerStateResult = {
  cardProps: ComposerCardProps
  /** Attach to the composer wrapper so the global Enter-to-submit handler scopes to the visible composer. */
  composerRef: React.RefObject<HTMLDivElement | null>
  onComposerNodeChange: (node: HTMLDivElement | null) => void
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>
  nameInputRef: React.RefObject<HTMLInputElement | null>
  submit: () => Promise<void>
  submitQuick: (agent: TuiAgent | null) => Promise<void>
  /** Invoked by the Enter handler to re-check whether submission should fire. */
  createDisabled: boolean
  /** Selects the repo a nested Add Project flow just added, clearing any folder-group target so the composer lands on it. */
  selectAddedProjectRepo: (repoId: string) => void
}

export type InitialWorkspaceRunSeedInput = {
  draftProjectId?: string | null
  draftHostId?: string | null
  draftProjectHostSetupId?: string | null
  initialTaskSourceContext?: Pick<
    TaskSourceContext,
    'projectId' | 'hostId' | 'projectHostSetupId'
  > | null
}

function getRepoSetupAgentStartupPolicy(repo?: {
  hookSettings?: Pick<RepoHookSettings, 'setupAgentStartupPolicy'>
}): SetupAgentStartupPolicy {
  return repo?.hookSettings?.setupAgentStartupPolicy ?? 'start-immediately'
}

function buildSetupAgentStartupHookSettings(
  current: RepoHookSettings | undefined,
  setupAgentStartupPolicy: SetupAgentStartupPolicy
): RepoHookSettings {
  const defaults = getDefaultRepoHookSettings()
  return {
    ...defaults,
    ...current,
    setupRunPolicy: current?.setupRunPolicy ?? defaults.setupRunPolicy,
    setupAgentStartupPolicy,
    commandSourcePolicy: current?.commandSourcePolicy ?? defaults.commandSourcePolicy,
    scripts: {
      ...defaults.scripts,
      ...current?.scripts
    }
  }
}

export function resolveInitialWorkspaceRunSeed({
  draftProjectId,
  draftHostId,
  draftProjectHostSetupId,
  initialTaskSourceContext
}: InitialWorkspaceRunSeedInput): {
  projectId: string | null
  hostId: ExecutionHostId | null
  projectHostSetupId: string | null
} {
  return {
    projectId: draftProjectId ?? initialTaskSourceContext?.projectId ?? null,
    hostId: normalizeExecutionHostId(draftHostId ?? initialTaskSourceContext?.hostId),
    projectHostSetupId:
      draftProjectHostSetupId ?? initialTaskSourceContext?.projectHostSetupId ?? null
  }
}

export function isExplicitWorkspaceNameInput({
  name,
  lastAutoName
}: {
  name: string
  lastAutoName: string
}): boolean {
  // Why: a user-authored name must win over linked-item and first-message AI naming.
  return Boolean(name.trim()) && name !== lastAutoName && !isWorkItemLookupText(name)
}

export function resolveSmartGitHubCreateNames({
  resolutionKind,
  smartWorkspaceName,
  smartDisplayName,
  fallbackWorkspaceName,
  nameIsAutoManaged
}: {
  resolutionKind: Exclude<PendingSmartGitHubSubmitResolution['kind'], 'none'>
  smartWorkspaceName: string
  smartDisplayName: string
  fallbackWorkspaceName: string
  nameIsAutoManaged: boolean
}): { workspaceName: string; displayName: string | undefined } {
  if (resolutionKind === 'pr-start-point' && !nameIsAutoManaged && fallbackWorkspaceName) {
    // Why: submit-time PR start-point augments an already-linked PR; don't reclaim a name the user edited after selecting.
    return { workspaceName: fallbackWorkspaceName, displayName: undefined }
  }
  return { workspaceName: smartWorkspaceName, displayName: smartDisplayName }
}

function getLinkedWorkItemSeedName(item: LinkedWorkItemSummary | null | undefined): string {
  if (!item) {
    return ''
  }
  return getLinkedWorkItemWorkspaceName(item)?.seedName ?? getLinkedWorkItemSuggestedName(item)
}

function getGitHubLinkedWorkItemIdentity(
  item: LinkedWorkItemSummary | null | undefined
): GitHubWorkItemIdentity | null {
  if (
    !item ||
    getLinkedWorkItemProvider(item) !== 'github' ||
    (item.type !== 'issue' && item.type !== 'pr')
  ) {
    return null
  }

  return resolveGitHubWorkItemIdentity({
    type: item.type,
    number: item.number,
    url: item.url
  })
}

function normalizeGitHubLinkedWorkItem(
  item: LinkedWorkItemSummary | null | undefined
): LinkedWorkItemSummary | null {
  if (!item) {
    return null
  }
  const identity = getGitHubLinkedWorkItemIdentity(item)
  if (!identity || (identity.type === item.type && identity.number === item.number)) {
    return item
  }

  return { ...item, type: identity.type, number: identity.number }
}

export function getInitialAutoManagedWorkspaceName({
  draftName,
  draftLinkedWorkItem,
  initialName,
  initialLinkedWorkItem
}: {
  draftName?: string | null
  draftLinkedWorkItem?: LinkedWorkItemSummary | null
  initialName: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
}): string {
  // Why: a prefilled name counts as user input unless it exactly matches the linked-item seed Orca generated.
  const candidateName = draftName ?? initialName
  const seedName = getLinkedWorkItemSeedName(draftLinkedWorkItem ?? initialLinkedWorkItem)
  return candidateName && seedName && candidateName === seedName ? candidateName : ''
}

// Why: page composer and Cmd+J modal can coexist, so route a native file drop to only the most-recently-mounted one, else it duplicates across both.
const composerDropStack: symbol[] = []
const EMPTY_SPARSE_PRESETS: SparsePreset[] = []

export function useComposerState(options: UseComposerStateOptions): UseComposerStateResult {
  const {
    initialRepoId,
    initialEphemeralVmRecipeId,
    initialName = '',
    initialPrompt = '',
    initialLinkedWorkItem = null,
    initialTaskSourceContext = null,
    initialWorkspaceStatus,
    initialBaseBranch,
    persistDraft,
    onCreated,
    repoIdOverride,
    onRepoIdOverrideChange,
    telemetrySource,
    enableIssueAutomation = true,
    createGateMode = 'full',
    initialProjectGroupId
  } = options

  // Why: fold stable actions into one useShallow subscription so a store mutation runs one equality check instead of 11.
  const actions = useAppStore(
    useShallow((s) => ({
      setNewWorkspaceDraft: s.setNewWorkspaceDraft,
      clearNewWorkspaceDraft: s.clearNewWorkspaceDraft,
      createWorktree: s.createWorktree,
      updateRepo: s.updateRepo,
      updateWorktreeMeta: s.updateWorktreeMeta,
      createFolderWorkspace: s.createFolderWorkspace,
      setSidebarOpen: s.setSidebarOpen,
      closeModal: s.closeModal,
      openSettingsPage: s.openSettingsPage,
      openSettingsTarget: s.openSettingsTarget,
      prefetchWorktreeCreateBase: s.prefetchWorktreeCreateBase,
      prefetchWorkItems: s.prefetchWorkItems,
      fetchSparsePresets: s.fetchSparsePresets
    }))
  )
  const {
    setNewWorkspaceDraft,
    clearNewWorkspaceDraft,
    createWorktree,
    updateRepo,
    updateWorktreeMeta,
    createFolderWorkspace,
    setSidebarOpen,
    closeModal,
    openSettingsPage,
    openSettingsTarget,
    prefetchWorktreeCreateBase,
    prefetchWorkItems,
    fetchSparsePresets
  } = actions

  const repos = useAppStore((s) => s.repos)
  const projects = useAppStore((s) => s.projects)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const settings = useAppStore((s) => s.settings)
  const newWorkspaceDraft = useAppStore((s) => s.newWorkspaceDraft)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const sparsePresetsByRepo = useAppStore((s) => s.sparsePresetsByRepo)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const eligibleRepos = useMemo(() => getComposerEligibleRepos(repos), [repos])
  // Why: a runtime-owned SSH repo (active right after creating a per-workspace-env) is ineligible; seed from its local same-project sibling, not another project.
  const seedActiveRepoId = useMemo(
    () => resolveComposerActiveRepoId(repos, eligibleRepos, activeRepoId),
    [repos, eligibleRepos, activeRepoId]
  )
  const draftRepoId = persistDraft ? (newWorkspaceDraft?.repoId ?? null) : null
  const draftProjectId = persistDraft ? (newWorkspaceDraft?.projectId ?? null) : null
  const draftProjectGroupId = persistDraft ? (newWorkspaceDraft?.projectGroupId ?? null) : null
  const draftHostId = persistDraft ? (newWorkspaceDraft?.hostId ?? null) : null
  const draftProjectHostSetupId = persistDraft
    ? (newWorkspaceDraft?.projectHostSetupId ?? null)
    : null
  // Why: Tasks can start from non-repo Linear/Jira contexts; seed from the logical project/source host so the modal doesn't fall back to the active repo.
  const initialRunSeed = resolveInitialWorkspaceRunSeed({
    draftProjectId,
    draftHostId,
    draftProjectHostSetupId,
    initialTaskSourceContext
  })
  const resolvedInitialWorkspaceStatus = useMemo(
    () =>
      initialWorkspaceStatus && isWorkspaceStatusId(initialWorkspaceStatus, workspaceStatuses)
        ? initialWorkspaceStatus
        : undefined,
    [initialWorkspaceStatus, workspaceStatuses]
  )

  const resolvedInitialRepoId = resolveWorkspaceCreationRepoId({
    eligibleRepos,
    projects,
    projectHostSetups,
    draftRepoId,
    initialRepoId,
    activeRepoId: seedActiveRepoId,
    projectId: initialRunSeed.projectId,
    hostId: initialRunSeed.hostId,
    projectHostSetupId: initialRunSeed.projectHostSetupId,
    focusedHostScope: workspaceHostScope
  })

  const [internalRepoId, setInternalRepoId] = useState<string>(resolvedInitialRepoId)
  const initialFolderProjectGroupId = initialProjectGroupId ?? draftProjectGroupId
  const initialFolderProjectGroup = projectGroups.find(
    (group) => group.id === initialFolderProjectGroupId && Boolean(group.parentPath?.trim())
  )
  const [selectedProjectGroupId, setSelectedProjectGroupId] = useState<string | null>(
    initialFolderProjectGroup?.id ?? null
  )
  const initialProjectGroupAppliedRef = useRef(Boolean(initialFolderProjectGroup))
  const [projectError, setProjectError] = useState<string | null>(null)
  const repoId = repoIdOverride ?? internalRepoId
  const selectedProjectGroup = useMemo<ProjectGroup | null>(
    () =>
      selectedProjectGroupId
        ? (projectGroups.find(
            (group) => group.id === selectedProjectGroupId && Boolean(group.parentPath?.trim())
          ) ?? null)
        : null,
    [projectGroups, selectedProjectGroupId]
  )
  useEffect(() => {
    if (selectedProjectGroupId && !selectedProjectGroup) {
      setSelectedProjectGroupId(null)
    }
  }, [selectedProjectGroup, selectedProjectGroupId])
  useEffect(() => {
    if (
      selectedProjectGroupId ||
      !initialFolderProjectGroupId ||
      initialProjectGroupAppliedRef.current
    ) {
      return
    }
    const nextGroup = projectGroups.find(
      (group) => group.id === initialFolderProjectGroupId && Boolean(group.parentPath?.trim())
    )
    if (nextGroup) {
      initialProjectGroupAppliedRef.current = true
      setSelectedProjectGroupId(nextGroup.id)
    }
  }, [initialFolderProjectGroupId, projectGroups, selectedProjectGroupId])
  const isProjectGroupTarget = selectedProjectGroup !== null
  const folderSourceRepos = useMemo(
    () => getFolderSourceRepos(repos, projectGroups, selectedProjectGroup),
    [projectGroups, repos, selectedProjectGroup]
  )
  const parsedFolderTargetHost = parseExecutionHostId(selectedProjectGroup?.executionHostId)
  const folderTargetRuntimeEnvironmentId =
    parsedFolderTargetHost?.kind === 'runtime' ? parsedFolderTargetHost.environmentId : null
  const folderTargetConnectionId =
    parsedFolderTargetHost?.kind === 'runtime' ? null : (selectedProjectGroup?.connectionId ?? null)
  const folderTargetIsRemote =
    folderTargetConnectionId !== null || folderTargetRuntimeEnvironmentId !== null
  const folderTargetAgentDetectionTarget = folderTargetRuntimeEnvironmentId
    ? { kind: 'runtime' as const, environmentId: folderTargetRuntimeEnvironmentId }
    : folderTargetConnectionId
      ? { kind: 'ssh' as const, connectionId: folderTargetConnectionId }
      : selectedProjectGroup
        ? { kind: 'local' as const }
        : undefined
  const folderTargetSshState = folderTargetConnectionId
    ? (sshConnectionStates.get(folderTargetConnectionId) ?? null)
    : null
  const {
    selectedRepoSshStatus: folderTargetSshStatus,
    selectedRepoRequiresConnection: folderTargetRequiresConnection,
    selectedRepoConnectInProgress: folderTargetConnectInProgress
  } = getSelectedRepoSshGate({
    connectionId: folderTargetConnectionId,
    status: folderTargetSshState?.status ?? null
  })
  const { pathStatusBlocksCreate: folderPathStatusBlocksCreate, pathStatusProjectError } =
    useFolderWorkspaceComposerPathStatus(
      selectedProjectGroup,
      true,
      folderTargetRuntimeEnvironmentId
    )
  const { detectedIds: folderDetectedIds } = useDetectedAgents(folderTargetAgentDetectionTarget)
  const folderDetectedAgentIds = useMemo<Set<TuiAgent> | null>(
    () => (folderDetectedIds ? new Set(folderDetectedIds) : null),
    [folderDetectedIds]
  )
  const selectedWorkspaceTarget = useMemo(
    () =>
      resolveWorkspaceCreationTarget({
        eligibleRepos,
        projects,
        projectHostSetups,
        draftRepoId: repoId,
        focusedHostScope: workspaceHostScope
      }),
    [eligibleRepos, projectHostSetups, projects, repoId, workspaceHostScope]
  )
  const selectedRepo = eligibleRepos.find((repo) => repo.id === repoId)
  const selectedRepoIsGit = selectedRepo ? isGitRepoKind(selectedRepo) : false
  const [ephemeralVmRecipes, setEphemeralVmRecipes] = useState<
    NonNullable<OrcaHooks['environmentRecipes']>
  >([])
  const [selectedEphemeralVmRecipeId, setSelectedEphemeralVmRecipeId] = useState<string | null>(
    null
  )
  const [ephemeralVmRecipeError, setEphemeralVmRecipeError] = useState<string | null>(null)
  const selectedRepoAgentLaunchPlatform = useMemo(() => {
    if (!selectedRepo) {
      return CLIENT_PLATFORM
    }
    const projectRuntime = selectedRepo.connectionId
      ? undefined
      : getLocalRepoProjectExecutionRuntimeContext(
          {
            activeRepoId,
            activeWorktreeId: null,
            projects,
            repos,
            settings,
            worktreesByRepo
          },
          selectedRepo.id,
          CLIENT_PLATFORM
        )
    return getAgentLaunchPlatformForRepo(selectedRepo, projectRuntime)
  }, [activeRepoId, projects, repos, selectedRepo, settings, worktreesByRepo])
  // Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only `orca-ide` rename must not apply to remote launch commands.
  const selectedRepoIsRemote = selectedRepo ? repoIsRemote(selectedRepo) : false
  const selectedRepoStartupShell = resolveLocalWindowsAgentStartupShell({
    platform: selectedRepoAgentLaunchPlatform,
    isRemote: selectedRepoIsRemote,
    terminalWindowsShell: settings?.terminalWindowsShell
  })
  const selectedRepoProjectId =
    selectedWorkspaceTarget.status === 'ready' ? selectedWorkspaceTarget.target.projectId : null
  const selectedProjectId = selectedProjectGroup
    ? `project-group:${selectedProjectGroup.id}`
    : selectedRepoProjectId
  const selectedProjectHostSetupId =
    !selectedProjectGroup && selectedWorkspaceTarget.status === 'ready'
      ? selectedWorkspaceTarget.target.projectHostSetupId
      : null
  const hostOptions = useMemo(
    () =>
      buildExecutionHostRegistry({
        repos,
        settings,
        sshTargetLabels,
        sshConnectionStates,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides: getHostDisplayLabelOverrides(settings)
      }),
    [
      repos,
      settings,
      sshConnectionStates,
      sshTargetLabels,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId
    ]
  )
  const projectHostSetupOptions = useMemo(
    () =>
      buildProjectHostSetupOptions({
        projectId: selectedRepoProjectId,
        projectHostSetups,
        eligibleRepos,
        hosts: hostOptions
      }),
    [eligibleRepos, hostOptions, projectHostSetups, selectedRepoProjectId]
  )
  const projectOptions = useMemo(
    () =>
      buildNewWorkspaceCreateTargetOptions({
        projects,
        projectHostSetups,
        eligibleRepos,
        projectGroups,
        hosts: hostOptions
      }),
    [eligibleRepos, hostOptions, projectGroups, projectHostSetups, projects]
  )
  const selectedRepoSettings = useMemo(() => {
    if (!settings) {
      return settings
    }
    // Why: probes and attachment uploads inspect the selected repo, even though creation defaults still follow host scope.
    return getSettingsForRepoRuntimeOwner(
      { repos: selectedRepo ? [selectedRepo] : [], settings },
      selectedRepo?.id ?? null
    )
  }, [selectedRepo, settings])
  // Why: key on repo id, not the repo object — updateRepo replaces it by reference and would re-run this effect, wiping the user's chosen recipe.
  const selectedRecipeRepoId = selectedRepo?.id ?? null
  const selectedRecipeRepoConnectionId = selectedRepo?.connectionId ?? null
  // Why: gate recipe probing on the experimental toggle, since discovery can surface setup errors for a hidden feature.
  const ephemeralVmsEnabled = settings?.experimentalEphemeralVms === true
  useEffect(() => {
    let cancelled = false
    setEphemeralVmRecipes([])
    setSelectedEphemeralVmRecipeId(null)
    setEphemeralVmRecipeError(null)
    if (
      !ephemeralVmsEnabled ||
      !selectedRecipeRepoId ||
      !selectedRepoIsGit ||
      selectedRecipeRepoConnectionId ||
      isProjectGroupTarget
    ) {
      return () => {
        cancelled = true
      }
    }
    void window.api.ephemeralVm
      .listRecipes({ repoId: selectedRecipeRepoId })
      .then((result) => {
        if (cancelled) {
          return
        }
        setEphemeralVmRecipes(result.recipes ?? [])
        setSelectedEphemeralVmRecipeId(
          initialEphemeralVmRecipeId &&
            result.recipes?.some((recipe) => recipe.id === initialEphemeralVmRecipeId)
            ? initialEphemeralVmRecipeId
            : null
        )
        const diagnosticMessages = (result.diagnostics ?? []).map((diagnostic) => {
          const recipeLabel = `environmentRecipes[${diagnostic.index}]`
          const fieldLabel = diagnostic.field ? `.${diagnostic.field}` : ''
          return `${recipeLabel}${fieldLabel}: ${diagnostic.message}`
        })
        setEphemeralVmRecipeError(
          [result.status === 'error' ? result.message : null, ...diagnosticMessages]
            .filter((message): message is string => Boolean(message))
            .join('\n') || null
        )
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setEphemeralVmRecipes([])
        setEphemeralVmRecipeError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [
    ephemeralVmsEnabled,
    initialEphemeralVmRecipeId,
    isProjectGroupTarget,
    selectedRecipeRepoConnectionId,
    selectedRecipeRepoId,
    selectedRepoIsGit
  ])
  const selectedRepoConnectionId = selectedRepo?.connectionId ?? null
  const selectedRepoSshState = selectedRepoConnectionId
    ? (sshConnectionStates.get(selectedRepoConnectionId) ?? null)
    : null
  const { selectedRepoSshStatus, selectedRepoRequiresConnection, selectedRepoConnectInProgress } =
    getSelectedRepoSshGate({
      connectionId: selectedRepoConnectionId,
      status: selectedRepoSshState?.status ?? null
    })
  const repoIdRef = useRef(repoId)
  repoIdRef.current = repoId
  const setRepoId = useCallback(
    (value: string) => {
      if (onRepoIdOverrideChange) {
        onRepoIdOverrideChange(value)
      } else {
        setInternalRepoId(value)
      }
    },
    [onRepoIdOverrideChange]
  )

  const [name, setName] = useState<string>(
    persistDraft ? (newWorkspaceDraft?.name ?? initialName) : initialName
  )
  const [agentPrompt, setAgentPrompt] = useState<string>(
    persistDraft ? (newWorkspaceDraft?.prompt ?? initialPrompt) : initialPrompt
  )
  const [note, setNote] = useState<string>(persistDraft ? (newWorkspaceDraft?.note ?? '') : '')
  const [attachmentPaths, setAttachmentPaths] = useState<string[]>(
    persistDraft ? (newWorkspaceDraft?.attachments ?? []) : []
  )
  const initialLinkedWorkItemSeed = normalizeGitHubLinkedWorkItem(initialLinkedWorkItem)
  const draftLinkedWorkItemSeed = persistDraft
    ? normalizeGitHubLinkedWorkItem(newWorkspaceDraft?.linkedWorkItem)
    : null
  const linkedWorkItemSeed = persistDraft
    ? (draftLinkedWorkItemSeed ?? initialLinkedWorkItemSeed)
    : initialLinkedWorkItemSeed
  const linkedWorkItemSeedIdentity = getGitHubLinkedWorkItemIdentity(linkedWorkItemSeed)
  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItemSummary | null>(
    () => linkedWorkItemSeed
  )
  const initialLinearBranchName = getLinearLinkedWorkItemBranchName(linkedWorkItemSeed)
  const taskSourceContext = useMemo(() => {
    if (
      persistDraft &&
      newWorkspaceDraft?.taskSourceContext &&
      newWorkspaceDraft.linkedWorkItem?.url === linkedWorkItem?.url
    ) {
      return newWorkspaceDraft.taskSourceContext
    }
    if (initialTaskSourceContext && initialLinkedWorkItem?.url === linkedWorkItem?.url) {
      return initialTaskSourceContext
    }
    if (
      !linkedWorkItem ||
      getLinkedWorkItemProvider(linkedWorkItem) !== 'github' ||
      !selectedRepo ||
      selectedWorkspaceTarget.status !== 'ready'
    ) {
      return null
    }
    const selectedProject = projects.find(
      (project) => project.id === selectedWorkspaceTarget.target.projectId
    )
    if (selectedProject?.providerIdentity?.provider !== 'github') {
      return null
    }
    return buildTaskSourceContextFromRepo({
      provider: 'github',
      projectId: selectedWorkspaceTarget.target.projectId,
      repo: selectedRepo,
      projectHostSetupId: selectedWorkspaceTarget.target.projectHostSetupId,
      providerIdentity: selectedProject.providerIdentity
    })
  }, [
    initialLinkedWorkItem,
    initialTaskSourceContext,
    linkedWorkItem,
    newWorkspaceDraft?.linkedWorkItem?.url,
    newWorkspaceDraft?.taskSourceContext,
    persistDraft,
    projects,
    selectedRepo,
    selectedWorkspaceTarget
  ])
  const selectedRepoGitHubSourceContext = useMemo(() => {
    if (!selectedRepo || !selectedRepoIsGit) {
      return null
    }
    if (taskSourceContext?.provider === 'github') {
      return taskSourceContext
    }
    if (selectedWorkspaceTarget.status === 'ready') {
      const selectedProject = projects.find(
        (project) => project.id === selectedWorkspaceTarget.target.projectId
      )
      return buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: selectedWorkspaceTarget.target.projectId,
        repo: selectedRepo,
        projectHostSetupId: selectedWorkspaceTarget.target.projectHostSetupId,
        providerIdentity:
          selectedProject?.providerIdentity?.provider === 'github'
            ? selectedProject.providerIdentity
            : null
      })
    }
    return buildTaskSourceContextFromRepo({
      provider: 'github',
      projectId: selectedRepo.id,
      repo: selectedRepo
    })
  }, [projects, selectedRepo, selectedRepoIsGit, selectedWorkspaceTarget, taskSourceContext])
  const [linkedIssue, setLinkedIssue] = useState<string>(() => {
    if (linkedWorkItemSeedIdentity?.type === 'issue') {
      return String(linkedWorkItemSeedIdentity.number)
    }
    if (persistDraft && newWorkspaceDraft?.linkedIssue) {
      return newWorkspaceDraft.linkedIssue
    }
    if (
      initialLinkedWorkItem?.type === 'issue' &&
      getLinkedWorkItemProvider(initialLinkedWorkItem) === 'github'
    ) {
      return String(initialLinkedWorkItem.number)
    }
    return ''
  })
  const [linkedPR, setLinkedPR] = useState<number | null>(() => {
    if (linkedWorkItemSeedIdentity?.type === 'pr') {
      return linkedWorkItemSeedIdentity.number
    }
    if (linkedWorkItemSeedIdentity?.type === 'issue') {
      return null
    }
    if (persistDraft && newWorkspaceDraft?.linkedPR !== undefined) {
      return newWorkspaceDraft.linkedPR
    }
    return initialLinkedWorkItem?.type === 'pr' ? initialLinkedWorkItem.number : null
  })
  // Why: GitLab parallels of linkedIssue/linkedPR, kept as separate state so existing GitHub auto-name/badge/persistence paths stay untouched.
  const [linkedGitLabIssue, setLinkedGitLabIssue] = useState<number | null>(() => {
    if (persistDraft && newWorkspaceDraft?.linkedGitLabIssue !== undefined) {
      return newWorkspaceDraft.linkedGitLabIssue
    }
    return initialLinkedWorkItem?.type === 'issue' && isGitLabIssueUrl(initialLinkedWorkItem.url)
      ? initialLinkedWorkItem.number
      : null
  })
  const [linkedGitLabMR, setLinkedGitLabMR] = useState<number | null>(() => {
    if (persistDraft && newWorkspaceDraft?.linkedGitLabMR !== undefined) {
      return newWorkspaceDraft.linkedGitLabMR
    }
    return initialLinkedWorkItem?.type === 'mr' ? initialLinkedWorkItem.number : null
  })
  const [baseBranch, setBaseBranch] = useState<string | undefined>(
    persistDraft ? newWorkspaceDraft?.baseBranch : initialBaseBranch
  )
  const [compareBaseRef, setCompareBaseRef] = useState<string | undefined>(
    persistDraft ? newWorkspaceDraft?.compareBaseRef : undefined
  )
  const [branchNameOverride, setBranchNameOverride] = useState<string | undefined>(
    initialLinearBranchName
  )
  const [branchNameOverridePreservesNameEdits, setBranchNameOverridePreservesNameEdits] = useState(
    Boolean(initialLinearBranchName)
  )
  const [smartNameMode, setSmartNameMode] = useState<SmartNameMode>('smart')
  // Why (#5181): reuseEligibleBranch = local branch name eligible for checkout-reuse (null if none); reuseSelectedBranch = the checkbox that enacts it.
  const [reuseEligibleBranch, setReuseEligibleBranch] = useState<string | null>(null)
  const [reuseSelectedBranch, setReuseSelectedBranch] = useState(false)
  const [pushTarget, setPushTarget] = useState<GitPushTarget | undefined>(undefined)
  // Why: when a repo switch wipes a prior Start-from selection, surface the reset inline (e.g. "was PR #8778") so it doesn't slip past the user.
  const [startFromResetHint, setStartFromResetHint] = useState<string | null>(null)
  // Why: a fork PR with "Allow edits from maintainers" off can't be pushed to; warn (don't block) so a rejected push isn't a surprise.
  const [forkPushWarning, setForkPushWarning] = useState<string | null>(null)
  const disabledTuiAgentKey = (settings?.disabledTuiAgents ?? []).join('\u0000')
  const disabledTuiAgents = useMemo<TuiAgent[]>(
    () => settings?.disabledTuiAgents ?? [],
    // Why: settings IPC clones arrays, so key on the disabled-agent content, not the array ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabledTuiAgentKey]
  )
  // Why: the long-form composer requires a real TuiAgent, so a global 'blank' pref collapses to Claude (blank only exists in quick-create).
  const enabledCatalogAgents = useMemo(
    () =>
      filterEnabledTuiAgents(
        getAgentCatalog().map((agent) => agent.id),
        disabledTuiAgents
      ),
    [disabledTuiAgents]
  )
  const fallbackDefaultAgent: TuiAgent =
    settings?.defaultTuiAgent &&
    settings.defaultTuiAgent !== 'blank' &&
    isTuiAgentEnabled(settings.defaultTuiAgent, disabledTuiAgents)
      ? settings.defaultTuiAgent
      : (enabledCatalogAgents[0] ?? 'claude')
  const [tuiAgent, setTuiAgent] = useState<TuiAgent>(
    persistDraft ? (newWorkspaceDraft?.agent ?? fallbackDefaultAgent) : fallbackDefaultAgent
  )
  // Why: for a repo on an SSH host or runtime env, read the per-host agent list so the dialog shows the host's installed agents, not local.
  const connectionId = selectedRepoConnectionId
  const isRemote = typeof connectionId === 'string'
  const runtimeEnvironmentId = selectedRepoSettings?.activeRuntimeEnvironmentId?.trim() || null
  const detectedAgentList = useAppStore((s) => {
    if (isRemote) {
      return s.remoteDetectedAgentIds[connectionId] ?? null
    }
    if (runtimeEnvironmentId) {
      return s.runtimeDetectedAgentIds[runtimeEnvironmentId] ?? null
    }
    return s.detectedAgentIds
  })
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  const ensureRemoteDetectedAgents = useAppStore((s) => s.ensureRemoteDetectedAgents)
  const ensureRuntimeDetectedAgents = useAppStore((s) => s.ensureRuntimeDetectedAgents)
  const detectedAgentIds = useMemo<Set<TuiAgent> | null>(
    () => (detectedAgentList ? new Set(detectedAgentList) : null),
    [detectedAgentList]
  )

  const [yamlHooks, setYamlHooks] = useState<OrcaHooks | null>(null)
  const [checkedHooksRepoId, setCheckedHooksRepoId] = useState<string | null>(null)
  const [issueCommandTemplate, setIssueCommandTemplate] = useState('')
  const [hasLoadedIssueCommand, setHasLoadedIssueCommand] = useState(false)
  const [setupDecision, setSetupDecision] = useState<'run' | 'skip' | null>(null)
  const [setupAgentStartupPolicy, setSetupAgentStartupPolicy] = useState<SetupAgentStartupPolicy>(
    () => getRepoSetupAgentStartupPolicy(selectedRepo)
  )
  const setupAgentStartupPolicyRef = useRef(setupAgentStartupPolicy)
  setupAgentStartupPolicyRef.current = setupAgentStartupPolicy
  const setupAgentStartupPolicySaveRef = useRef<{
    repoId: string
    policy: SetupAgentStartupPolicy
    promise: Promise<boolean>
  } | null>(null)
  const setupAgentStartupPolicyDraftRef = useRef<{
    repoId: string
    policy: SetupAgentStartupPolicy
  } | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<WorkspaceCreateErrorDisplay | null>(null)
  // Why: when checked, a successful create keeps the modal open and resets identity fields so the user can queue another worktree.
  const [createMultiple, setCreateMultiple] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(
    persistDraft ? Boolean((newWorkspaceDraft?.note ?? '').trim()) : false
  )
  const [sparseEnabled, setSparseEnabled] = useState(false)
  const [sparseDirectories, setSparseDirectories] = useState('')
  const [sparseSelectedPresetId, setSparseSelectedPresetId] = useState<string | null>(null)

  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [linkQuery, setLinkQuery] = useState('')
  const [linkDebouncedQuery, setLinkDebouncedQuery] = useState('')
  const [linkItems, setLinkItems] = useState<GitHubWorkItem[]>([])
  const [linkItemsLoading, setLinkItemsLoading] = useState(false)
  const [linkDirectItem, setLinkDirectItem] = useState<GitHubWorkItem | null>(null)
  const [linkDirectLoading, setLinkDirectLoading] = useState(false)

  const lastAutoNameRef = useRef<string>(
    getInitialAutoManagedWorkspaceName({
      draftName: persistDraft ? newWorkspaceDraft?.name : null,
      draftLinkedWorkItem: persistDraft ? draftLinkedWorkItemSeed : null,
      initialName,
      initialLinkedWorkItem: initialLinkedWorkItemSeed
    })
  )
  const nameRef = useRef<string>(name)
  nameRef.current = name
  const branchAutoNameRef = useRef<string>('')
  // Why: the note we auto-prefilled from a Start-from PR pick, so a later PR change can replace it without clobbering user-typed text.
  const lastAutoNoteRef = useRef<string>('')
  // Why: let handleBaseBranchPrSelect read the latest note without adding it to deps (would rebuild the callback on every keystroke).
  const noteRef = useRef<string>(note)
  noteRef.current = note
  // Why: PR checkout refs resolve async, so submit can still see the linked PR as a checkout source if Create fires before the resolver settles.
  const smartGitHubPrStartPointSelectionRef = useRef<SmartGitHubPrStartPointSelection | null>(null)
  useEffect(() => {
    const clearAutoManagedName = (): void => {
      if (nameRef.current === lastAutoNameRef.current) {
        setName('')
        lastAutoNameRef.current = ''
        setCreateError(null)
      }
    }

    window.addEventListener(CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT, clearAutoManagedName)
    return () => {
      window.removeEventListener(
        CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT,
        clearAutoManagedName
      )
    }
  }, [])
  const composerRef = useRef<HTMLDivElement | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const promptCaretFrameRef = useRef<number | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  // Why: mirror agentPrompt into a ref so the once-mounted file-drop listener reads it fresh without re-subscribing, which would reorder composerDropStack.
  const agentPromptRef = useRef(agentPrompt)
  agentPromptRef.current = agentPrompt
  const connectionIdRef = useRef(connectionId)
  connectionIdRef.current = connectionId
  const selectedRepoConnectionIdRef = useRef(selectedRepoConnectionId)
  selectedRepoConnectionIdRef.current = selectedRepoConnectionId

  // Why: compare the full host-aware identity before linking a pasted PR URL to this repo.
  const [selectedRepoSlug, setSelectedRepoSlug] = useState<GitHubRepositoryIdentity | null>(null)
  const selectedRepoPath = selectedRepo?.path
  const selectedRepoPathRef = useRef<string | undefined>(selectedRepoPath)
  selectedRepoPathRef.current = selectedRepoPath
  const selectedRepoSettingsRef = useRef(selectedRepoSettings)
  selectedRepoSettingsRef.current = selectedRepoSettings

  // Why: depend on the persisted policy *value*, not the selectedRepo object. Background repo
  // refetches (git polling) hand back a new repo reference with the same hookSettings; keying on
  // the object would re-run this and briefly flip the toggle back to the stale value — the glitch.
  const persistedSetupAgentStartupPolicy = getRepoSetupAgentStartupPolicy(selectedRepo)
  useEffect(() => {
    const draft = setupAgentStartupPolicyDraftRef.current
    if (draft?.repoId === repoId && draft.policy !== persistedSetupAgentStartupPolicy) {
      return
    }
    setupAgentStartupPolicyRef.current = persistedSetupAgentStartupPolicy
    setSetupAgentStartupPolicy(persistedSetupAgentStartupPolicy)
  }, [repoId, persistedSetupAgentStartupPolicy])

  const persistSetupAgentStartupPolicy = useCallback(
    async (
      policy: SetupAgentStartupPolicy = setupAgentStartupPolicyRef.current
    ): Promise<boolean> => {
      while (true) {
        const currentRepo = useAppStore.getState().repos.find((repo) => repo.id === repoId)
        if (!currentRepo || !isGitRepoKind(currentRepo)) {
          return true
        }
        const pendingSave = setupAgentStartupPolicySaveRef.current
        if (pendingSave?.repoId === currentRepo.id) {
          if (pendingSave.policy === policy) {
            const saved = await pendingSave.promise
            if (
              saved &&
              setupAgentStartupPolicyDraftRef.current?.repoId === currentRepo.id &&
              setupAgentStartupPolicyDraftRef.current.policy === policy
            ) {
              setupAgentStartupPolicyDraftRef.current = null
            }
            return saved
          }
          await pendingSave.promise
          continue
        }
        if (getRepoSetupAgentStartupPolicy(currentRepo) === policy) {
          if (
            setupAgentStartupPolicyDraftRef.current?.repoId === currentRepo.id &&
            setupAgentStartupPolicyDraftRef.current.policy === policy
          ) {
            setupAgentStartupPolicyDraftRef.current = null
          }
          return true
        }
        const promise = updateRepo(currentRepo.id, {
          hookSettings: buildSetupAgentStartupHookSettings(currentRepo.hookSettings, policy)
        }).finally(() => {
          if (setupAgentStartupPolicySaveRef.current?.promise === promise) {
            setupAgentStartupPolicySaveRef.current = null
          }
        })
        setupAgentStartupPolicySaveRef.current = { repoId: currentRepo.id, policy, promise }
        const saved = await promise
        if (
          saved &&
          setupAgentStartupPolicyDraftRef.current?.repoId === currentRepo.id &&
          setupAgentStartupPolicyDraftRef.current.policy === policy
        ) {
          setupAgentStartupPolicyDraftRef.current = null
        }
        return saved
      }
    },
    [repoId, updateRepo]
  )

  const handleSetupAgentStartupPolicyChange = useCallback(
    (policy: SetupAgentStartupPolicy) => {
      setupAgentStartupPolicyRef.current = policy
      if (repoId) {
        setupAgentStartupPolicyDraftRef.current = { repoId, policy }
      }
      setSetupAgentStartupPolicy(policy)
      void persistSetupAgentStartupPolicy(policy).then((saved) => {
        if (!saved) {
          toast.error(
            translate(
              'auto.hooks.useComposerState.setupAgentStartupPolicySaveFailed',
              'Failed to save setup startup behavior.'
            )
          )
        }
      })
    },
    [persistSetupAgentStartupPolicy, repoId]
  )

  const cancelPromptCaretFrame = useCallback((): void => {
    if (promptCaretFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(promptCaretFrameRef.current)
    promptCaretFrameRef.current = null
  }, [])

  const handleComposerNodeChange = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: cancel the queued caret restoration once the composer root (its target's ancestor) leaves the DOM.
      if (!node) {
        cancelPromptCaretFrame()
      }
    },
    [cancelPromptCaretFrame]
  )

  const hookCheckRef = useRef<{
    key: string
    promise: Promise<HookCheckResult>
  } | null>(null)
  const loadHookCheckForRepo = useCallback((targetRepoId: string): Promise<HookCheckResult> => {
    const key = `${selectedRepoSettingsRef.current?.activeRuntimeEnvironmentId ?? 'local'}:${targetRepoId}`
    const existing = hookCheckRef.current
    if (existing?.key === key) {
      return existing.promise
    }
    const promise = checkRuntimeHooks(selectedRepoSettingsRef.current, targetRepoId)
    hookCheckRef.current = { key, promise }
    return promise
  }, [])
  const commitHookCheckIfCurrent = useCallback(
    (targetRepoId: string, hooks: OrcaHooks | null): boolean => {
      if (repoIdRef.current !== targetRepoId) {
        return false
      }
      setYamlHooks(hooks)
      setCheckedHooksRepoId(targetRepoId)
      return true
    },
    []
  )
  useEffect(() => {
    if (!selectedRepo || !selectedRepoPath || !selectedRepoIsGit) {
      setSelectedRepoSlug(null)
      return
    }
    let cancelled = false
    const target = getActiveRuntimeTarget(selectedRepoSettings)
    const slugRequest =
      target.kind === 'environment'
        ? callRuntimeRpc<GitHubRepositoryIdentity | null>(
            target,
            'github.repoSlug',
            { repo: repoId },
            { timeoutMs: 30_000 }
          )
        : (window.api.gh.repoSlug({ repoPath: selectedRepoPath, repoId }) as Promise<{
            owner: string
            repo: string
          } | null>)
    void slugRequest
      .then((result) => {
        if (cancelled) {
          return
        }
        setSelectedRepoSlug(result)
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedRepoSlug(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, selectedRepo, selectedRepoIsGit, selectedRepoPath, selectedRepoSettings])
  const sparsePresetsForRepo = sparsePresetsByRepo[repoId]
  const sparsePresets = sparsePresetsForRepo ?? EMPTY_SPARSE_PRESETS
  const normalizedSparseDirectories = useMemo(
    () => normalizeSparseDirectoryLines(sparseDirectories),
    [sparseDirectories]
  )
  // Why: only attribute the preset if the directories still match it; an edited selection is "Custom", not falsely tagged as the original preset.
  const effectivePresetId = useMemo(() => {
    if (!sparseSelectedPresetId) {
      return null
    }
    const selected = sparsePresets.find((preset) => preset.id === sparseSelectedPresetId)
    if (!selected) {
      return null
    }
    return sparseDirectoriesMatch(selected.directories, normalizedSparseDirectories)
      ? selected.id
      : null
  }, [normalizedSparseDirectories, sparsePresets, sparseSelectedPresetId])

  const sparseError = useMemo(() => {
    if (!sparseEnabled) {
      return null
    }
    if (!selectedRepoIsGit) {
      return null
    }
    if (selectedRepo?.connectionId) {
      return 'Sparse checkout is only supported for local repos right now.'
    }
    if (normalizedSparseDirectories.length === 0) {
      return 'Enter at least one repo-relative directory.'
    }
    if (
      normalizedSparseDirectories.some((entry) => entry === '.' || entry.split('/').includes('..'))
    ) {
      return 'Use repo-relative directories, not root or parent paths.'
    }
    return null
  }, [normalizedSparseDirectories, selectedRepo?.connectionId, selectedRepoIsGit, sparseEnabled])
  const parsedLinkedIssueNumber = useMemo(
    () => (linkedIssue.trim() ? parseGitHubIssueOrPRNumber(linkedIssue) : null),
    [linkedIssue]
  )
  // Why: a PR URL pasted into the name field (not picked) leaves linkedPR null; recover the number so the worktree still links back to its PR.
  const effectiveLinkedPR = useMemo<number | null>(() => {
    if (linkedPR !== null) {
      return linkedPR
    }
    const fromName = parseGitHubIssueOrPRLink(name)
    if (fromName && fromName.type === 'pr') {
      // Why: adopt the number only when the URL slug matches the selected repo (and the slug has resolved), else a foreign PR URL mislinks to a same-numbered PR here.
      if (
        selectedRepoSlug &&
        githubRepoIdentityKey(fromName.slug) === githubRepoIdentityKey(selectedRepoSlug)
      ) {
        return fromName.number
      }
    }
    return null
  }, [linkedPR, name, selectedRepoSlug])
  const setupConfig = useMemo(
    () => (selectedRepoIsGit ? getSetupConfig(selectedRepo, yamlHooks) : null),
    [selectedRepo, selectedRepoIsGit, yamlHooks]
  )
  const setupPolicy: SetupRunPolicy = selectedRepo?.hookSettings?.setupRunPolicy ?? 'run-by-default'
  const linkedWorkItemProvider = linkedWorkItem ? getLinkedWorkItemProvider(linkedWorkItem) : null
  // Why: the no-prompt+linked-item path rehydrates the issueCommand template into the prompt, but Linear starts never use it, so they must not wait.
  const willApplyIssueCommandAsPrompt =
    enableIssueAutomation &&
    !agentPrompt.trim() &&
    Boolean(linkedWorkItem) &&
    linkedWorkItemProvider !== 'linear'
  const shouldWaitForIssueAutomationCheck =
    enableIssueAutomation &&
    (parsedLinkedIssueNumber !== null || willApplyIssueCommandAsPrompt) &&
    !hasLoadedIssueCommand
  const requiresExplicitSetupChoice = Boolean(setupConfig) && setupPolicy === 'ask'
  const resolvedSetupDecision =
    setupDecision ??
    (!setupConfig || setupPolicy === 'ask'
      ? null
      : setupPolicy === 'run-by-default'
        ? 'run'
        : 'skip')
  const isSetupCheckPending = Boolean(repoId) && checkedHooksRepoId !== repoId
  const shouldWaitForSetupCheck = Boolean(selectedRepo) && selectedRepoIsGit && isSetupCheckPending

  // Why: blank name with no other seed → globally-unique creature name so workspaces don't collide across repos or on a literal default.
  const fallbackCreatureName = useMemo(
    () => getSuggestedCreatureName(worktreesByRepo),
    [worktreesByRepo]
  )
  const workspaceSeedName = useMemo(
    () =>
      getWorkspaceSeedName({
        explicitName: name,
        prompt: agentPrompt,
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR,
        fallbackName: fallbackCreatureName
      }),
    [agentPrompt, fallbackCreatureName, linkedPR, name, parsedLinkedIssueNumber]
  )
  // Why: exclude Linear — its starts may carry only a neutral issue ref, whereas repo issue-command templates are product-authored workflow direction.
  const shouldApplyLinkedOnlyTemplate =
    enableIssueAutomation &&
    !agentPrompt.trim() &&
    Boolean(linkedWorkItem) &&
    hasLoadedIssueCommand &&
    linkedWorkItemProvider !== 'linear'
  const linkedOnlyTemplatePrompt = useMemo(() => {
    if (!shouldApplyLinkedOnlyTemplate || !linkedWorkItem) {
      return ''
    }
    const template = issueCommandTemplate.trim() || DEFAULT_ISSUE_COMMAND_TEMPLATE
    return renderIssueCommandTemplate(template, {
      issueNumber: linkedWorkItem.type === 'issue' ? linkedWorkItem.number : null,
      artifactUrl: linkedWorkItem.url
    })
  }, [issueCommandTemplate, linkedWorkItem, shouldApplyLinkedOnlyTemplate])
  const normalizedLinkQuery = useMemo(
    () => normalizeGitHubLinkQuery(linkDebouncedQuery),
    [linkDebouncedQuery]
  )

  const filteredLinkItems = useMemo(() => {
    if (normalizedLinkQuery.tooLarge) {
      return []
    }
    if (normalizedLinkQuery.directNumber !== null) {
      return linkDirectItem ? [linkDirectItem] : []
    }

    const query = normalizedLinkQuery.query.trim().toLowerCase()
    if (!query) {
      return linkItems
    }

    return linkItems.filter((item) => {
      const text = [
        item.type,
        item.number,
        item.title,
        item.author ?? '',
        item.labels.join(' '),
        item.branchName ?? '',
        item.baseRefName ?? ''
      ]
        .join(' ')
        .toLowerCase()
      return text.includes(query)
    })
  }, [
    linkDirectItem,
    linkItems,
    normalizedLinkQuery.directNumber,
    normalizedLinkQuery.query,
    normalizedLinkQuery.tooLarge
  ])

  // Persist draft whenever relevant fields change (full-page only).
  useEffect(() => {
    if (!persistDraft) {
      return
    }
    setNewWorkspaceDraft({
      repoId: repoId || null,
      projectId:
        selectedProjectGroup !== null
          ? null
          : selectedWorkspaceTarget.status === 'ready'
            ? selectedWorkspaceTarget.target.projectId
            : null,
      projectGroupId: selectedProjectGroup?.id ?? null,
      hostId:
        selectedProjectGroup !== null
          ? null
          : selectedWorkspaceTarget.status === 'ready'
            ? selectedWorkspaceTarget.target.hostId
            : null,
      projectHostSetupId:
        selectedProjectGroup !== null
          ? null
          : selectedWorkspaceTarget.status === 'ready'
            ? selectedWorkspaceTarget.target.projectHostSetupId
            : null,
      name,
      prompt: agentPrompt,
      note,
      attachments: attachmentPaths,
      linkedWorkItem,
      taskSourceContext,
      agent: tuiAgent,
      linkedIssue,
      linkedPR,
      linkedGitLabIssue,
      linkedGitLabMR,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(compareBaseRef !== undefined ? { compareBaseRef } : {})
    })
  }, [
    persistDraft,
    agentPrompt,
    attachmentPaths,
    baseBranch,
    compareBaseRef,
    linkedIssue,
    linkedPR,
    linkedGitLabIssue,
    linkedGitLabMR,
    linkedWorkItem,
    note,
    name,
    repoId,
    selectedProjectGroup,
    selectedWorkspaceTarget,
    setNewWorkspaceDraft,
    taskSourceContext,
    tuiAgent
  ])

  // Auto-pick the first eligible repo if we somehow start with none selected.
  useEffect(() => {
    if (isProjectGroupTarget) {
      return
    }
    if (!repoId && eligibleRepos[0]?.id) {
      setRepoId(eligibleRepos[0].id)
    }
  }, [eligibleRepos, isProjectGroupTarget, repoId, setRepoId])

  useEffect(() => {
    if (!selectedProjectGroup) {
      return
    }
    if (repoId && folderSourceRepos.some((repo) => repo.id === repoId)) {
      return
    }
    setRepoId(folderSourceRepos[0]?.id ?? '')
  }, [folderSourceRepos, repoId, selectedProjectGroup, setRepoId])

  // Why: the sparse dropdown is always visible under Advanced, so presets must load before sparse mode is enabled.
  useEffect(() => {
    if (!repoId || !selectedRepoIsGit || selectedRepo?.connectionId) {
      return
    }
    if (sparsePresetsByRepo[repoId] !== undefined) {
      return
    }
    void fetchSparsePresets(repoId)
  }, [
    fetchSparsePresets,
    repoId,
    selectedRepo?.connectionId,
    selectedRepoIsGit,
    sparsePresetsByRepo
  ])

  // Why: re-detect agents when the selected repo changes so the list matches the correct host (local runs once, deduped by the store).
  useEffect(() => {
    if (isRemote && selectedRepoSshStatus !== 'connected') {
      return
    }
    let cancelled = false
    const detect = isRemote
      ? ensureRemoteDetectedAgents(connectionId)
      : runtimeEnvironmentId
        ? ensureRuntimeDetectedAgents(runtimeEnvironmentId)
        : ensureDetectedAgents()
    void detect.then((ids) => {
      if (cancelled) {
        return
      }
      const enabledIds = filterEnabledTuiAgents(ids, disabledTuiAgents)
      if (!newWorkspaceDraft?.agent && !settings?.defaultTuiAgent && enabledIds.length > 0) {
        const firstInCatalogOrder = getAgentCatalog().find((a) => enabledIds.includes(a.id))
        if (firstInCatalogOrder) {
          setTuiAgent(firstInCatalogOrder.id)
        }
      } else if (!isTuiAgentEnabled(tuiAgent, disabledTuiAgents)) {
        const firstEnabledDetected = getAgentCatalog().find((a) => enabledIds.includes(a.id))
        setTuiAgent(firstEnabledDetected?.id ?? fallbackDefaultAgent)
      }
    })
    return () => {
      cancelled = true
    }
    // Why: deps narrowed to host identity (connectionId/runtimeEnvironmentId); detection is a best-effort PATH snapshot, so draft/settings are excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, runtimeEnvironmentId, isRemote, selectedRepoSshStatus, disabledTuiAgents])

  // Per-repo: load yaml hooks + issue command template.
  useEffect(() => {
    if (!repoId) {
      return
    }

    let cancelled = false
    setHasLoadedIssueCommand(false)
    setIssueCommandTemplate('')
    setYamlHooks(null)
    setCheckedHooksRepoId(null)

    if (!selectedRepoIsGit) {
      setHasLoadedIssueCommand(true)
      setCheckedHooksRepoId(repoId)
      return () => {
        cancelled = true
      }
    }

    void loadHookCheckForRepo(repoId)
      .then((result) => {
        if (!cancelled) {
          commitHookCheckIfCurrent(repoId, result.hooks)
        }
      })
      .catch(() => {
        if (!cancelled) {
          commitHookCheckIfCurrent(repoId, null)
        }
      })

    if (!enableIssueAutomation) {
      setHasLoadedIssueCommand(true)
      return () => {
        cancelled = true
      }
    }

    void readRuntimeIssueCommand(selectedRepoSettingsRef.current, repoId)
      .then((result) => {
        if (!cancelled) {
          setIssueCommandTemplate(result.effectiveContent ?? '')
          setHasLoadedIssueCommand(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIssueCommandTemplate('')
          setHasLoadedIssueCommand(true)
        }
      })

    return () => {
      cancelled = true
    }
    // Why: key on the stable runtime-env id, not the selectedRepoSettings object. `updateRepo`
    // (e.g. saving the setup toggle from this very composer) replaces selectedRepo — and thus the
    // memoized selectedRepoSettings — by reference; depending on the object would re-run this
    // effect, blank yamlHooks to null, and make the whole setup section vanish for a frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    commitHookCheckIfCurrent,
    enableIssueAutomation,
    loadHookCheckForRepo,
    repoId,
    selectedRepoIsGit,
    runtimeEnvironmentId
  ])

  const onConnectSelectedRepo = useCallback(async (): Promise<void> => {
    const targetId = selectedRepoConnectionIdRef.current
    if (!targetId) {
      return
    }
    const liveState = useAppStore.getState()
    const liveRepo = liveState.repos.find((repo) => repo.id === repoIdRef.current)
    if (liveRepo?.connectionId !== targetId) {
      return
    }
    const liveStatus = liveState.sshConnectionStates.get(targetId)?.status ?? null
    if (liveStatus === 'connected' || isSshConnectInProgress(liveStatus)) {
      return
    }

    try {
      await window.api.ssh.connect({ targetId })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.hooks.useComposerState.ba6cb77082', 'Failed to connect to project.')
      )
    }
  }, [])

  const onConnectSelectedProjectGroup = useCallback(async (): Promise<void> => {
    if (!folderTargetConnectionId) {
      return
    }
    const liveStatus = useAppStore
      .getState()
      .sshConnectionStates.get(folderTargetConnectionId)?.status
    if (liveStatus === 'connected' || isSshConnectInProgress(liveStatus ?? null)) {
      return
    }
    try {
      await window.api.ssh.connect({ targetId: folderTargetConnectionId })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.hooks.useComposerState.ba6cb77082', 'Failed to connect to project.')
      )
    }
  }, [folderTargetConnectionId])

  // Why: warm the Start-from picker's PR cache so opening it paints instantly from cache.
  const canPrefetchSelectedRepoWorkItems = canUseRepoBackedComposerSources({
    connectionId: selectedRepoConnectionId,
    status: selectedRepoSshStatus
  })
  const prefetchSshConnectedGeneration =
    selectedRepoConnectionId && selectedRepoSshStatus === 'connected' ? sshConnectedGeneration : 0
  useEffect(() => {
    if (!repoId || !selectedRepoIsGit || !canPrefetchSelectedRepoWorkItems) {
      return
    }
    void prefetchWorktreeCreateBase(repoId, baseBranch)
  }, [
    baseBranch,
    canPrefetchSelectedRepoWorkItems,
    prefetchSshConnectedGeneration,
    prefetchWorktreeCreateBase,
    repoId,
    selectedRepoIsGit
  ])
  useEffect(() => {
    if (!selectedRepoIsGit || !selectedRepo?.path || !canPrefetchSelectedRepoWorkItems) {
      return
    }
    prefetchWorkItems(selectedRepo.id, selectedRepo.path, PER_REPO_FETCH_LIMIT, 'is:pr is:open')
  }, [
    canPrefetchSelectedRepoWorkItems,
    prefetchSshConnectedGeneration,
    prefetchWorkItems,
    selectedRepo?.id,
    selectedRepo?.path,
    selectedRepoIsGit
  ])

  // Reset setup decision when config / policy changes.
  useEffect(() => {
    if (shouldWaitForSetupCheck) {
      setSetupDecision(null)
      return
    }
    if (!setupConfig) {
      setSetupDecision(null)
      return
    }
    if (setupPolicy === 'ask') {
      setSetupDecision(null)
      return
    }
    setSetupDecision(setupPolicy === 'run-by-default' ? 'run' : 'skip')
  }, [setupConfig, setupPolicy, shouldWaitForSetupCheck])

  // Link popover: debounce + load recent items + resolve direct number.
  useEffect(() => {
    const timeout = window.setTimeout(() => setLinkDebouncedQuery(linkQuery), 250)
    return () => window.clearTimeout(timeout)
  }, [linkQuery])

  useEffect(() => {
    if (!linkPopoverOpen || !selectedRepo || !selectedRepoIsGit) {
      return
    }

    let cancelled = false
    setLinkItemsLoading(true)

    const lookupRepoId = selectedRepo.id
    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, repoId: selectedRepo.id, limit: 100 })
      .then((envelope) => {
        if (!cancelled) {
          // Why: IPC omits repoId — stamp it from the queried repo below; cast through unknown since spreading the discriminated union loses the discriminant.
          // Why: the @-mention popover deliberately shows no error banner (it would crowd the input and the user sees it on the Tasks page); log to devtools instead.
          if (envelope.errors?.issues) {
            console.warn(
              '[composer/link] issues-side partial failure in @-mention popover:',
              envelope.errors.issues
            )
          }
          setLinkItems(
            envelope.items.map((it) => ({
              ...it,
              repoId: lookupRepoId
            })) as unknown as GitHubWorkItem[]
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkItems([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkItemsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [linkPopoverOpen, selectedRepo, selectedRepoIsGit])

  useEffect(() => {
    if (
      !linkPopoverOpen ||
      !selectedRepo ||
      !selectedRepoIsGit ||
      normalizedLinkQuery.directNumber === null
    ) {
      setLinkDirectItem(null)
      setLinkDirectLoading(false)
      return
    }

    let cancelled = false
    setLinkDirectLoading(true)
    // Why: a full URL carries issue-vs-PR intent, so preserve the URL route instead of probing by number only.
    const lookupRepoId = selectedRepo.id
    const lookup =
      normalizedLinkQuery.directLink !== undefined
        ? lookupGitHubWorkItemByOwnerRepoForSource({
            repoPath: selectedRepo.path,
            repoId: selectedRepo.id,
            sourceContext: selectedRepoGitHubSourceContext,
            owner: normalizedLinkQuery.directLink.slug.owner,
            repo: normalizedLinkQuery.directLink.slug.repo,
            ...(normalizedLinkQuery.directLink.slug.host
              ? { host: normalizedLinkQuery.directLink.slug.host }
              : {}),
            number: normalizedLinkQuery.directLink.number,
            type: normalizedLinkQuery.directLink.type
          })
        : lookupGitHubWorkItemForSource({
            repoPath: selectedRepo.path,
            repoId: selectedRepo.id,
            sourceContext: selectedRepoGitHubSourceContext,
            number: normalizedLinkQuery.directNumber
          })
    void lookup
      .then((item) => {
        if (!cancelled) {
          setLinkDirectItem(
            item ? ({ ...item, repoId: lookupRepoId } as unknown as GitHubWorkItem) : null
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkDirectItem(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkDirectLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    normalizedLinkQuery.directLink,
    linkPopoverOpen,
    normalizedLinkQuery.directNumber,
    selectedRepo,
    selectedRepoGitHubSourceContext,
    selectedRepoIsGit
  ])

  const applyLinkedWorkItem = useCallback(
    (item: GitHubWorkItem, options: { preserveBranchNameOverride?: boolean } = {}): void => {
      const identity = resolveGitHubWorkItemIdentity(item)
      const normalizedItem: GitHubWorkItem = {
        ...item,
        type: identity.type,
        number: identity.number
      }
      if (identity.type === 'issue') {
        setLinkedIssue(String(identity.number))
        setLinkedPR(null)
      } else {
        setLinkedIssue('')
        setLinkedPR(identity.number)
      }
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      setLinkedWorkItem({
        type: identity.type,
        provider: 'github',
        number: identity.number,
        title: item.title,
        url: item.url
      })
      const suggestedName =
        getLinkedWorkItemWorkspaceName(normalizedItem)?.seedName ??
        getLinkedWorkItemSuggestedName(normalizedItem)
      // Why: a pasted URL/#123 is the lookup query, not a chosen name — replace with the title-derived name or it becomes a slugified-URL workspace name.
      if (
        suggestedName &&
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current
        })
      ) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
      if (!options.preserveBranchNameOverride) {
        setBranchNameOverride(undefined)
        setBranchNameOverridePreservesNameEdits(false)
        branchAutoNameRef.current = ''
      }
    },
    [name]
  )

  const resolvePendingSmartGitHubSubmit =
    useCallback(async (): Promise<PendingSmartGitHubSubmitResolution> => {
      if (linkedWorkItem) {
        const startPointSelection = smartGitHubPrStartPointSelectionRef.current
        const linkedWorkItemIdentity = getGitHubLinkedWorkItemIdentity(linkedWorkItem)
        const startPointIdentity = startPointSelection
          ? resolveGitHubWorkItemIdentity(startPointSelection.item)
          : null
        if (
          !isProjectGroupTarget &&
          linkedWorkItemIdentity?.type === 'pr' &&
          startPointIdentity?.type === 'pr' &&
          getLinkedWorkItemProvider(linkedWorkItem) === 'github' &&
          selectedRepo &&
          selectedRepoIsGit &&
          startPointSelection?.repoId === selectedRepo.id &&
          startPointIdentity.number === linkedWorkItemIdentity.number
        ) {
          const selectedPrStartPoint =
            startPointSelection.resolved ??
            (await resolveGitHubPrStartPointForRepo({
              repoId: selectedRepo.id,
              prNumber: startPointIdentity.number,
              settings: getSettingsForRepoRuntimeOwner(
                { repos: [selectedRepo], settings },
                selectedRepo.id
              ),
              ...(startPointSelection.item.branchName
                ? { headRefName: startPointSelection.item.branchName }
                : {}),
              ...(startPointSelection.item.baseRefName
                ? { baseRefName: startPointSelection.item.baseRefName }
                : {}),
              ...(startPointSelection.item.isCrossRepository !== undefined
                ? { isCrossRepository: startPointSelection.item.isCrossRepository }
                : {})
            }))
          startPointSelection.resolved = selectedPrStartPoint
          const smartGitHubMetadata = getSmartGitHubSubmitResolution(startPointSelection.item)
          const resolution: Exclude<PendingSmartGitHubSubmitResolution, { kind: 'none' }> = {
            ...smartGitHubMetadata,
            kind: 'pr-start-point',
            baseBranch: selectedPrStartPoint.baseBranch,
            ...(selectedPrStartPoint.compareBaseRef
              ? { compareBaseRef: selectedPrStartPoint.compareBaseRef }
              : {}),
            ...(selectedPrStartPoint.pushTarget
              ? { pushTarget: selectedPrStartPoint.pushTarget }
              : {}),
            ...(selectedPrStartPoint.branchNameOverride
              ? { branchNameOverride: selectedPrStartPoint.branchNameOverride }
              : {})
          }
          setBaseBranch(selectedPrStartPoint.baseBranch)
          setCompareBaseRef(selectedPrStartPoint.compareBaseRef)
          setPushTarget(selectedPrStartPoint.pushTarget)
          if (selectedPrStartPoint.branchNameOverride) {
            setBranchNameOverride(selectedPrStartPoint.branchNameOverride)
            setBranchNameOverridePreservesNameEdits(true)
          } else {
            setBranchNameOverride(undefined)
            setBranchNameOverridePreservesNameEdits(false)
          }
          setForkPushWarning(getForkPushWarning(selectedPrStartPoint))
          return resolution
        }
        return { kind: 'none' }
      }

      const intent = getSmartGitHubSubmitIntent(name)
      if (!intent) {
        return { kind: 'none' }
      }

      const item = isProjectGroupTarget
        ? (
            await Promise.all(
              folderSourceRepos.filter(isGitRepoKind).map((repo) =>
                lookupSmartGitHubSubmitItem({
                  repoPath: repo.path,
                  repoId: repo.id,
                  sourceContext: buildTaskSourceContextFromRepo({
                    provider: 'github',
                    projectId: repo.id,
                    repo
                  }),
                  intent,
                  workItem: lookupGitHubWorkItemForSource,
                  workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
                }).catch(() => null)
              )
            )
          )
            .filter((candidate): candidate is GitHubWorkItem => candidate !== null)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
        : selectedRepo && selectedRepoIsGit
          ? await lookupSmartGitHubSubmitItem({
              repoPath: selectedRepo.path,
              repoId: selectedRepo.id,
              sourceContext: selectedRepoGitHubSourceContext,
              intent,
              workItem: lookupGitHubWorkItemForSource,
              workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
            })
          : null
      if (!item) {
        throw new Error('Could not resolve the GitHub item before creating the workspace.')
      }

      const itemIdentity = resolveGitHubWorkItemIdentity(item)
      const prStartPoint =
        !isProjectGroupTarget && itemIdentity.type === 'pr' && selectedRepo && selectedRepoIsGit
          ? await resolveGitHubPrStartPointForRepo({
              repoId: selectedRepo.id,
              prNumber: itemIdentity.number,
              settings: getSettingsForRepoRuntimeOwner(
                { repos: [selectedRepo], settings },
                selectedRepo.id
              ),
              ...(item.branchName ? { headRefName: item.branchName } : {}),
              ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
              ...(item.isCrossRepository !== undefined
                ? { isCrossRepository: item.isCrossRepository }
                : {})
            })
          : null
      const smartGitHubMetadata = getSmartGitHubSubmitResolution(item)
      const resolution: Exclude<PendingSmartGitHubSubmitResolution, { kind: 'none' }> = prStartPoint
        ? {
            ...smartGitHubMetadata,
            kind: 'pr-start-point',
            baseBranch: prStartPoint.baseBranch,
            ...(prStartPoint.compareBaseRef ? { compareBaseRef: prStartPoint.compareBaseRef } : {}),
            ...(prStartPoint.pushTarget ? { pushTarget: prStartPoint.pushTarget } : {}),
            ...(prStartPoint.branchNameOverride
              ? { branchNameOverride: prStartPoint.branchNameOverride }
              : {})
          }
        : {
            ...smartGitHubMetadata,
            kind: 'metadata-only'
          }
      // Why: Create can fire before the debounced smart field commits; commit the resolved item here so the form shows the title, not the raw URL.
      setLinkedIssue(
        resolution.linkedIssueNumber !== null ? String(resolution.linkedIssueNumber) : ''
      )
      setLinkedPR(resolution.linkedPR)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      setLinkedWorkItem(resolution.linkedWorkItem)
      setName(resolution.workspaceName)
      lastAutoNameRef.current = resolution.workspaceName
      if (prStartPoint) {
        setBaseBranch(prStartPoint.baseBranch)
        setCompareBaseRef(prStartPoint.compareBaseRef)
        setPushTarget(prStartPoint.pushTarget)
        if (prStartPoint.branchNameOverride) {
          setBranchNameOverride(prStartPoint.branchNameOverride)
          setBranchNameOverridePreservesNameEdits(true)
        } else {
          setBranchNameOverride(undefined)
          setBranchNameOverridePreservesNameEdits(false)
        }
        setForkPushWarning(getForkPushWarning(prStartPoint))
      } else {
        setBranchNameOverride(undefined)
        setBranchNameOverridePreservesNameEdits(false)
      }
      branchAutoNameRef.current = ''
      setStartFromResetHint(null)
      return resolution
    }, [
      folderSourceRepos,
      isProjectGroupTarget,
      linkedWorkItem,
      name,
      selectedRepo,
      selectedRepoGitHubSourceContext,
      selectedRepoIsGit,
      settings
    ])

  // Why: review routing prefers one provider identity — clear the opposite provider slots so stale hidden fields can't win later.
  const applyLinkedGitLabWorkItem = useCallback(
    (item: GitLabWorkItem): void => {
      smartGitHubPrStartPointSelectionRef.current = null
      if (item.type === 'issue') {
        setLinkedGitLabIssue(item.number)
        setLinkedGitLabMR(null)
      } else {
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(item.number)
      }
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedWorkItem({
        type: item.type,
        provider: 'gitlab',
        number: item.number,
        title: item.title,
        url: item.url
      })
      // Why: GitLabWorkItem.branchName lines up structurally with GitHubWorkItem's; cast to reuse the naming heuristic without forking it.
      const suggestedName = getLinkedWorkItemSuggestedName({
        type: item.type === 'mr' ? 'pr' : 'issue',
        number: item.number,
        title: item.title,
        branchName: item.branchName
      } as unknown as GitHubWorkItem)
      const titleName = getLinkedWorkItemWorkspaceName({
        type: item.type,
        provider: 'gitlab',
        number: item.number,
        title: item.title
      })
      const nextName = titleName?.seedName ?? suggestedName
      if (
        nextName &&
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current
        })
      ) {
        setName(nextName)
        lastAutoNameRef.current = nextName
      }
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      branchAutoNameRef.current = ''
    },
    [name]
  )

  const handleSelectLinkedItem = useCallback(
    (item: GitHubWorkItem): void => {
      smartGitHubPrStartPointSelectionRef.current = null
      applyLinkedWorkItem(item)
      setLinkPopoverOpen(false)
      setLinkQuery('')
      setLinkDebouncedQuery('')
      setLinkDirectItem(null)
    },
    [applyLinkedWorkItem]
  )

  const handleLinkPopoverChange = useCallback((open: boolean): void => {
    setLinkPopoverOpen(open)
    if (!open) {
      setLinkQuery('')
      setLinkDebouncedQuery('')
      setLinkDirectItem(null)
    }
  }, [])

  const handleRemoveLinkedWorkItem = useCallback((): void => {
    smartGitHubPrStartPointSelectionRef.current = null
    const removedLinearItem = isLinearLinkedWorkItem(linkedWorkItem)
    setLinkedWorkItem(null)
    setLinkedIssue('')
    setLinkedPR(null)
    setForkPushWarning(null)
    if (name === lastAutoNameRef.current) {
      lastAutoNameRef.current = ''
    }
    if (removedLinearItem) {
      // Why: a Linear branch override belongs to its issue; unlinking must not leave it driving a later worktree create.
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      branchAutoNameRef.current = ''
    }
  }, [linkedWorkItem, name])

  const handleNameValueChange = useCallback(
    (nextName: string): void => {
      // Why: linked items keep refreshing the suggested name only while it's auto-managed; a manual edit stops later picks from clobbering it until cleared.
      if (!nextName.trim()) {
        lastAutoNameRef.current = ''
      } else if (name !== lastAutoNameRef.current) {
        lastAutoNameRef.current = ''
      }
      if (
        branchNameOverride &&
        !branchNameOverridePreservesNameEdits &&
        nextName !== branchAutoNameRef.current
      ) {
        setBranchNameOverride(undefined)
        branchAutoNameRef.current = ''
      }
      setName(nextName)
      setCreateError(null)
    },
    [branchNameOverride, branchNameOverridePreservesNameEdits, name]
  )
  const handleBranchNameOverrideChange = useCallback(
    (value: string | undefined): void => {
      const next = resolveComposerManualBranchNameChange({
        value,
        pushTarget,
        forkPushWarning
      })
      setBranchNameOverride(next.branchNameOverride)
      setBranchNameOverridePreservesNameEdits(Boolean(next.branchNameOverride))
      setPushTarget(next.pushTarget)
      setForkPushWarning(next.forkPushWarning)
      setReuseEligibleBranch(null)
      setReuseSelectedBranch(false)
      branchAutoNameRef.current = ''
    },
    [forkPushWarning, pushTarget]
  )

  const addComposerAttachments = useCallback((paths: string[]): void => {
    if (paths.length === 0) {
      return
    }
    setAttachmentPaths((current) => {
      const next = [...current]
      for (const pathValue of paths) {
        if (!next.includes(pathValue)) {
          next.push(pathValue)
        }
      }
      return next
    })
  }, [])

  const insertComposerFolderPaths = useCallback(
    (folderPaths: string[]): void => {
      if (folderPaths.length === 0) {
        return
      }
      // Why: de-dup within one drop — the OS can deliver the same folder twice when the selection includes an item and its parent.
      const uniqueFolderPaths = Array.from(new Set(folderPaths))
      // Why: quote paths with shell metacharacters so an inserted folder ref stays one token if pasted into a terminal; simple paths stay unadorned.
      const formatPath = (p: string): string => {
        if (/[\s"'$`\\()[\]{}*?!;&|<>#~]/.test(p)) {
          return `"${p.replace(/(["\\$`])/g, '\\$1')}"`
        }
        return p
      }
      const insertion = uniqueFolderPaths.map(formatPath).join(' ')
      const textarea = promptTextareaRef.current
      // Why: compute selection/insertion/caret outside the setAgentPrompt updater so it stays pure — Strict Mode double-invokes updaters in dev.
      const current = agentPromptRef.current
      const selStart = textarea?.selectionStart ?? current.length
      const selEnd = textarea?.selectionEnd ?? current.length
      const before = current.slice(0, selStart)
      const after = current.slice(selEnd)
      // Why: pad with spaces when the caret abuts text so the folder path doesn't merge into an adjacent word.
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
      const needsTrailingSpace = after.length > 0 && !/^\s/.test(after)
      const padded = `${needsLeadingSpace ? ' ' : ''}${insertion}${needsTrailingSpace ? ' ' : ''}`
      const caret = before.length + padded.length
      if (textarea) {
        cancelPromptCaretFrame()
        promptCaretFrameRef.current = requestAnimationFrame(() => {
          promptCaretFrameRef.current = null
          if (promptTextareaRef.current !== textarea || !textarea.isConnected) {
            return
          }
          textarea.focus()
          textarea.setSelectionRange(caret, caret)
        })
      }
      // Why: pass a plain value (not an updater) since before/after were already resolved, keeping the write pure under Strict-Mode double-render.
      setAgentPrompt(before + padded + after)
    },
    [cancelPromptCaretFrame]
  )

  const uploadComposerPaths = useCallback(
    async (
      sourcePaths: string[],
      targetSettings = selectedRepoSettings,
      targetConnectionId = connectionId,
      targetRepoPath = selectedRepoPath,
      canReportFailure: () => boolean = () => true
    ): Promise<{ filePaths: string[]; folderPaths: string[] } | null> => {
      if (!targetSettings?.activeRuntimeEnvironmentId?.trim() && !targetConnectionId) {
        return null
      }
      if (!targetRepoPath) {
        if (canReportFailure()) {
          toast.error(
            translate(
              'auto.hooks.useComposerState.3db83fc58a',
              'No project path is available on this host for attachments.'
            )
          )
        }
        return { filePaths: [], folderPaths: [] }
      }
      const destinationDir = joinPath(targetRepoPath, '.orca/drops')
      const sshExpectation = targetConnectionId
        ? captureDirectSshMutationExpectation(
            useAppStore.getState(),
            targetConnectionId,
            targetSettings?.activeRuntimeEnvironmentId
          )
        : {
            expectedExecutionHostId: 'local' as const,
            expectedSshTargetId: undefined,
            expectedSshConnectionGeneration: undefined
          }
      const assertCurrent = targetConnectionId
        ? () => {
            const current = captureDirectSshMutationExpectation(
              useAppStore.getState(),
              targetConnectionId,
              targetSettings?.activeRuntimeEnvironmentId
            )
            if (
              current.expectedSshTargetId !== sshExpectation.expectedSshTargetId ||
              current.expectedSshConnectionGeneration !==
                sshExpectation.expectedSshConnectionGeneration
            ) {
              throw new Error('Attachment upload host changed; retry the upload.')
            }
          }
        : undefined
      const { results } = await importExternalPathsToRuntime(
        {
          settings: targetSettings,
          worktreeId: targetRepoPath,
          worktreePath: targetRepoPath,
          connectionId: targetConnectionId ?? undefined,
          ...sshExpectation
        },
        sourcePaths,
        destinationDir,
        { ensureDestinationDir: true, assertCurrent }
      )
      const uploadResult = collectComposerDropUploadResult(results)
      if (shouldReportComposerDropUploadFailure(uploadResult, canReportFailure)) {
        toast.error(
          translate(
            'auto.hooks.useComposerState.a9ff236145',
            'Some attachments could not be uploaded.'
          )
        )
      }
      return { filePaths: uploadResult.filePaths, folderPaths: uploadResult.folderPaths }
    },
    [connectionId, selectedRepoPath, selectedRepoSettings]
  )

  const handleAddAttachment = useCallback(async (): Promise<void> => {
    try {
      const selectedPath = await window.api.shell.pickAttachment()
      if (!selectedPath) {
        return
      }
      const uploaded = await uploadComposerPaths([selectedPath])
      if (uploaded) {
        addComposerAttachments(uploaded.filePaths)
        insertComposerFolderPaths(uploaded.folderPaths)
        return
      }
      addComposerAttachments([selectedPath])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add attachment.'
      toast.error(message)
    }
  }, [addComposerAttachments, insertComposerFolderPaths, uploadComposerPaths])

  const applyLocalComposerDrop = useCallback(
    async (paths: string[], canApply: () => boolean = () => true): Promise<void> => {
      const fileAttachments: string[] = []
      const folderPaths: string[] = []
      for (const filePath of paths) {
        try {
          await window.api.fs.authorizeExternalPath({ targetPath: filePath })
          const stat = await window.api.fs.stat({ filePath })
          if (stat.isDirectory) {
            folderPaths.push(filePath)
          } else {
            fileAttachments.push(filePath)
          }
        } catch {
          // Skip paths we cannot authorize or stat.
        }
      }

      if (!canApply()) {
        return
      }
      addComposerAttachments(fileAttachments)
      insertComposerFolderPaths(folderPaths)
    },
    [addComposerAttachments, insertComposerFolderPaths]
  )
  const addComposerAttachmentsRef = useRef(addComposerAttachments)
  addComposerAttachmentsRef.current = addComposerAttachments
  const insertComposerFolderPathsRef = useRef(insertComposerFolderPaths)
  insertComposerFolderPathsRef.current = insertComposerFolderPaths
  const uploadComposerPathsRef = useRef(uploadComposerPaths)
  uploadComposerPathsRef.current = uploadComposerPaths
  const applyLocalComposerDropRef = useRef(applyLocalComposerDrop)
  applyLocalComposerDropRef.current = applyLocalComposerDrop

  // Why: native OS file drops relay via the preload bridge; files become attachments, folders paste inline at the caret since a path can't be embedded as file content.
  const instanceIdRef = useRef<symbol>(Symbol('composer'))
  useEffect(() => {
    const instanceId = instanceIdRef.current
    composerDropStack.push(instanceId)
    const unsubscribe = window.api.ui.onFileDrop((data) => {
      if (data.target !== 'composer') {
        return
      }
      // Why: only the top-of-stack composer owns the drop; earlier subscribers short-circuit so page+modal don't double-apply it.
      if (!isCurrentComposerDropOwner(composerDropStack, instanceId)) {
        return
      }
      const isStillDropOwner = (): boolean =>
        isCurrentComposerDropOwner(composerDropStack, instanceId)
      void applyComposerNativeFileDrop({
        paths: data.paths,
        isCurrentOwner: isStillDropOwner,
        uploadPaths: (paths) =>
          uploadComposerPathsRef.current(
            paths,
            selectedRepoSettingsRef.current,
            connectionIdRef.current,
            selectedRepoPathRef.current,
            isStillDropOwner
          ),
        applyLocalPaths: applyLocalComposerDropRef.current,
        addAttachments: addComposerAttachmentsRef.current,
        insertFolderPaths: insertComposerFolderPathsRef.current,
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : 'Failed to drop files.')
      })
    })
    return () => {
      unsubscribe()
      const idx = composerDropStack.lastIndexOf(instanceId)
      if (idx !== -1) {
        composerDropStack.splice(idx, 1)
      }
    }
  }, [])

  const handleRepoChange = useCallback(
    (
      value: string,
      options: { preserveStartFrom?: boolean; forceResetStartFrom?: boolean } = {}
    ): void => {
      setProjectError(null)
      if (value === repoId && !options.forceResetStartFrom) {
        setRepoId(value)
        return
      }
      // Why: capture a descriptor of the prior Start-from selection so the field can show an inline reset (e.g. "was PR #8778") after it's wiped.
      let hint: string | null = null
      if (!options.preserveStartFrom) {
        if (linkedWorkItem?.type === 'pr' && baseBranch) {
          hint = `was PR #${linkedWorkItem.number}`
        } else if (linkedWorkItem?.type === 'mr' && baseBranch) {
          // Why: GitLab MR convention is `!N`, not `#N` — match the upstream UI so the hint is recognizable.
          hint = `was MR !${linkedWorkItem.number}`
        } else if (baseBranch) {
          hint = `was ${baseBranch}`
        }
      }
      const preserveLinearLinkedWorkItem = isLinearLinkedWorkItem(linkedWorkItem)
      const preservedLinearBranchName = preserveLinearLinkedWorkItem
        ? getLinearLinkedWorkItemBranchName(linkedWorkItem)
        : undefined
      setRepoId(value)
      if (!options.preserveStartFrom) {
        smartGitHubPrStartPointSelectionRef.current = null
        setLinkedIssue('')
        setLinkedPR(null)
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(null)
        // Why: a repo change invalidates repo-scoped sources, but Linear and
        // Jira issues are workspace-scoped and must survive choosing the
        // implementation project — not just Linear.
        if (linkedWorkItem && !shouldPreserveWorkspaceSourceOnRepoChange(linkedWorkItem)) {
          setLinkedWorkItem(null)
        }
      }
      setSparseEnabled(false)
      setSparseDirectories('')
      // Why: presets are repo-scoped, so a prior-repo selection is meaningless after a switch.
      setSparseSelectedPresetId(null)
      // Why: Start-from is repo-scoped; reset to undefined so the field falls back to the new repo's effective base ref.
      if (!options.preserveStartFrom) {
        setBaseBranch(undefined)
        setCompareBaseRef(undefined)
        setPushTarget(undefined)
        // Why: Linear sources are workspace-scoped, so their canonical branch survives choosing a different implementation repo.
        setBranchNameOverride(preservedLinearBranchName)
        setBranchNameOverridePreservesNameEdits(Boolean(preservedLinearBranchName))
        branchAutoNameRef.current = preservedLinearBranchName ?? ''
        // Why (#5181): reuse state is branch-scoped, so a repo switch clears it even when a workspace-scoped Linear override is restored.
        setReuseEligibleBranch(null)
        setReuseSelectedBranch(false)
        setForkPushWarning(null)
        setStartFromResetHint(hint)
      }
    },
    [baseBranch, linkedWorkItem, repoId, setRepoId]
  )
  const handleFolderSourceRepoChange = useCallback(
    (value: string): void => {
      if (!folderSourceRepos.some((repo) => repo.id === value)) {
        return
      }
      setRepoId(value)
      smartGitHubPrStartPointSelectionRef.current = null
      setLinkedWorkItem((current) =>
        current && !shouldPreserveWorkspaceSourceOnRepoChange(current) ? null : current
      )
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
    },
    [folderSourceRepos, setRepoId]
  )
  const handleProjectHostSetupChange = useCallback(
    (setupId: string): void => {
      const option = projectHostSetupOptions.find((candidate) => candidate.id === setupId)
      if (!option || option.kind !== 'ready') {
        return
      }
      // Why: switching run host for the same project must not erase the task/PR source the user is starting from.
      handleRepoChange(option.repoId, { preserveStartFrom: true })
    },
    [handleRepoChange, projectHostSetupOptions]
  )
  const handleProjectChange = useCallback(
    (projectId: string): void => {
      initialProjectGroupAppliedRef.current = true
      const projectGroupId = getProjectGroupIdFromNewWorkspaceOptionId(projectId)
      if (projectGroupId) {
        const nextProjectGroup = projectGroups.find(
          (group) => group.id === projectGroupId && Boolean(group.parentPath?.trim())
        )
        if (!nextProjectGroup) {
          setSelectedProjectGroupId(null)
          setProjectError(
            translate(
              'auto.hooks.useComposerState.chooseOrAddProjectBeforeWorkspace',
              'Choose or add a project before creating a workspace.'
            )
          )
          return
        }
        const nextSourceRepo = getFolderSourceRepos(repos, projectGroups, nextProjectGroup)[0]
        setSelectedProjectGroupId(nextProjectGroup.id)
        setProjectError(null)
        setRepoId(nextSourceRepo?.id ?? '')
        setLinkedIssue('')
        setLinkedPR(null)
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(null)
        if (linkedWorkItem && !shouldPreserveWorkspaceSourceOnRepoChange(linkedWorkItem)) {
          setLinkedWorkItem(null)
        }
        setSparseEnabled(false)
        setSparseDirectories('')
        setSparseSelectedPresetId(null)
        setBaseBranch(undefined)
        setPushTarget(undefined)
        setBranchNameOverride(undefined)
        // Why (#5181): clear branch-scoped reuse state on a project switch too.
        setBranchNameOverridePreservesNameEdits(false)
        setReuseEligibleBranch(null)
        setReuseSelectedBranch(false)
        setForkPushWarning(null)
        setStartFromResetHint(null)
        return
      }

      setSelectedProjectGroupId(null)
      const preferredHostId =
        selectedWorkspaceTarget.status === 'ready' ? selectedWorkspaceTarget.target.hostId : null
      // Why: pass the current host as a preference (focusedHostScope), not a hard hostId — pinning made selecting a project set up only on another host a silent no-op.
      const nextRepoId = resolveWorkspaceCreationRepoId({
        eligibleRepos,
        projects,
        projectHostSetups,
        projectId,
        focusedHostScope: preferredHostId ?? workspaceHostScope
      })
      if (!nextRepoId) {
        return
      }
      handleRepoChange(nextRepoId, { forceResetStartFrom: isProjectGroupTarget })
    },
    [
      eligibleRepos,
      handleRepoChange,
      isProjectGroupTarget,
      linkedWorkItem,
      projectGroups,
      projectHostSetups,
      projects,
      repos,
      setRepoId,
      selectedWorkspaceTarget,
      workspaceHostScope
    ]
  )
  const selectAddedProjectRepo = useCallback(
    (nextRepoId: string): void => {
      // Why: clear the folder-group target when selecting the Add-Project repo, since the group's onRepoChange only accepts repos inside the group.
      initialProjectGroupAppliedRef.current = true
      setSelectedProjectGroupId(null)
      setProjectError(null)
      handleRepoChange(nextRepoId)
    },
    [handleRepoChange]
  )

  const showProjectRequiredError = useCallback((): void => {
    setProjectError('Choose or add a project before creating a workspace.')
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '[data-contextual-tour-target="workspace-creation-project"] [data-project-combobox-root="true"][role="combobox"]'
        )
        ?.focus()
    })
  }, [])

  const handleSparseSelectPreset = useCallback((preset: SparsePreset | null): void => {
    if (preset) {
      setSparseEnabled(true)
      setSparseDirectories(preset.directories.join('\n'))
      setSparseSelectedPresetId(preset.id)
    } else {
      setSparseEnabled(false)
      setSparseDirectories('')
      setSparseSelectedPresetId(null)
    }
  }, [])

  const handleBaseBranchChange = useCallback((next: string | undefined): void => {
    smartGitHubPrStartPointSelectionRef.current = null
    setBaseBranch(next)
    setCompareBaseRef(undefined)
    setPushTarget(undefined)
    setBranchNameOverride(undefined)
    // Why (#5181): Start-from means "new branch from this base", so it never reuses — clear reuse state from a prior smart-field branch pick.
    setBranchNameOverridePreservesNameEdits(false)
    setReuseEligibleBranch(null)
    setReuseSelectedBranch(false)
    setForkPushWarning(null)
    branchAutoNameRef.current = ''
    setStartFromResetHint(null)
  }, [])

  const handleBaseBranchPrSelect = useCallback(
    (
      nextBaseBranch: string,
      item: GitHubWorkItem,
      nextPushTarget?: GitPushTarget,
      nextBranchNameOverride?: string,
      nextCompareBaseRef?: string
    ): void => {
      setBaseBranch(nextBaseBranch)
      setCompareBaseRef(nextCompareBaseRef)
      setPushTarget(nextPushTarget)
      setBranchNameOverride(nextBranchNameOverride)
      setBranchNameOverridePreservesNameEdits(Boolean(nextBranchNameOverride))
      branchAutoNameRef.current = ''
      setStartFromResetHint(null)
      // Why: a Start-from PR pick is also a linkedWorkItem assignment; reuse applyLinkedWorkItem so auto-name and linkedPR stay one code path.
      applyLinkedWorkItem(item, { preserveBranchNameOverride: Boolean(nextBranchNameOverride) })
      // Why: prefill the note from the PR (only when empty or still an auto-fill) so the sidebar surfaces it without clobbering user text.
      const identity = resolveGitHubWorkItemIdentity(item)
      if (identity.type === 'pr') {
        const suggestedNote = `PR #${identity.number} — ${item.title}`
        const currentNote = noteRef.current
        if (!currentNote.trim() || currentNote === lastAutoNoteRef.current) {
          setNote(suggestedNote)
          lastAutoNoteRef.current = suggestedNote
        }
      }
    },
    [applyLinkedWorkItem]
  )

  // Why: GitLab parallel of handleBaseBranchPrSelect; note prefill uses GitLab's `!N` MR convention so the sidebar makes the provider obvious.
  const handleBaseBranchMrSelect = useCallback(
    (
      nextBaseBranch: string,
      item: GitLabWorkItem,
      nextPushTarget?: GitPushTarget,
      nextCompareBaseRef?: string
    ): void => {
      setBaseBranch(nextBaseBranch)
      setCompareBaseRef(nextCompareBaseRef)
      setPushTarget(nextPushTarget)
      setBranchNameOverride(undefined)
      branchAutoNameRef.current = ''
      setStartFromResetHint(null)
      applyLinkedGitLabWorkItem(item)
      if (item.type === 'mr') {
        const suggestedNote = `MR !${item.number} — ${item.title}`
        const currentNote = noteRef.current
        if (!currentNote.trim() || currentNote === lastAutoNoteRef.current) {
          setNote(suggestedNote)
          lastAutoNoteRef.current = suggestedNote
        }
      }
    },
    [applyLinkedGitLabWorkItem]
  )

  const handleSmartGitHubItemSelect = useCallback(
    (item: GitHubWorkItem): void => {
      const identity = resolveGitHubWorkItemIdentity(item)
      const normalizedItem: GitHubWorkItem = {
        ...item,
        type: identity.type,
        number: identity.number
      }
      if (isProjectGroupTarget) {
        const linkedItem = toGitHubLinkedWorkItem(normalizedItem)
        setLinkedIssue(identity.type === 'issue' ? String(identity.number) : '')
        setLinkedPR(identity.type === 'pr' ? identity.number : null)
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(null)
        setLinkedWorkItem(linkedItem)
        const nextName = getLinkedItemDisplayName(linkedItem)
        if (
          nextName &&
          shouldApplyWorkspaceSourceAutoName({
            currentName: name,
            lastAutoName: lastAutoNameRef.current
          })
        ) {
          setName(nextName)
          lastAutoNameRef.current = nextName
        }
        return
      }
      setStartFromResetHint(null)
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      setForkPushWarning(null)
      branchAutoNameRef.current = ''
      smartGitHubPrStartPointSelectionRef.current = null
      // Why: provider items can come from a different source host than the run host — resolve refs against the run repo, keep item metadata for provider identity.
      const runRepo = selectedRepo ?? eligibleRepos.find((repo) => repo.id === item.repoId)
      applyLinkedWorkItem(normalizedItem)
      if (identity.type !== 'pr' || !runRepo) {
        setBaseBranch(undefined)
        setCompareBaseRef(undefined)
        setPushTarget(undefined)
        return
      }
      setBaseBranch(undefined)
      setCompareBaseRef(undefined)
      setPushTarget(undefined)
      const startPointSelection: SmartGitHubPrStartPointSelection = {
        repoId: runRepo.id,
        item: normalizedItem
      }
      smartGitHubPrStartPointSelectionRef.current = startPointSelection
      const itemRepoSettings = getSettingsForRepoRuntimeOwner(
        { repos: [runRepo], settings },
        runRepo.id
      )
      const resolvePrBase = resolveGitHubPrStartPointForRepo({
        repoId: runRepo.id,
        prNumber: identity.number,
        settings: itemRepoSettings,
        ...(normalizedItem.branchName ? { headRefName: normalizedItem.branchName } : {}),
        ...(normalizedItem.baseRefName ? { baseRefName: normalizedItem.baseRefName } : {}),
        ...(normalizedItem.isCrossRepository !== undefined
          ? { isCrossRepository: normalizedItem.isCrossRepository }
          : {})
      })
      void resolvePrBase
        .then((result) => {
          if (smartGitHubPrStartPointSelectionRef.current !== startPointSelection) {
            return
          }
          startPointSelection.resolved = result
          handleBaseBranchPrSelect(
            result.baseBranch,
            normalizedItem,
            result.pushTarget,
            result.branchNameOverride,
            result.compareBaseRef
          )
          // Why: a fork PR push lands on the contributor's fork; without maintainer-edits allowed GitHub rejects it, so warn up front.
          setForkPushWarning(getForkPushWarning(result))
        })
        .catch((error: unknown) => {
          if (smartGitHubPrStartPointSelectionRef.current !== startPointSelection) {
            return
          }
          setBaseBranch(undefined)
          setCompareBaseRef(undefined)
          setPushTarget(undefined)
          toast.error(
            error instanceof Error
              ? error.message
              : translate('auto.hooks.useComposerState.b2ead86962', 'Failed to resolve PR base.')
          )
        })
    },
    [
      applyLinkedWorkItem,
      eligibleRepos,
      handleBaseBranchPrSelect,
      isProjectGroupTarget,
      name,
      selectedRepo,
      settings
    ]
  )

  // Why: GitLab parallel of handleSmartGitHubItemSelect — resolves MR base via worktrees:resolveMrBase (refs/merge-requests/<iid>/head); issues short-circuit.
  const handleSmartGitLabItemSelect = useCallback(
    (item: GitLabWorkItem): void => {
      if (isProjectGroupTarget) {
        const linkedItem = toGitLabLinkedWorkItem(item)
        setLinkedGitLabIssue(item.type === 'issue' ? item.number : null)
        setLinkedGitLabMR(item.type === 'mr' ? item.number : null)
        setLinkedIssue('')
        setLinkedPR(null)
        setLinkedWorkItem(linkedItem)
        const nextName = getLinkedItemDisplayName(linkedItem)
        if (
          nextName &&
          shouldApplyWorkspaceSourceAutoName({
            currentName: name,
            lastAutoName: lastAutoNameRef.current
          })
        ) {
          setName(nextName)
          lastAutoNameRef.current = nextName
        }
        return
      }
      applyLinkedGitLabWorkItem(item)
      setStartFromResetHint(null)
      setBranchNameOverride(undefined)
      setBranchNameOverridePreservesNameEdits(false)
      setForkPushWarning(null)
      branchAutoNameRef.current = ''
      // Why: MR metadata can be sourced from one host/account while the workspace is created on another for the same logical project.
      const runRepo = selectedRepo ?? eligibleRepos.find((repo) => repo.id === item.repoId)
      if (item.type !== 'mr' || !runRepo) {
        setCompareBaseRef(undefined)
        return
      }
      setCompareBaseRef(undefined)
      const itemRepoSettings = getSettingsForRepoRuntimeOwner(
        { repos: [runRepo], settings },
        runRepo.id
      )
      const target = getActiveRuntimeTarget(itemRepoSettings)
      const resolveMrBase =
        target.kind === 'local'
          ? window.api.worktrees.resolveMrBase({
              repoId: runRepo.id,
              mrIid: item.number,
              ...(item.branchName ? { sourceBranch: item.branchName } : {}),
              ...(item.baseRefName ? { targetBranch: item.baseRefName } : {}),
              ...(item.isCrossRepository !== undefined
                ? { isCrossRepository: item.isCrossRepository }
                : {})
            })
          : callRuntimeRpc<
              | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
              | { error: string }
            >(
              target,
              'worktree.resolveMrBase',
              {
                repo: runRepo.id,
                mrIid: item.number,
                ...(item.branchName ? { sourceBranch: item.branchName } : {}),
                ...(item.baseRefName ? { targetBranch: item.baseRefName } : {}),
                ...(item.isCrossRepository !== undefined
                  ? { isCrossRepository: item.isCrossRepository }
                  : {})
              },
              { timeoutMs: 30_000 }
            )
      void resolveMrBase
        .then((result) => {
          if ('error' in result) {
            // Why: an unsurfaced failure silently falls back to the repo default branch, so clear stale base state and toast — mirrors the GitHub PR path.
            setBaseBranch(undefined)
            setCompareBaseRef(undefined)
            setPushTarget(undefined)
            toast.error(result.error)
            return
          }
          handleBaseBranchMrSelect(
            result.baseBranch,
            item,
            result.pushTarget,
            result.compareBaseRef
          )
        })
        .catch((error: unknown) => {
          setBaseBranch(undefined)
          setCompareBaseRef(undefined)
          setPushTarget(undefined)
          toast.error(
            error instanceof Error
              ? error.message
              : translate('auto.hooks.useComposerState.5f3d2c8a1b', 'Failed to resolve MR base.')
          )
        })
    },
    [
      applyLinkedGitLabWorkItem,
      eligibleRepos,
      handleBaseBranchMrSelect,
      isProjectGroupTarget,
      name,
      selectedRepo,
      settings
    ]
  )

  const handleSmartBranchSelect = useCallback(
    (refName: string, localBranchName: string): void => {
      smartGitHubPrStartPointSelectionRef.current = null
      const selection = resolveComposerBranchPick({
        refName,
        localBranchName,
        currentName: name,
        lastAutoName: lastAutoNameRef.current,
        worktreeBranches: getComposerRepoWorktreeBranches(worktreesByRepo[repoId] ?? [], repoId)
      })
      setBaseBranch(selection.baseBranch)
      setCompareBaseRef(undefined)
      setPushTarget(undefined)
      setStartFromResetHint(null)
      setForkPushWarning(null)
      // Why (#5181): reuse (check out) an existing branch instead of branching off it; git allows a branch in only one worktree, so gate eligibility on that.
      // Note: worktreesByRepo covers only visible worktrees; a branch busy in a hidden external worktree falls through to the backend "already exists locally" check.
      const { reuseEligibleBranch: nextReuseEligibleBranch, defaultReuse } = selection
      setReuseEligibleBranch(nextReuseEligibleBranch)
      setReuseSelectedBranch(defaultReuse)
      setBranchNameOverridePreservesNameEdits(defaultReuse)
      if (selection.name !== undefined && selection.lastAutoName !== undefined) {
        setName(selection.name)
        lastAutoNameRef.current = selection.lastAutoName
        branchAutoNameRef.current = selection.branchNameOverride ? selection.branchAutoName : ''
        setBranchNameOverride(selection.branchNameOverride)
      } else {
        setBranchNameOverride(selection.branchNameOverride)
        branchAutoNameRef.current = selection.branchNameOverride ? selection.branchAutoName : ''
      }
    },
    [name, worktreesByRepo, repoId]
  )

  const handleReuseSelectedBranchChange = useCallback(
    (next: boolean): void => {
      if (!reuseEligibleBranch) {
        return
      }
      setReuseSelectedBranch(next)
      // Why (#5181): reuse pins the existing branch as override (preserved across name edits); opting out drops it so a fresh branch is created from the ref.
      setBranchNameOverridePreservesNameEdits(next)
      setBranchNameOverride(next ? reuseEligibleBranch : undefined)
      if (next) {
        branchAutoNameRef.current = reuseEligibleBranch
      }
    },
    [reuseEligibleBranch]
  )

  const handleSmartLinearIssueSelect = useCallback(
    (issue: LinearIssue): void => {
      if (isProjectGroupTarget) {
        const linkedItem = toLinearLinkedWorkItem(issue)
        setLinkedIssue('')
        setLinkedPR(null)
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(null)
        setLinkedWorkItem(linkedItem)
        const suggestedName =
          getLinkedItemDisplayName(linkedItem) ?? getLinearIssueWorkspaceName(issue)
        if (
          shouldApplyWorkspaceSourceAutoName({
            currentName: name,
            lastAutoName: lastAutoNameRef.current
          }) ||
          name.trim().toLowerCase() === issue.identifier.toLowerCase()
        ) {
          setName(suggestedName)
          lastAutoNameRef.current = suggestedName
        }
        return
      }
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      const linkedLinearIssue = buildLinearIssueLinkedWorkItem(issue)
      setLinkedWorkItem(linkedLinearIssue)
      const suggestedName = getLinearIssueWorkspaceName(issue)
      // Why: same lookup-text rule as applyLinkedWorkItem, plus the typed Linear identifier ("STA-123") that matched this issue.
      if (
        shouldApplyWorkspaceSourceAutoName({
          currentName: name,
          lastAutoName: lastAutoNameRef.current
        }) ||
        name.trim().toLowerCase() === issue.identifier.toLowerCase()
      ) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
      const linearBranchName = getLinearLinkedWorkItemBranchName(linkedLinearIssue)
      setBranchNameOverride(linearBranchName)
      setBranchNameOverridePreservesNameEdits(Boolean(linearBranchName))
      setForkPushWarning(null)
      branchAutoNameRef.current = linearBranchName ?? ''
      // Why: don't prefill the note for a Linear pick — that would turn a source selection into user-authored instructions (matches the GitHub flow).
    },
    [isProjectGroupTarget, name]
  )

  const handleClearSmartNameSelection = useCallback((): void => {
    smartGitHubPrStartPointSelectionRef.current = null
    setLinkedIssue('')
    setLinkedPR(null)
    setLinkedGitLabIssue(null)
    setLinkedGitLabMR(null)
    setLinkedWorkItem(null)
    setBaseBranch(undefined)
    setCompareBaseRef(undefined)
    setPushTarget(undefined)
    setBranchNameOverride(undefined)
    setBranchNameOverridePreservesNameEdits(false)
    setReuseEligibleBranch(null)
    setReuseSelectedBranch(false)
    setForkPushWarning(null)
    branchAutoNameRef.current = ''
    setStartFromResetHint(null)
    if (name === lastAutoNameRef.current) {
      setName('')
      lastAutoNameRef.current = ''
    }
    if (noteRef.current === lastAutoNoteRef.current) {
      setNote('')
      lastAutoNoteRef.current = ''
    }
  }, [name])

  const smartNameSelection = useMemo<SmartWorkspaceNameSelection | null>(() => {
    if (isProjectGroupTarget) {
      return getFolderSmartNameSelection(linkedWorkItem)
    }
    return buildWorkspaceSourceSelection({
      linkedWorkItem,
      baseBranch
    }) as SmartWorkspaceNameSelection | null
  }, [baseBranch, isProjectGroupTarget, linkedWorkItem])

  const handleOpenAgentSettings = useCallback((): void => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
    closeModal()
  }, [closeModal, openSettingsPage, openSettingsTarget])

  const applyWorktreeMeta = useCallback(
    async (worktreeId: string, meta: Partial<WorktreeMeta>): Promise<void> => {
      if (Object.keys(meta).length === 0) {
        return
      }
      try {
        await updateWorktreeMeta(worktreeId, meta)
      } catch {
        console.error('Failed to update worktree meta after creation')
      }
    },
    [updateWorktreeMeta]
  )

  const folderCreateDisabled =
    creating ||
    !selectedProjectGroup?.parentPath ||
    folderPathStatusBlocksCreate ||
    folderTargetRequiresConnection

  const submitFolderTarget = useCallback(
    async (requestedAgent: TuiAgent | null): Promise<void> => {
      if (!selectedProjectGroup?.parentPath || folderCreateDisabled) {
        return
      }
      setCreateError(null)
      setCreating(true)
      try {
        const shouldResolveSmartGitHubSubmit = canResolveFolderSmartGitHubSubmit({
          hasFolderSourceRepos: folderSourceRepos.length > 0
        })
        const smartGitHubResolution = shouldResolveSmartGitHubSubmit
          ? await resolvePendingSmartGitHubSubmit()
          : ({ kind: 'none' } as const)
        const smartGitHubMetadata =
          smartGitHubResolution.kind === 'none' ? null : smartGitHubResolution
        const agent =
          requestedAgent && isTuiAgentEnabled(requestedAgent, disabledTuiAgents)
            ? requestedAgent
            : null
        const folderWorkspaceCreated = await submitFolderWorkspaceCreate({
          projectGroup: selectedProjectGroup,
          name: smartGitHubMetadata?.workspaceName ?? name,
          lastAutoName: lastAutoNameRef.current,
          linkedWorkItem: smartGitHubMetadata?.linkedWorkItem ?? linkedWorkItem,
          note,
          quickAgent: agent,
          autoRenameBranchFromWork: settings?.autoRenameBranchFromWork,
          agentCmdOverrides: settings?.agentCmdOverrides,
          agentArgs: agent
            ? resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs)
            : undefined,
          agentEnv: agent ? resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv) : undefined,
          sessionOptions: agent
            ? resolveNativeChatSessionOptionDefaults(settings?.nativeChatSessionOptions, agent)
            : undefined,
          terminalWindowsShell: settings?.terminalWindowsShell,
          isRemote: folderTargetIsRemote,
          launchSource: telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
          runtimeEnvironmentId: folderTargetRuntimeEnvironmentId,
          createFolderWorkspace: (input) =>
            createFolderWorkspace(input, {
              runtimeEnvironmentId: folderTargetRuntimeEnvironmentId
            }),
          onOpenChange: (open) => {
            if (!open) {
              if (persistDraft) {
                clearNewWorkspaceDraft()
              }
              onCreated?.()
            }
          }
        })
        if (!folderWorkspaceCreated) {
          setCreateError({
            title: translate(
              'auto.hooks.useComposerState.folderWorkspaceCreateFailedTitle',
              'Folder workspace creation failed'
            ),
            message: translate(
              'auto.hooks.useComposerState.folderWorkspaceCreateFailedMessage',
              'The folder workspace could not be created. Check the error details above, then try again.'
            )
          })
        }
      } catch (error) {
        const formattedError = formatWorkspaceCreateError(error)
        setCreateError(formattedError)
        toast.error(getWorkspaceCreateErrorToastMessage(formattedError))
      } finally {
        setCreating(false)
      }
    },
    [
      clearNewWorkspaceDraft,
      createFolderWorkspace,
      disabledTuiAgents,
      folderCreateDisabled,
      folderTargetIsRemote,
      folderTargetRuntimeEnvironmentId,
      folderSourceRepos.length,
      linkedWorkItem,
      name,
      note,
      onCreated,
      persistDraft,
      resolvePendingSmartGitHubSubmit,
      selectedProjectGroup,
      settings?.agentCmdOverrides,
      settings?.agentDefaultArgs,
      settings?.agentDefaultEnv,
      settings?.autoRenameBranchFromWork,
      settings?.nativeChatSessionOptions,
      settings?.terminalWindowsShell,
      telemetrySource
    ]
  )

  const submit = useCallback(async (): Promise<void> => {
    if (isProjectGroupTarget) {
      await submitFolderTarget(tuiAgent)
      return
    }
    if (!repoId || !selectedRepo) {
      showProjectRequiredError()
      return
    }
    if (
      !workspaceSeedName ||
      selectedRepoRequiresConnection ||
      shouldWaitForSetupCheck ||
      shouldWaitForIssueAutomationCheck ||
      (requiresExplicitSetupChoice && !setupDecision) ||
      sparseError !== null
    ) {
      return
    }
    if (!isTuiAgentEnabled(tuiAgent, disabledTuiAgents)) {
      setTuiAgent(fallbackDefaultAgent)
      toast.error(
        translate(
          'auto.hooks.useComposerState.7eb3f44ff7',
          'Selected agent is disabled. Choose an enabled agent before creating.'
        )
      )
      return
    }

    setCreateError(null)
    setCreating(true)
    try {
      const smartGitHubResolution = await resolvePendingSmartGitHubSubmit()
      const submitLinkedWorkItem =
        smartGitHubResolution.kind === 'none'
          ? linkedWorkItem
          : smartGitHubResolution.linkedWorkItem
      const submitLinkedIssueNumber =
        smartGitHubResolution.kind === 'none'
          ? parsedLinkedIssueNumber
          : smartGitHubResolution.linkedIssueNumber
      const submitLinkedPR =
        smartGitHubResolution.kind === 'none' ? effectiveLinkedPR : smartGitHubResolution.linkedPR
      const submitTitleName = submitLinkedWorkItem
        ? getLinkedWorkItemWorkspaceName(submitLinkedWorkItem)
        : null
      const nameIsAutoManaged = !isExplicitWorkspaceNameInput({
        name,
        lastAutoName: lastAutoNameRef.current
      })
      const smartGitHubCreateNames =
        smartGitHubResolution.kind === 'none'
          ? { workspaceName: workspaceSeedName, displayName: undefined }
          : resolveSmartGitHubCreateNames({
              resolutionKind: smartGitHubResolution.kind,
              smartWorkspaceName: smartGitHubResolution.workspaceName,
              smartDisplayName: smartGitHubResolution.displayName,
              fallbackWorkspaceName: workspaceSeedName,
              nameIsAutoManaged
            })
      const workspaceName =
        smartGitHubResolution.kind === 'none'
          ? nameIsAutoManaged && submitTitleName
            ? submitTitleName.seedName
            : workspaceSeedName
          : smartGitHubCreateNames.workspaceName
      if (!workspaceName) {
        return
      }
      const submitBaseBranch =
        smartGitHubResolution.kind === 'pr-start-point'
          ? smartGitHubResolution.baseBranch
          : smartGitHubResolution.kind === 'metadata-only' &&
              (effectiveLinkedPR !== null || linkedGitLabMR !== null)
            ? undefined
            : baseBranch
      const submitCompareBaseRef =
        smartGitHubResolution.kind === 'pr-start-point'
          ? smartGitHubResolution.compareBaseRef
          : smartGitHubResolution.kind === 'none'
            ? compareBaseRef
            : undefined
      const submitPushTarget =
        smartGitHubResolution.kind === 'pr-start-point'
          ? smartGitHubResolution.pushTarget
          : smartGitHubResolution.kind === 'none'
            ? pushTarget
            : undefined
      const submitBranchNameOverride =
        smartGitHubResolution.kind === 'pr-start-point'
          ? smartGitHubResolution.branchNameOverride
          : smartGitHubResolution.kind === 'none'
            ? branchNameOverride
            : undefined
      const submitLinkedWorkItemProvider = submitLinkedWorkItem
        ? getLinkedWorkItemProvider(submitLinkedWorkItem)
        : null
      const submitShouldApplyLinkedOnlyTemplate =
        enableIssueAutomation &&
        !agentPrompt.trim() &&
        Boolean(submitLinkedWorkItem) &&
        hasLoadedIssueCommand &&
        submitLinkedWorkItemProvider !== 'linear'
      const submitLinkedOnlyTemplatePrompt =
        submitShouldApplyLinkedOnlyTemplate && submitLinkedWorkItem
          ? renderIssueCommandTemplate(
              issueCommandTemplate.trim() || DEFAULT_ISSUE_COMMAND_TEMPLATE,
              {
                issueNumber:
                  submitLinkedWorkItem.type === 'issue' ? submitLinkedWorkItem.number : null,
                artifactUrl: submitLinkedWorkItem.url
              }
            )
          : ''
      const linkedPromptContext = getLinkedWorkItemPromptContext(submitLinkedWorkItem)
      const submitStartupPrompt = submitShouldApplyLinkedOnlyTemplate
        ? buildAgentPromptWithContext(
            submitLinkedOnlyTemplatePrompt,
            attachmentPaths,
            [],
            linkedPromptContext.linkedContextBlocks
          )
        : buildAgentPromptWithContext(
            agentPrompt,
            attachmentPaths,
            linkedPromptContext.linkedUrls,
            linkedPromptContext.linkedContextBlocks
          )
      const submitShouldRunIssueAutomation =
        enableIssueAutomation &&
        submitLinkedWorkItemProvider !== 'linear' &&
        submitLinkedIssueNumber !== null &&
        issueCommandTemplate.length > 0 &&
        !submitShouldApplyLinkedOnlyTemplate

      const setupTrustDecision = selectedRepoIsGit
        ? await ensureHooksConfirmed(useAppStore.getState(), repoId, 'setup')
        : 'skip'
      const effectiveSetupDecision: SetupDecision =
        setupTrustDecision === 'skip'
          ? 'skip'
          : ((resolvedSetupDecision ?? 'inherit') as SetupDecision)

      let issueCommandTrustDecision: 'run' | 'skip' = 'run'
      if (selectedRepoIsGit && submitShouldRunIssueAutomation) {
        issueCommandTrustDecision =
          setupTrustDecision === 'skip'
            ? 'skip'
            : await ensureHooksConfirmed(useAppStore.getState(), repoId, 'issueCommand')
      }

      const linkedLinearIssue =
        submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
          ? submitLinkedWorkItem.linearIdentifier
          : undefined
      const linkedLinearIssueWorkspaceId =
        submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
          ? submitLinkedWorkItem.linearWorkspaceId
          : undefined
      const linkedLinearIssueOrganizationUrlKey =
        submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
          ? submitLinkedWorkItem.linearOrganizationUrlKey
          : undefined
      const effectiveBranchNameOverride = resolveComposerBranchNameOverrideForCreate({
        branchNameOverride: submitBranchNameOverride,
        branchAutoName: branchAutoNameRef.current,
        workspaceName,
        preserveWorkspaceNameEdits:
          smartGitHubResolution.kind === 'pr-start-point' || branchNameOverridePreservesNameEdits,
        createBranchFromWorkspaceName:
          smartGitHubResolution.kind === 'none' && smartNameMode === 'branches'
      })
      const createDisplayName =
        smartGitHubResolution.kind === 'none'
          ? nameIsAutoManaged
            ? submitTitleName?.displayName
            : undefined
          : smartGitHubCreateNames.displayName
      // Why: the first-work hook only renames blank, auto-generated git workspaces that launch an agent; persist that pending state for the card.
      const pendingFirstAgentMessageRename =
        selectedRepoIsGit &&
        settings?.autoRenameBranchFromWork === true &&
        !name.trim() &&
        Boolean(tuiAgent) &&
        !effectiveBranchNameOverride &&
        !createDisplayName
      const startupPlan = buildAgentStartupPlan({
        agent: tuiAgent,
        prompt: submitStartupPrompt,
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        agentArgs: resolveTuiAgentLaunchArgs(tuiAgent, settings?.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(tuiAgent, settings?.agentDefaultEnv),
        sessionOptions: resolveNativeChatSessionOptionDefaults(
          settings?.nativeChatSessionOptions,
          tuiAgent
        ),
        platform: selectedRepoAgentLaunchPlatform,
        shell: selectedRepoStartupShell,
        isRemote: selectedRepoIsRemote
      })
      const shouldSeedInitialAgentStatus =
        tuiAgent === 'command-code' && submitStartupPrompt.trim().length > 0

      // Why: backend startup is safe only for self-contained launch commands; agents needing post-ready paste stay on the renderer path.
      const composerTelemetry: AgentStartedTelemetry = {
        agent_kind: tuiAgentToAgentKind(tuiAgent),
        launch_source: telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
        request_kind: 'new'
      }
      const backendStartup =
        startupPlan && !startupPlan.draftPrompt && !startupPlan.followupPrompt
          ? {
              command: startupPlan.launchCommand,
              ...(startupPlan.env ? { env: startupPlan.env } : {}),
              launchConfig: startupPlan.launchConfig,
              launchAgent: tuiAgent,
              ...(startupPlan.startupCommandDelivery
                ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
                : {}),
              telemetry: composerTelemetry
            }
          : undefined
      if (!(await persistSetupAgentStartupPolicy())) {
        throw new Error(
          translate(
            'auto.hooks.useComposerState.setupAgentStartupPolicySaveFailed',
            'Failed to save setup startup behavior.'
          )
        )
      }
      const result = await createWorktree(
        repoId,
        workspaceName,
        selectedRepoIsGit ? submitBaseBranch : undefined,
        effectiveSetupDecision,
        selectedRepoIsGit && sparseEnabled
          ? {
              directories: normalizedSparseDirectories,
              ...(effectivePresetId ? { presetId: effectivePresetId } : {})
            }
          : undefined,
        telemetrySource,
        createDisplayName,
        submitLinkedIssueNumber ?? undefined,
        submitLinkedPR ?? undefined,
        submitPushTarget,
        tuiAgent,
        linkedLinearIssue,
        effectiveBranchNameOverride,
        resolvedInitialWorkspaceStatus,
        smartGitHubResolution.kind === 'none' ? (linkedGitLabMR ?? undefined) : undefined,
        smartGitHubResolution.kind === 'none' ? (linkedGitLabIssue ?? undefined) : undefined,
        backendStartup,
        pendingFirstAgentMessageRename,
        undefined,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        undefined,
        undefined,
        undefined,
        submitCompareBaseRef
      )
      const worktree = result.worktree

      const trimmedNote = note.trim()
      // Why: linked source metadata is already in createWorktree; re-saving it can trigger slow post-create PR push-target lookups.
      await applyWorktreeMeta(worktree.id, trimmedNote ? { comment: trimmedNote } : {})

      const issueCommand =
        submitShouldRunIssueAutomation && issueCommandTrustDecision === 'run'
          ? {
              command: renderIssueCommandTemplate(issueCommandTemplate, {
                issueNumber: submitLinkedIssueNumber,
                artifactUrl: submitLinkedWorkItem?.url ?? null
              })
            }
          : undefined
      const backendSpawnedStartup = result.startupTerminal?.spawned === true
      if (startupPlan && !backendSpawnedStartup && !startupPlan.launchToken) {
        // Why: delayed delivery must target the exact pane from this queued startup, so both halves share one renderer-session token.
        startupPlan.launchToken = createBrowserUuid()
      }
      const activation = activateAndRevealWorktree(worktree.id, {
        sidebarRevealBehavior: 'auto',
        setup: result.setup,
        defaultTabs: result.defaultTabs,
        issueCommand,
        ...(startupPlan && !backendSpawnedStartup
          ? {
              startup: {
                command: startupPlan.launchCommand,
                ...(startupPlan.env ? { env: startupPlan.env } : {}),
                launchConfig: startupPlan.launchConfig,
                ...(startupPlan.launchToken ? { launchToken: startupPlan.launchToken } : {}),
                launchAgent: tuiAgent,
                ...(startupPlan.draftPrompt ? { draftPrompt: startupPlan.draftPrompt } : {}),
                ...(startupPlan.startupCommandDelivery
                  ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
                  : {}),
                ...(shouldSeedInitialAgentStatus
                  ? {
                      initialAgentStatus: {
                        agent: tuiAgent,
                        prompt: submitStartupPrompt.trim()
                      }
                    }
                  : {}),
                telemetry: composerTelemetry
              }
            }
          : {})
      })
      if (startupPlan) {
        const optionScopeKey =
          (activation !== false ? activation.primaryTabId : null) ?? result.startupTerminal?.tabId
        if (optionScopeKey) {
          seedNativeChatAppliedSessionOptions(optionScopeKey, tuiAgent, startupPlan.sessionOptions)
        }
      }
      if (startupPlan && !backendSpawnedStartup) {
        void ensureAgentStartupInTerminal({
          worktreeId: worktree.id,
          primaryTabId: activation === false ? null : activation.primaryTabId,
          startup: startupPlan
        })
      }
      setSidebarOpen(true)
      if (persistDraft) {
        clearNewWorkspaceDraft()
      }
      onCreated?.()
      queueNewWorkspaceTerminalFocus(worktree.id, activation)
    } catch (error) {
      const formattedError = formatWorkspaceCreateError(error)
      setCreateError(formattedError)
      toast.error(getWorkspaceCreateErrorToastMessage(formattedError))
    } finally {
      setCreating(false)
    }
  }, [
    agentPrompt,
    attachmentPaths,
    baseBranch,
    branchNameOverride,
    branchNameOverridePreservesNameEdits,
    clearNewWorkspaceDraft,
    compareBaseRef,
    createWorktree,
    applyWorktreeMeta,
    enableIssueAutomation,
    issueCommandTemplate,
    effectiveLinkedPR,
    hasLoadedIssueCommand,
    linkedGitLabIssue,
    linkedGitLabMR,
    linkedWorkItem,
    name,
    normalizedSparseDirectories,
    note,
    onCreated,
    parsedLinkedIssueNumber,
    persistSetupAgentStartupPolicy,
    persistDraft,
    pushTarget,
    repoId,
    requiresExplicitSetupChoice,
    resolvePendingSmartGitHubSubmit,
    resolvedSetupDecision,
    resolvedInitialWorkspaceStatus,
    selectedRepo,
    selectedRepoAgentLaunchPlatform,
    selectedRepoIsRemote,
    selectedRepoStartupShell,
    selectedRepoIsGit,
    selectedRepoRequiresConnection,
    showProjectRequiredError,
    settings?.agentCmdOverrides,
    settings?.agentDefaultArgs,
    settings?.agentDefaultEnv,
    settings?.autoRenameBranchFromWork,
    settings?.nativeChatSessionOptions,
    smartNameMode,
    setSidebarOpen,
    setupDecision,
    sparseEnabled,
    sparseError,
    effectivePresetId,
    telemetrySource,
    fallbackDefaultAgent,
    disabledTuiAgents,
    tuiAgent,
    shouldWaitForIssueAutomationCheck,
    shouldWaitForSetupCheck,
    workspaceSeedName,
    isProjectGroupTarget,
    submitFolderTarget
  ])

  const resetForNextCreate = useCallback(() => {
    // Why: clears identity fields incl PR-pick-derived refs (else a half-set Start-from state — e.g. a silent fork push target — leaks into the next create); retains context (repo, base, agent, group) for fast sequential creates.
    setName('')
    lastAutoNameRef.current = ''
    setAgentPrompt('')
    setNote('')
    setAttachmentPaths([])
    setLinkedWorkItem(null)
    setLinkedIssue('')
    setLinkedPR(null)
    setLinkedGitLabIssue(null)
    setLinkedGitLabMR(null)
    setBranchNameOverride(undefined)
    setBranchNameOverridePreservesNameEdits(false)
    setCompareBaseRef(undefined)
    setPushTarget(undefined)
    setReuseSelectedBranch(false)
    setStartFromResetHint(null)
    setForkPushWarning(null)
    setCreateError(null)
    // Refocus after the reset re-render (next frame) so the user can type the next worktree name immediately.
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [])

  const submitQuick = useCallback(
    async (requestedAgent: TuiAgent | null): Promise<void> => {
      if (isProjectGroupTarget) {
        await submitFolderTarget(requestedAgent)
        return
      }
      const workspaceNameSeed = getWorkspaceSeedName({
        explicitName: name,
        prompt: '',
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR,
        fallbackName: fallbackCreatureName
      })
      if (!repoId || !selectedRepo) {
        showProjectRequiredError()
        return
      }
      if (
        !workspaceNameSeed ||
        selectedRepoRequiresConnection ||
        (requiresExplicitSetupChoice && !setupDecision) ||
        sparseError !== null
      ) {
        return
      }

      setCreateError(null)
      setCreating(true)
      try {
        const smartGitHubResolution = await resolvePendingSmartGitHubSubmit()
        const submitLinkedWorkItem =
          smartGitHubResolution.kind === 'none'
            ? linkedWorkItem
            : smartGitHubResolution.linkedWorkItem
        const agent =
          requestedAgent && isTuiAgentEnabled(requestedAgent, disabledTuiAgents)
            ? requestedAgent
            : null
        const submitLinkedIssueNumber =
          smartGitHubResolution.kind === 'none'
            ? parsedLinkedIssueNumber
            : smartGitHubResolution.linkedIssueNumber
        const submitLinkedPR =
          smartGitHubResolution.kind === 'none' ? effectiveLinkedPR : smartGitHubResolution.linkedPR
        const submitTitleName = submitLinkedWorkItem
          ? getLinkedWorkItemWorkspaceName(submitLinkedWorkItem)
          : null
        const nameIsAutoManaged = !isExplicitWorkspaceNameInput({
          name,
          lastAutoName: lastAutoNameRef.current
        })
        const smartGitHubCreateNames =
          smartGitHubResolution.kind === 'none'
            ? { workspaceName: workspaceNameSeed, displayName: undefined }
            : resolveSmartGitHubCreateNames({
                resolutionKind: smartGitHubResolution.kind,
                smartWorkspaceName: smartGitHubResolution.workspaceName,
                smartDisplayName: smartGitHubResolution.displayName,
                fallbackWorkspaceName: workspaceNameSeed,
                nameIsAutoManaged
              })
        const workspaceName =
          smartGitHubResolution.kind === 'none'
            ? nameIsAutoManaged && submitTitleName
              ? submitTitleName.seedName
              : workspaceNameSeed
            : smartGitHubCreateNames.workspaceName
        if (!workspaceName) {
          return
        }
        const smartSubmitBaseBranch =
          smartGitHubResolution.kind === 'pr-start-point'
            ? smartGitHubResolution.baseBranch
            : smartGitHubResolution.kind === 'metadata-only' &&
                (effectiveLinkedPR !== null || linkedGitLabMR !== null)
              ? undefined
              : baseBranch
        const submitCompareBaseRef =
          smartGitHubResolution.kind === 'pr-start-point'
            ? smartGitHubResolution.compareBaseRef
            : smartGitHubResolution.kind === 'none'
              ? compareBaseRef
              : undefined
        const submitPushTarget =
          smartGitHubResolution.kind === 'pr-start-point'
            ? smartGitHubResolution.pushTarget
            : smartGitHubResolution.kind === 'none'
              ? pushTarget
              : undefined
        const submitBranchNameOverride =
          smartGitHubResolution.kind === 'pr-start-point'
            ? smartGitHubResolution.branchNameOverride
            : smartGitHubResolution.kind === 'none'
              ? branchNameOverride
              : undefined

        let submitSetupConfig = setupConfig
        let submitResolvedSetupDecision = resolvedSetupDecision
        if (selectedRepoIsGit && checkedHooksRepoId !== repoId) {
          let hookCheck: HookCheckResult
          try {
            hookCheck = await loadHookCheckForRepo(repoId)
          } catch {
            hookCheck = { hasHooks: false, hooks: null, mayNeedUpdate: false }
          }
          if (!commitHookCheckIfCurrent(repoId, hookCheck.hooks)) {
            return
          }
          submitSetupConfig = getSetupConfig(selectedRepo, hookCheck.hooks)
          submitResolvedSetupDecision =
            setupDecision ??
            (!submitSetupConfig || setupPolicy === 'ask'
              ? null
              : setupPolicy === 'run-by-default'
                ? 'run'
                : 'skip')
        }
        if (selectedRepoIsGit && submitSetupConfig && setupPolicy === 'ask' && !setupDecision) {
          setAdvancedOpen(true)
          return
        }

        const trustDecision = selectedRepoIsGit
          ? await ensureHooksConfirmed(useAppStore.getState(), repoId, 'setup')
          : 'skip'
        const effectiveSetupDecision: SetupDecision =
          trustDecision === 'skip'
            ? 'skip'
            : ((submitResolvedSetupDecision ?? 'inherit') as SetupDecision)

        const submitLinkedWorkItemProvider = submitLinkedWorkItem
          ? getLinkedWorkItemProvider(submitLinkedWorkItem)
          : null
        const linkedLinearIssue =
          submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
            ? submitLinkedWorkItem.linearIdentifier
            : undefined
        const linkedLinearIssueWorkspaceId =
          submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
            ? submitLinkedWorkItem.linearWorkspaceId
            : undefined
        const linkedLinearIssueOrganizationUrlKey =
          submitLinkedWorkItem && submitLinkedWorkItemProvider === 'linear'
            ? submitLinkedWorkItem.linearOrganizationUrlKey
            : undefined
        const effectiveBranchNameOverride = resolveComposerBranchNameOverrideForCreate({
          branchNameOverride: submitBranchNameOverride,
          branchAutoName: branchAutoNameRef.current,
          workspaceName,
          preserveWorkspaceNameEdits:
            smartGitHubResolution.kind === 'pr-start-point' || branchNameOverridePreservesNameEdits,
          createBranchFromWorkspaceName:
            smartGitHubResolution.kind === 'none' && smartNameMode === 'branches'
        })
        const submitBaseBranch = selectedRepoIsGit
          ? await resolveWorktreeCreateBaseBranch({
              explicitBaseBranch: smartSubmitBaseBranch
            })
          : undefined
        const createDisplayName =
          smartGitHubResolution.kind === 'none'
            ? nameIsAutoManaged
              ? submitTitleName?.displayName
              : undefined
            : smartGitHubCreateNames.displayName
        // Why: quick create shares the blank-name flow; the card needs an explicit marker, not a guess from the title.
        const pendingFirstAgentMessageRename =
          selectedRepoIsGit &&
          settings?.autoRenameBranchFromWork === true &&
          !name.trim() &&
          Boolean(agent) &&
          !effectiveBranchNameOverride &&
          !createDisplayName
        const trimmedNote = note.trim()
        // Why: agents needing post-ready paste/follow-up stay on the renderer path so prompt delivery isn't skipped.
        const promptLinkedWorkItem = agent === null ? null : submitLinkedWorkItem
        const { prompt: quickPrompt, draftPrompt: quickDraftPrompt } =
          resolveQuickCreateLinkedWorkItemPrompt(promptLinkedWorkItem, trimmedNote)
        const draftLaunchPlan =
          agent === null || !quickDraftPrompt
            ? null
            : buildAgentDraftLaunchPlan({
                agent,
                draft: quickDraftPrompt,
                cmdOverrides: settings?.agentCmdOverrides ?? {},
                agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
                agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
                sessionOptions: resolveNativeChatSessionOptionDefaults(
                  settings?.nativeChatSessionOptions,
                  agent
                ),
                platform: selectedRepoAgentLaunchPlatform,
                shell: selectedRepoStartupShell,
                isRemote: selectedRepoIsRemote
              })

        let startupPlan: ReturnType<typeof buildAgentStartupPlan> = null
        if (draftLaunchPlan) {
          startupPlan = {
            agent: draftLaunchPlan.agent,
            launchCommand: draftLaunchPlan.launchCommand,
            expectedProcess: draftLaunchPlan.expectedProcess,
            followupPrompt: null,
            launchConfig: draftLaunchPlan.launchConfig,
            ...(draftLaunchPlan.sessionOptions
              ? { sessionOptions: draftLaunchPlan.sessionOptions }
              : {}),
            ...(draftLaunchPlan.startupCommandDelivery
              ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
              : {}),
            ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
          }
        } else if (agent !== null) {
          startupPlan = buildAgentStartupPlan({
            agent,
            prompt: quickPrompt,
            cmdOverrides: settings?.agentCmdOverrides ?? {},
            agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
            agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
            sessionOptions: resolveNativeChatSessionOptionDefaults(
              settings?.nativeChatSessionOptions,
              agent
            ),
            platform: selectedRepoAgentLaunchPlatform,
            shell: selectedRepoStartupShell,
            isRemote: selectedRepoIsRemote,
            allowEmptyPromptLaunch: true
          })
          if (startupPlan && quickDraftPrompt) {
            startupPlan.draftPrompt = quickDraftPrompt
          }
        }

        const quickTelemetry: AgentStartedTelemetry | null =
          agent === null
            ? null
            : {
                agent_kind: tuiAgentToAgentKind(agent),
                launch_source:
                  telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
                request_kind: 'new'
              }
        const backendStartup =
          startupPlan && !startupPlan.draftPrompt && !startupPlan.followupPrompt
            ? {
                command: startupPlan.launchCommand,
                ...(startupPlan.env ? { env: startupPlan.env } : {}),
                launchConfig: startupPlan.launchConfig,
                ...(agent ? { launchAgent: agent } : {}),
                ...(startupPlan.startupCommandDelivery
                  ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
                  : {}),
                ...(quickTelemetry ? { telemetry: quickTelemetry } : {})
              }
            : undefined
        if (!(await persistSetupAgentStartupPolicy())) {
          throw new Error(
            translate(
              'auto.hooks.useComposerState.setupAgentStartupPolicySaveFailed',
              'Failed to save setup startup behavior.'
            )
          )
        }
        let creationWorkspaceRunContext: WorktreeCreationRequest['workspaceRunContext'] =
          selectedWorkspaceTarget.status === 'ready'
            ? {
                kind: 'workspace-run',
                projectId: selectedWorkspaceTarget.target.projectId,
                hostId: selectedWorkspaceTarget.target.hostId,
                projectHostSetupId: selectedWorkspaceTarget.target.projectHostSetupId,
                repoId: selectedWorkspaceTarget.target.repoId,
                path: selectedWorkspaceTarget.target.repo.path
              }
            : null
        let ephemeralVmRecipe: WorktreeCreationRequest['ephemeralVmRecipe']
        const activeEphemeralVmRecipeId = ephemeralVmsEnabled ? selectedEphemeralVmRecipeId : null
        if (activeEphemeralVmRecipeId && selectedWorkspaceTarget.status === 'ready') {
          const vmRecipeTrustDecision = await ensureHooksConfirmed(
            useAppStore.getState(),
            repoId,
            'vmRecipe'
          )
          if (vmRecipeTrustDecision === 'skip') {
            return
          }
          ephemeralVmRecipe = {
            sourceRepoId: repoId,
            recipeId: activeEphemeralVmRecipeId,
            projectId: selectedWorkspaceTarget.target.projectId
          }
        }

        const request: WorktreeCreationRequest = {
          repoId,
          ...(ephemeralVmRecipe ? { ephemeralVmRecipe } : {}),
          worktreeCreateProgressMode:
            activeEphemeralVmRecipeId ||
            getActiveRuntimeTarget(selectedRepoSettings).kind !== 'local'
              ? 'indeterminate'
              : 'stepped',
          ...(taskSourceContext ? { taskSourceContext } : {}),
          ...(creationWorkspaceRunContext
            ? { workspaceRunContext: creationWorkspaceRunContext }
            : {}),
          name: workspaceName,
          ...(createDisplayName ? { displayName: createDisplayName } : {}),
          ...(selectedRepoIsGit && submitBaseBranch ? { baseBranch: submitBaseBranch } : {}),
          ...(selectedRepoIsGit && submitCompareBaseRef
            ? { compareBaseRef: submitCompareBaseRef }
            : {}),
          setupDecision: effectiveSetupDecision,
          ...(selectedRepoIsGit && sparseEnabled
            ? {
                sparseCheckout: {
                  directories: normalizedSparseDirectories,
                  ...(effectivePresetId ? { presetId: effectivePresetId } : {})
                }
              }
            : {}),
          ...(telemetrySource ? { telemetrySource } : {}),
          ...(submitLinkedIssueNumber != null ? { linkedIssue: submitLinkedIssueNumber } : {}),
          ...(submitLinkedPR != null ? { linkedPR: submitLinkedPR } : {}),
          ...(submitPushTarget ? { pushTarget: submitPushTarget } : {}),
          agent,
          ...(linkedLinearIssue ? { linkedLinearIssue } : {}),
          ...(linkedLinearIssueWorkspaceId !== undefined ? { linkedLinearIssueWorkspaceId } : {}),
          ...(linkedLinearIssueOrganizationUrlKey !== undefined
            ? { linkedLinearIssueOrganizationUrlKey }
            : {}),
          ...(effectiveBranchNameOverride
            ? { branchNameOverride: effectiveBranchNameOverride }
            : {}),
          ...(resolvedInitialWorkspaceStatus
            ? { workspaceStatus: resolvedInitialWorkspaceStatus }
            : {}),
          ...(smartGitHubResolution.kind === 'none' && linkedGitLabMR != null
            ? { linkedGitLabMR }
            : {}),
          ...(smartGitHubResolution.kind === 'none' && linkedGitLabIssue != null
            ? { linkedGitLabIssue }
            : {}),
          ...(backendStartup ? { startup: backendStartup } : {}),
          pendingFirstAgentMessageRename,
          note: trimmedNote,
          startupPlan,
          quickPrompt,
          quickTelemetry,
          ...(createMultiple ? { suppressTerminalFocusOnCompletion: true } : {})
        }

        // Why: git fetch + `git worktree add` can take 10–15s; run in the background so the modal isn't frozen.
        if (persistDraft) {
          clearNewWorkspaceDraft()
        }
        runBackgroundWorktreeCreation(request)
        if (createMultiple) {
          // Why: creation runs in the background, so reset identity to queue another worktree right away.
          resetForNextCreate()
        } else {
          onCreated?.()
        }
      } catch (error) {
        const formattedError = formatWorkspaceCreateError(error)
        setCreateError(formattedError)
        toast.error(getWorkspaceCreateErrorToastMessage(formattedError))
      } finally {
        setCreating(false)
      }
    },
    [
      baseBranch,
      compareBaseRef,
      branchNameOverride,
      branchNameOverridePreservesNameEdits,
      clearNewWorkspaceDraft,
      fallbackCreatureName,
      effectiveLinkedPR,
      linkedGitLabIssue,
      linkedGitLabMR,
      linkedPR,
      linkedWorkItem,
      name,
      normalizedSparseDirectories,
      note,
      onCreated,
      parsedLinkedIssueNumber,
      persistSetupAgentStartupPolicy,
      persistDraft,
      pushTarget,
      repoId,
      requiresExplicitSetupChoice,
      resolvePendingSmartGitHubSubmit,
      resolvedSetupDecision,
      resolvedInitialWorkspaceStatus,
      selectedRepo,
      selectedRepoAgentLaunchPlatform,
      selectedRepoIsRemote,
      selectedRepoStartupShell,
      selectedRepoIsGit,
      selectedRepoSettings,
      selectedRepoRequiresConnection,
      selectedWorkspaceTarget,
      selectedEphemeralVmRecipeId,
      ephemeralVmsEnabled,
      showProjectRequiredError,
      settings?.agentCmdOverrides,
      settings?.agentDefaultArgs,
      settings?.agentDefaultEnv,
      settings?.autoRenameBranchFromWork,
      settings?.nativeChatSessionOptions,
      smartNameMode,
      disabledTuiAgents,
      setupDecision,
      sparseEnabled,
      sparseError,
      effectivePresetId,
      telemetrySource,
      taskSourceContext,
      checkedHooksRepoId,
      commitHookCheckIfCurrent,
      loadHookCheckForRepo,
      setupConfig,
      setupPolicy,
      isProjectGroupTarget,
      submitFolderTarget,
      createMultiple,
      resetForNextCreate
    ]
  )

  const createGateInput = {
    repoId,
    workspaceSeedName,
    creating,
    shouldWaitForSetupCheck,
    shouldWaitForIssueAutomationCheck,
    requiresExplicitSetupChoice,
    hasSetupDecision: Boolean(setupDecision),
    selectedRepoRequiresConnection,
    sparseError
  }
  const repoCreateDisabled =
    createGateMode === 'quick'
      ? getQuickComposerCreateDisabled(createGateInput)
      : getFullComposerCreateDisabled(createGateInput)
  const createDisabled = isProjectGroupTarget ? folderCreateDisabled : repoCreateDisabled
  const cardProps: ComposerCardProps = {
    eligibleRepos: isProjectGroupTarget ? folderSourceRepos : eligibleRepos,
    repoId,
    projectOptions,
    selectedProjectId,
    selectedRepoIsGit: isProjectGroupTarget ? true : selectedRepoIsGit,
    onRepoChange: isProjectGroupTarget ? handleFolderSourceRepoChange : handleRepoChange,
    onProjectChange: handleProjectChange,
    projectHostSetupOptions: isProjectGroupTarget ? [] : projectHostSetupOptions,
    selectedProjectHostSetupId: isProjectGroupTarget ? null : selectedProjectHostSetupId,
    onProjectHostSetupChange: handleProjectHostSetupChange,
    ephemeralVmRecipes: isProjectGroupTarget || !ephemeralVmsEnabled ? [] : ephemeralVmRecipes,
    selectedEphemeralVmRecipeId:
      isProjectGroupTarget || !ephemeralVmsEnabled ? null : selectedEphemeralVmRecipeId,
    onEphemeralVmRecipeChange: setSelectedEphemeralVmRecipeId,
    ephemeralVmRecipeError:
      isProjectGroupTarget || !ephemeralVmsEnabled ? null : ephemeralVmRecipeError,
    repoBackedSearchRepos: isProjectGroupTarget ? folderSourceRepos : undefined,
    repoBackedSourcesDisabled: isProjectGroupTarget ? folderSourceRepos.length === 0 : false,
    allowSmartNameAddProject: !isProjectGroupTarget,
    smartNameRepoSwitchTarget: isProjectGroupTarget ? 'task-source' : 'project',
    name,
    onNameValueChange: handleNameValueChange,
    branchNameOverride: isProjectGroupTarget ? undefined : branchNameOverride,
    onBranchNameOverrideChange: isProjectGroupTarget ? () => {} : handleBranchNameOverrideChange,
    onSmartGitHubItemSelect: handleSmartGitHubItemSelect,
    onSmartGitLabItemSelect: handleSmartGitLabItemSelect,
    onSmartBranchSelect: isProjectGroupTarget ? () => {} : handleSmartBranchSelect,
    onSmartNameModeChange: setSmartNameMode,
    onSmartLinearIssueSelect: handleSmartLinearIssueSelect,
    smartNameGitHubSourceContext: selectedRepoGitHubSourceContext,
    smartNameSelection,
    onClearSmartNameSelection: handleClearSmartNameSelection,
    canReuseSelectedBranch:
      !isProjectGroupTarget &&
      reuseEligibleBranch !== null &&
      smartNameSelection?.kind === 'branch',
    reuseSelectedBranch,
    onReuseSelectedBranchChange: handleReuseSelectedBranchChange,
    // Why: "create multiple" applies only to worktree (git) targets; folder-workspace keeps create-and-close.
    showCreateMultiple: !isProjectGroupTarget,
    createMultiple,
    onCreateMultipleChange: setCreateMultiple,
    agentPrompt,
    onAgentPromptChange: setAgentPrompt,
    linkedOnlyTemplatePreview: shouldApplyLinkedOnlyTemplate ? linkedOnlyTemplatePrompt : null,
    attachmentPaths,
    getAttachmentLabel,
    onAddAttachment: () => void handleAddAttachment(),
    onRemoveAttachment: (pathValue) =>
      setAttachmentPaths((current) => current.filter((currentPath) => currentPath !== pathValue)),
    linkedWorkItem,
    onRemoveLinkedWorkItem: handleRemoveLinkedWorkItem,
    linkPopoverOpen,
    onLinkPopoverOpenChange: handleLinkPopoverChange,
    linkQuery,
    onLinkQueryChange: setLinkQuery,
    filteredLinkItems,
    linkItemsLoading,
    linkDirectLoading,
    normalizedLinkQuery,
    onSelectLinkedItem: handleSelectLinkedItem,
    tuiAgent,
    onTuiAgentChange: setTuiAgent,
    detectedAgentIds: isProjectGroupTarget ? folderDetectedAgentIds : detectedAgentIds,
    onOpenAgentSettings: handleOpenAgentSettings,
    advancedOpen,
    onToggleAdvanced: () => setAdvancedOpen((current) => !current),
    createDisabled,
    projectError: isProjectGroupTarget ? pathStatusProjectError : projectError,
    creating,
    onCreate: () => void submit(),
    baseBranch: isProjectGroupTarget ? undefined : baseBranch,
    onBaseBranchChange: isProjectGroupTarget ? () => {} : handleBaseBranchChange,
    onBaseBranchPrSelect: isProjectGroupTarget ? () => {} : handleBaseBranchPrSelect,
    onBaseBranchMrSelect: isProjectGroupTarget ? () => {} : handleBaseBranchMrSelect,
    baseBranchLinkedPrNumber:
      linkedWorkItem?.type === 'pr' && baseBranch ? linkedWorkItem.number : null,
    selectedRepoPath: isProjectGroupTarget ? null : (selectedRepo?.path ?? null),
    selectedRepoIsRemote: isProjectGroupTarget
      ? folderTargetIsRemote
      : Boolean(selectedRepo?.connectionId),
    selectedRepoConnectionId: isProjectGroupTarget
      ? folderTargetConnectionId
      : selectedRepoConnectionId,
    selectedRepoSshStatus: isProjectGroupTarget ? folderTargetSshStatus : selectedRepoSshStatus,
    selectedRepoRequiresConnection: isProjectGroupTarget
      ? folderTargetRequiresConnection
      : selectedRepoRequiresConnection,
    selectedRepoConnectInProgress: isProjectGroupTarget
      ? folderTargetConnectInProgress
      : selectedRepoConnectInProgress,
    onConnectSelectedRepo: isProjectGroupTarget
      ? onConnectSelectedProjectGroup
      : onConnectSelectedRepo,
    startFromResetHint: isProjectGroupTarget ? null : startFromResetHint,
    forkPushWarning: isProjectGroupTarget ? null : forkPushWarning,
    note,
    onNoteChange: setNote,
    setupConfig: isProjectGroupTarget ? null : setupConfig,
    requiresExplicitSetupChoice: isProjectGroupTarget ? false : requiresExplicitSetupChoice,
    setupDecision: isProjectGroupTarget ? null : setupDecision,
    onSetupDecisionChange: isProjectGroupTarget ? () => {} : setSetupDecision,
    setupAgentStartupPolicy: isProjectGroupTarget ? 'start-immediately' : setupAgentStartupPolicy,
    onSetupAgentStartupPolicyChange: isProjectGroupTarget
      ? () => {}
      : handleSetupAgentStartupPolicyChange,
    shouldWaitForSetupCheck: isProjectGroupTarget ? false : shouldWaitForSetupCheck,
    resolvedSetupDecision: isProjectGroupTarget ? null : resolvedSetupDecision,
    createError,
    canUseSparseCheckout: isProjectGroupTarget
      ? false
      : selectedRepoIsGit && !selectedRepo?.connectionId,
    sparsePresets: isProjectGroupTarget ? [] : sparsePresets,
    sparseSelectedPresetId: isProjectGroupTarget ? null : sparseSelectedPresetId,
    onSparseSelectPreset: isProjectGroupTarget ? () => {} : handleSparseSelectPreset,
    branchesEnabled: !isProjectGroupTarget,
    setupControlsEnabled: !isProjectGroupTarget,
    sparseControlsEnabled: !isProjectGroupTarget
  }

  return {
    cardProps,
    composerRef,
    onComposerNodeChange: handleComposerNodeChange,
    promptTextareaRef,
    nameInputRef,
    submit,
    submitQuick,
    createDisabled,
    selectAddedProjectRepo
  }
}

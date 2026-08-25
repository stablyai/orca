import type { ComposerDecisions } from './composer-decisions'
import type { ComposerTargetState } from './composer-target-state-contract'
import type { ComposerStateInput } from './composer-target-store'
import { useComposerTargetStore } from './composer-target-store'
import { useComposerInitialTargetState } from './initial-target-state'
import { useComposerRuntimeTargetSelection } from './runtime-target-selection'
import { useComposerSourceContextState } from './source-context-state'
import { useWorkspaceIdentityState } from './workspace-identity-state'
import { useComposerAsyncState } from './async-composer-state'
import { useComposerProviderRuntimeSync } from './provider-runtime-sync'
import { useDerivedComposerState } from './derived-composer-state'
import { useDraftTargetSync } from './draft-target-sync'

export function useComposerTargetState(
  options: ComposerStateInput,
  decisions: ComposerDecisions
): ComposerTargetState {
  const composerTargetStore = useComposerTargetStore(options, decisions)
  const initialTargetState = useComposerInitialTargetState({
    actionableHostIds: composerTargetStore.actionableHostIds,
    decisions: composerTargetStore.decisions,
    eligibleRepos: composerTargetStore.eligibleRepos,
    initialProjectGroupId: composerTargetStore.initialProjectGroupId,
    initialRepoId: composerTargetStore.initialRepoId,
    initialTaskSourceContext: composerTargetStore.initialTaskSourceContext,
    initialWorkspaceStatus: composerTargetStore.initialWorkspaceStatus,
    newWorkspaceDraft: composerTargetStore.newWorkspaceDraft,
    persistDraft: composerTargetStore.persistDraft,
    projectGroups: composerTargetStore.projectGroups,
    projectHostSetups: composerTargetStore.projectHostSetups,
    projects: composerTargetStore.projects,
    repoIdOverride: composerTargetStore.repoIdOverride,
    seedActiveRepoId: composerTargetStore.seedActiveRepoId,
    workspaceHostScope: composerTargetStore.workspaceHostScope,
    workspaceStatuses: composerTargetStore.workspaceStatuses
  })
  const runtimeTargetSelection = useComposerRuntimeTargetSelection({
    actionableHostIds: composerTargetStore.actionableHostIds,
    activeRepoId: composerTargetStore.activeRepoId,
    eligibleRepos: composerTargetStore.eligibleRepos,
    hostOptions: composerTargetStore.hostOptions,
    initialEphemeralVmRecipeId: composerTargetStore.initialEphemeralVmRecipeId,
    projectGroups: composerTargetStore.projectGroups,
    projectHostSetups: composerTargetStore.projectHostSetups,
    projects: composerTargetStore.projects,
    repoId: initialTargetState.repoId,
    repos: composerTargetStore.repos,
    selectedProjectGroup: initialTargetState.selectedProjectGroup,
    selectedProjectHostSetupOverrideId: initialTargetState.selectedProjectHostSetupOverrideId,
    settings: composerTargetStore.settings,
    sshConnectionStates: composerTargetStore.sshConnectionStates,
    workspaceHostScope: composerTargetStore.workspaceHostScope,
    worktreesByRepo: composerTargetStore.worktreesByRepo
  })
  const sourceContextState = useComposerSourceContextState({
    folderSourceRepos: runtimeTargetSelection.folderSourceRepos,
    decisions: composerTargetStore.decisions,
    initialLinkedWorkItem: composerTargetStore.initialLinkedWorkItem,
    initialName: composerTargetStore.initialName,
    initialPrompt: composerTargetStore.initialPrompt,
    initialTaskSourceContext: composerTargetStore.initialTaskSourceContext,
    isProjectGroupTarget: runtimeTargetSelection.isProjectGroupTarget,
    newWorkspaceDraft: composerTargetStore.newWorkspaceDraft,
    persistDraft: composerTargetStore.persistDraft,
    onRepoIdOverrideChange: composerTargetStore.onRepoIdOverrideChange,
    projects: composerTargetStore.projects,
    repoId: initialTargetState.repoId,
    selectedProjectGroup: initialTargetState.selectedProjectGroup,
    selectedProjectHostSetupId: runtimeTargetSelection.selectedProjectHostSetupId,
    selectedProjectId: runtimeTargetSelection.selectedProjectId,
    selectedRepo: runtimeTargetSelection.selectedRepo,
    selectedRepoIsGit: runtimeTargetSelection.selectedRepoIsGit,
    setInternalRepoId: initialTargetState.setInternalRepoId,
    selectedWorkspaceTarget: runtimeTargetSelection.selectedWorkspaceTarget
  })
  const workspaceIdentityState = useWorkspaceIdentityState({
    initialBaseBranch: composerTargetStore.initialBaseBranch,
    initialLinearBranchName: sourceContextState.initialLinearBranchName,
    initialLinkedWorkItem: composerTargetStore.initialLinkedWorkItem,
    linkedWorkItem: sourceContextState.linkedWorkItem,
    linkedWorkItemSeedIdentity: sourceContextState.linkedWorkItemSeedIdentity,
    name: sourceContextState.name,
    newWorkspaceDraft: composerTargetStore.newWorkspaceDraft,
    persistDraft: composerTargetStore.persistDraft,
    selectedRepoConnectionId: runtimeTargetSelection.selectedRepoConnectionId,
    selectedRepoSettings: runtimeTargetSelection.selectedRepoSettings,
    settings: composerTargetStore.settings
  })
  const asyncComposerState = useComposerAsyncState({
    agentPrompt: sourceContextState.agentPrompt,
    connectionId: workspaceIdentityState.connectionId,
    decisions: composerTargetStore.decisions,
    draftLinkedWorkItemSeed: sourceContextState.draftLinkedWorkItemSeed,
    enableIssueAutomation: composerTargetStore.enableIssueAutomation,
    initialGitHubWorkItem: composerTargetStore.initialGitHubWorkItem,
    initialLinkedWorkItemSeed: sourceContextState.initialLinkedWorkItemSeed,
    initialName: composerTargetStore.initialName,
    initialRepoId: composerTargetStore.initialRepoId,
    name: sourceContextState.name,
    newWorkspaceDraft: composerTargetStore.newWorkspaceDraft,
    note: sourceContextState.note,
    persistDraft: composerTargetStore.persistDraft,
    selectedRepo: runtimeTargetSelection.selectedRepo,
    selectedRepoConnectionId: runtimeTargetSelection.selectedRepoConnectionId,
    selectedRepoHookContextKey: runtimeTargetSelection.selectedRepoHookContextKey,
    selectedRepoIsGit: runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoSettings: runtimeTargetSelection.selectedRepoSettings,
    setName: sourceContextState.setName
  })
  const providerRuntimeSync = useComposerProviderRuntimeSync({
    promptCaretFrameRef: asyncComposerState.promptCaretFrameRef,
    repoId: initialTargetState.repoId,
    selectedRepo: runtimeTargetSelection.selectedRepo,
    selectedRepoExecutionHostId: runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoHookContextKey: runtimeTargetSelection.selectedRepoHookContextKey,
    selectedRepoIsGit: runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoPath: asyncComposerState.selectedRepoPath,
    selectedRepoSettings: runtimeTargetSelection.selectedRepoSettings,
    selectedRepoSettingsRef: asyncComposerState.selectedRepoSettingsRef,
    setCheckedHooksContextKey: asyncComposerState.setCheckedHooksContextKey,
    setSelectedRepoSlug: asyncComposerState.setSelectedRepoSlug,
    setSetupAgentStartupPolicy: asyncComposerState.setSetupAgentStartupPolicy,
    setYamlHooks: asyncComposerState.setYamlHooks,
    setupAgentStartupPolicyDraftRef: asyncComposerState.setupAgentStartupPolicyDraftRef,
    setupAgentStartupPolicyRef: asyncComposerState.setupAgentStartupPolicyRef,
    setupAgentStartupPolicySaveRef: asyncComposerState.setupAgentStartupPolicySaveRef,
    updateRepo: composerTargetStore.updateRepo
  })
  const derivedComposerState = useDerivedComposerState({
    agentPrompt: sourceContextState.agentPrompt,
    checkedHooksContextKey: asyncComposerState.checkedHooksContextKey,
    enableIssueAutomation: composerTargetStore.enableIssueAutomation,
    hasLoadedIssueCommand: asyncComposerState.hasLoadedIssueCommand,
    issueCommandTemplate: asyncComposerState.issueCommandTemplate,
    linkDebouncedQuery: asyncComposerState.linkDebouncedQuery,
    linkDirectItem: asyncComposerState.linkDirectItem,
    linkItems: asyncComposerState.linkItems,
    linkedIssue: workspaceIdentityState.linkedIssue,
    linkedPR: workspaceIdentityState.linkedPR,
    linkedWorkItem: sourceContextState.linkedWorkItem,
    name: sourceContextState.name,
    repoId: initialTargetState.repoId,
    selectedRepo: runtimeTargetSelection.selectedRepo,
    selectedRepoHookContextKey: runtimeTargetSelection.selectedRepoHookContextKey,
    selectedRepoIsGit: runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoSlug: asyncComposerState.selectedRepoSlug,
    setupDecision: asyncComposerState.setupDecision,
    sparseDirectories: asyncComposerState.sparseDirectories,
    sparseEnabled: asyncComposerState.sparseEnabled,
    sparsePresetsByRepo: composerTargetStore.sparsePresetsByRepo,
    sparseSelectedPresetId: asyncComposerState.sparseSelectedPresetId,
    worktreesByRepo: composerTargetStore.worktreesByRepo,
    yamlHooks: asyncComposerState.yamlHooks
  })
  useDraftTargetSync({
    agentPrompt: sourceContextState.agentPrompt,
    attachmentPaths: sourceContextState.attachmentPaths,
    baseBranch: workspaceIdentityState.baseBranch,
    compareBaseRef: workspaceIdentityState.compareBaseRef,
    eligibleRepos: composerTargetStore.eligibleRepos,
    fetchSparsePresets: composerTargetStore.fetchSparsePresets,
    folderSourceRepos: runtimeTargetSelection.folderSourceRepos,
    isProjectGroupTarget: runtimeTargetSelection.isProjectGroupTarget,
    linkedGitLabIssue: workspaceIdentityState.linkedGitLabIssue,
    linkedGitLabMR: workspaceIdentityState.linkedGitLabMR,
    linkedIssue: workspaceIdentityState.linkedIssue,
    linkedPR: workspaceIdentityState.linkedPR,
    linkedWorkItem: sourceContextState.linkedWorkItem,
    name: sourceContextState.name,
    note: sourceContextState.note,
    persistDraft: composerTargetStore.persistDraft,
    repoId: initialTargetState.repoId,
    selectedProjectGroup: initialTargetState.selectedProjectGroup,
    selectedRepo: runtimeTargetSelection.selectedRepo,
    selectedRepoIsGit: runtimeTargetSelection.selectedRepoIsGit,
    selectedWorkspaceTarget: runtimeTargetSelection.selectedWorkspaceTarget,
    setNewWorkspaceDraft: composerTargetStore.setNewWorkspaceDraft,
    setRepoId: sourceContextState.setRepoId,
    sparsePresetsByRepo: composerTargetStore.sparsePresetsByRepo,
    taskSourceContext: sourceContextState.taskSourceContext,
    tuiAgent: workspaceIdentityState.tuiAgent
  })
  return {
    composerTargetStore,
    initialTargetState,
    runtimeTargetSelection,
    sourceContextState,
    workspaceIdentityState,
    asyncComposerState,
    providerRuntimeSync,
    derivedComposerState
  }
}

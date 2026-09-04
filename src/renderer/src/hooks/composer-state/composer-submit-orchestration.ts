import type { ComposerTargetState } from './composer-target-state-contract'
import type { ComposerExternalSyncState } from './composer-external-sync-contract'
import type { ComposerSourceState } from './composer-source-state-contract'
import type { ComposerSubmitState } from './composer-submit-state-contract'
import { useFolderSubmitOrchestration } from './folder-submit-orchestration'
import { useFullSubmitSourcePreparation } from './full-submit-source-preparation'
import { useFullSubmitPreparation } from './full-submit-preparation'
import { useFullCreationExecution } from './full-creation-execution'
import { useFullSubmitOrchestration } from './full-submit-orchestration'
import { useMultipleCreateReset } from './multiple-create-reset'
import { useQuickSubmitSourcePreparation } from './quick-submit-source-preparation'
import { useQuickSubmitPreparation } from './quick-submit-preparation'
import { useQuickCreationExecution } from './quick-creation-execution'
import { useQuickSubmitAction } from './quick-submit-action'

export function useComposerSubmitOrchestration(
  target: ComposerTargetState,
  external: ComposerExternalSyncState,
  source: ComposerSourceState
): ComposerSubmitState {
  const folderSubmitOrchestration = useFolderSubmitOrchestration({
    clearNewWorkspaceDraft: target.composerTargetStore.clearNewWorkspaceDraft,
    createFolderWorkspace: target.composerTargetStore.createFolderWorkspace,
    decisions: target.composerTargetStore.decisions,
    disabledTuiAgents: target.workspaceIdentityState.disabledTuiAgents,
    folderCreateDisabled: source.composerNavigationActions.folderCreateDisabled,
    folderSourceRepos: target.runtimeTargetSelection.folderSourceRepos,
    folderTargetConnectionId: target.runtimeTargetSelection.folderTargetConnectionId,
    folderTargetIsRemote: target.runtimeTargetSelection.folderTargetIsRemote,
    folderTargetRuntimeEnvironmentId:
      target.runtimeTargetSelection.folderTargetRuntimeEnvironmentId,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    note: target.sourceContextState.note,
    onCreated: target.composerTargetStore.onCreated,
    persistDraft: target.composerTargetStore.persistDraft,
    resolvePendingSmartGitHubSubmit:
      external.githubSubmitResolution.resolvePendingSmartGitHubSubmit,
    selectedProjectGroup: target.initialTargetState.selectedProjectGroup,
    setCreateError: target.asyncComposerState.setCreateError,
    setCreating: target.asyncComposerState.setCreating,
    settings: target.composerTargetStore.settings,
    taskSourceContext: target.sourceContextState.taskSourceContext,
    telemetrySource: target.composerTargetStore.telemetrySource
  })
  const fullSubmitSourcePreparation = useFullSubmitSourcePreparation({
    agentPrompt: target.sourceContextState.agentPrompt,
    attachmentPaths: target.sourceContextState.attachmentPaths,
    baseBranch: target.workspaceIdentityState.baseBranch,
    branchNameOverride: target.workspaceIdentityState.branchNameOverride,
    compareBaseRef: target.workspaceIdentityState.compareBaseRef,
    decisions: target.composerTargetStore.decisions,
    effectiveLinkedPR: target.derivedComposerState.effectiveLinkedPR,
    enableIssueAutomation: target.composerTargetStore.enableIssueAutomation,
    fallbackCreatureName: target.derivedComposerState.fallbackCreatureName,
    hasLoadedIssueCommand: target.asyncComposerState.hasLoadedIssueCommand,
    issueCommandTemplate: target.asyncComposerState.issueCommandTemplate,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    linkedGitLabMR: target.workspaceIdentityState.linkedGitLabMR,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    parsedLinkedIssueNumber: target.derivedComposerState.parsedLinkedIssueNumber,
    pushTarget: target.workspaceIdentityState.pushTarget,
    workspaceSeedName: target.derivedComposerState.workspaceSeedName
  })
  const fullSubmitPreparation = useFullSubmitPreparation({
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    branchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.branchNameOverridePreservesNameEdits,
    currentIssueCommand: target.asyncComposerState.currentIssueCommand,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    issueCommandTemplate: target.asyncComposerState.issueCommandTemplate,
    name: target.sourceContextState.name,
    prepareFullSubmitSource: fullSubmitSourcePreparation.prepareFullSubmitSource,
    repoId: target.initialTargetState.repoId,
    resolvedSetupDecision: target.derivedComposerState.resolvedSetupDecision,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoAgentLaunchPlatform: target.runtimeTargetSelection.selectedRepoAgentLaunchPlatform,
    selectedRepoExecutionHostId: target.runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoIsRemote: target.runtimeTargetSelection.selectedRepoIsRemote,
    selectedRepoStartupShell: target.runtimeTargetSelection.selectedRepoStartupShell,
    settings: target.composerTargetStore.settings,
    smartNameMode: target.workspaceIdentityState.smartNameMode,
    telemetrySource: target.composerTargetStore.telemetrySource,
    tuiAgent: target.workspaceIdentityState.tuiAgent
  })
  const fullCreationExecution = useFullCreationExecution({
    applyWorktreeMeta: source.composerNavigationActions.applyWorktreeMeta,
    clearNewWorkspaceDraft: target.composerTargetStore.clearNewWorkspaceDraft,
    createWorktree: target.composerTargetStore.createWorktree,
    effectivePresetId: target.derivedComposerState.effectivePresetId,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    linkedGitLabIssue: target.workspaceIdentityState.linkedGitLabIssue,
    linkedGitLabMR: target.workspaceIdentityState.linkedGitLabMR,
    normalizedSparseDirectories: target.derivedComposerState.normalizedSparseDirectories,
    note: target.sourceContextState.note,
    onCreated: target.composerTargetStore.onCreated,
    parentWorktreeId: target.workspaceIdentityState.parentWorktreeId,
    persistDraft: target.composerTargetStore.persistDraft,
    persistSetupAgentStartupPolicy: target.providerRuntimeSync.persistSetupAgentStartupPolicy,
    prepareFullSubmit: fullSubmitPreparation.prepareFullSubmit,
    resolvedInitialWorkspaceStatus: target.initialTargetState.resolvedInitialWorkspaceStatus,
    selectedRepoExecutionHostId: target.runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoIsRemote: target.runtimeTargetSelection.selectedRepoIsRemote,
    setSidebarOpen: target.composerTargetStore.setSidebarOpen,
    settings: target.composerTargetStore.settings,
    sparseEnabled: target.asyncComposerState.sparseEnabled,
    taskSourceContext: target.sourceContextState.taskSourceContext,
    telemetrySource: target.composerTargetStore.telemetrySource,
    tuiAgent: target.workspaceIdentityState.tuiAgent
  })
  const fullSubmitOrchestration = useFullSubmitOrchestration({
    disabledTuiAgents: target.workspaceIdentityState.disabledTuiAgents,
    executeFullCreation: fullCreationExecution.executeFullCreation,
    fallbackDefaultAgent: target.workspaceIdentityState.fallbackDefaultAgent,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    repoId: target.initialTargetState.repoId,
    requiresExplicitSetupChoice: target.derivedComposerState.requiresExplicitSetupChoice,
    resolvePendingSmartGitHubSubmit:
      external.githubSubmitResolution.resolvePendingSmartGitHubSubmit,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoRequiresConnection: target.runtimeTargetSelection.selectedRepoRequiresConnection,
    setCreateError: target.asyncComposerState.setCreateError,
    setCreating: target.asyncComposerState.setCreating,
    setTuiAgent: target.workspaceIdentityState.setTuiAgent,
    setupDecision: target.asyncComposerState.setupDecision,
    shouldWaitForIssueAutomationCheck:
      target.derivedComposerState.shouldWaitForIssueAutomationCheck,
    shouldWaitForSetupCheck: target.derivedComposerState.shouldWaitForSetupCheck,
    showProjectRequiredError: source.branchStartPointActions.showProjectRequiredError,
    sourceIntentBlocksCreate: target.workspaceIdentityState.sourceIntentBlocksCreate,
    sparseError: target.derivedComposerState.sparseError,
    submitFolderTarget: folderSubmitOrchestration.submitFolderTarget,
    tuiAgent: target.workspaceIdentityState.tuiAgent,
    workspaceSeedName: target.derivedComposerState.workspaceSeedName
  })
  const multipleCreateReset = useMultipleCreateReset({
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    nameInputRef: target.asyncComposerState.nameInputRef,
    setAgentPrompt: target.sourceContextState.setAgentPrompt,
    setAttachmentPaths: target.sourceContextState.setAttachmentPaths,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
    setCreateError: target.asyncComposerState.setCreateError,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setName: target.sourceContextState.setName,
    setNote: target.sourceContextState.setNote,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setReuseSelectedBranch: target.workspaceIdentityState.setReuseSelectedBranch,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint
  })
  const quickSubmitSourcePreparation = useQuickSubmitSourcePreparation({
    baseBranch: target.workspaceIdentityState.baseBranch,
    branchNameOverride: target.workspaceIdentityState.branchNameOverride,
    compareBaseRef: target.workspaceIdentityState.compareBaseRef,
    disabledTuiAgents: target.workspaceIdentityState.disabledTuiAgents,
    effectiveLinkedPR: target.derivedComposerState.effectiveLinkedPR,
    decisions: target.composerTargetStore.decisions,
    fallbackCreatureName: target.derivedComposerState.fallbackCreatureName,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    linkedGitLabMR: target.workspaceIdentityState.linkedGitLabMR,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    parsedLinkedIssueNumber: target.derivedComposerState.parsedLinkedIssueNumber,
    pushTarget: target.workspaceIdentityState.pushTarget
  })
  const quickSubmitPreparation = useQuickSubmitPreparation({
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    branchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.branchNameOverridePreservesNameEdits,
    checkedHooksContextKey: target.asyncComposerState.checkedHooksContextKey,
    commitHookCheckIfCurrent: target.providerRuntimeSync.commitHookCheckIfCurrent,
    enableIssueAutomation: target.composerTargetStore.enableIssueAutomation,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    loadHookCheckForRepo: target.providerRuntimeSync.loadHookCheckForRepo,
    name: target.sourceContextState.name,
    note: target.sourceContextState.note,
    prepareQuickSubmitSource: quickSubmitSourcePreparation.prepareQuickSubmitSource,
    repoId: target.initialTargetState.repoId,
    resolvedSetupDecision: target.derivedComposerState.resolvedSetupDecision,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoExecutionHostId: target.runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoHookContextKey: target.runtimeTargetSelection.selectedRepoHookContextKey,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    setAdvancedOpen: target.asyncComposerState.setAdvancedOpen,
    setLoadedIssueCommand: target.asyncComposerState.setLoadedIssueCommand,
    settings: target.composerTargetStore.settings,
    setupConfig: target.derivedComposerState.setupConfig,
    setupDecision: target.asyncComposerState.setupDecision,
    setupPolicy: target.derivedComposerState.setupPolicy,
    smartNameMode: target.workspaceIdentityState.smartNameMode
  })
  const quickCreationExecution = useQuickCreationExecution({
    clearNewWorkspaceDraft: target.composerTargetStore.clearNewWorkspaceDraft,
    createMultiple: target.asyncComposerState.createMultiple,
    effectivePresetId: target.derivedComposerState.effectivePresetId,
    ephemeralVmRecipes: target.runtimeTargetSelection.ephemeralVmRecipes,
    ephemeralVmsEnabled: target.runtimeTargetSelection.ephemeralVmsEnabled,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    linkedGitLabIssue: target.workspaceIdentityState.linkedGitLabIssue,
    linkedGitLabMR: target.workspaceIdentityState.linkedGitLabMR,
    normalizedSparseDirectories: target.derivedComposerState.normalizedSparseDirectories,
    onCreated: target.composerTargetStore.onCreated,
    parentWorktreeId: target.workspaceIdentityState.parentWorktreeId,
    persistDraft: target.composerTargetStore.persistDraft,
    persistSetupAgentStartupPolicy: target.providerRuntimeSync.persistSetupAgentStartupPolicy,
    prepareQuickSubmit: quickSubmitPreparation.prepareQuickSubmit,
    resetForNextCreate: multipleCreateReset.resetForNextCreate,
    resolvedInitialWorkspaceStatus: target.initialTargetState.resolvedInitialWorkspaceStatus,
    selectedEphemeralVmRecipeId: target.runtimeTargetSelection.selectedEphemeralVmRecipeId,
    selectedRepoAgentLaunchPlatform: target.runtimeTargetSelection.selectedRepoAgentLaunchPlatform,
    selectedRepoExecutionHostId: target.runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoIsRemote: target.runtimeTargetSelection.selectedRepoIsRemote,
    selectedRepoSettings: target.runtimeTargetSelection.selectedRepoSettings,
    selectedRepoStartupShell: target.runtimeTargetSelection.selectedRepoStartupShell,
    selectedWorkspaceTarget: target.runtimeTargetSelection.selectedWorkspaceTarget,
    settings: target.composerTargetStore.settings,
    sparseEnabled: target.asyncComposerState.sparseEnabled,
    taskSourceContext: target.sourceContextState.taskSourceContext,
    telemetrySource: target.composerTargetStore.telemetrySource
  })
  const quickSubmitAction = useQuickSubmitAction({
    effectiveLinkedPR: target.derivedComposerState.effectiveLinkedPR,
    executeQuickCreation: quickCreationExecution.executeQuickCreation,
    fallbackCreatureName: target.derivedComposerState.fallbackCreatureName,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    linkedPR: target.workspaceIdentityState.linkedPR,
    name: target.sourceContextState.name,
    onCreated: target.composerTargetStore.onCreated,
    parsedLinkedIssueNumber: target.derivedComposerState.parsedLinkedIssueNumber,
    repoId: target.initialTargetState.repoId,
    requiresExplicitSetupChoice: target.derivedComposerState.requiresExplicitSetupChoice,
    resolvePendingSmartGitHubSubmit:
      external.githubSubmitResolution.resolvePendingSmartGitHubSubmit,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoRequiresConnection: target.runtimeTargetSelection.selectedRepoRequiresConnection,
    selectedWorkspaceTarget: target.runtimeTargetSelection.selectedWorkspaceTarget,
    setCreateError: target.asyncComposerState.setCreateError,
    setCreating: target.asyncComposerState.setCreating,
    setupDecision: target.asyncComposerState.setupDecision,
    showProjectRequiredError: source.branchStartPointActions.showProjectRequiredError,
    sourceIntentBlocksCreate: target.workspaceIdentityState.sourceIntentBlocksCreate,
    sparseError: target.derivedComposerState.sparseError,
    submitFolderTarget: folderSubmitOrchestration.submitFolderTarget
  })
  return {
    folderSubmitOrchestration,
    fullSubmitSourcePreparation,
    fullSubmitPreparation,
    fullCreationExecution,
    fullSubmitOrchestration,
    multipleCreateReset,
    quickSubmitSourcePreparation,
    quickSubmitPreparation,
    quickCreationExecution,
    quickSubmitAction
  }
}

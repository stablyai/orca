import type { ComposerTargetState } from './composer-target-state-contract'
import type { ComposerExternalSyncState } from './composer-external-sync-contract'
import type { ComposerSourceState } from './composer-source-state-contract'
import { useSourceIdentityActions } from './source-identity-actions'
import { useAttachmentDropState } from './attachment-drop-state'
import { useTargetChangeActions } from './target-change-actions'
import { useProjectTargetActions } from './project-target-actions'
import { useBranchStartPointActions } from './branch-start-point-actions'
import { useGitHubProviderSelection } from './github-provider-selection'
import { useGitLabProviderSelection } from './gitlab-provider-selection'
import { useWorkItemSourceActions } from './work-item-source-actions'
import { useIssueSourceActions } from './issue-source-actions'
import { useComposerNavigationActions } from './composer-navigation-actions'

export function useComposerSourceState(
  target: ComposerTargetState,
  external: ComposerExternalSyncState
): ComposerSourceState {
  const sourceIdentityActions = useSourceIdentityActions({
    applyLinkedWorkItem: external.githubSourceApplication.applyLinkedWorkItem,
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    branchNameOverride: target.workspaceIdentityState.branchNameOverride,
    branchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.branchNameOverridePreservesNameEdits,
    forkPushWarning: target.workspaceIdentityState.forkPushWarning,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    pushTarget: target.workspaceIdentityState.pushTarget,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCreateError: target.asyncComposerState.setCreateError,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setLinkDebouncedQuery: target.asyncComposerState.setLinkDebouncedQuery,
    setLinkDirectItem: target.asyncComposerState.setLinkDirectItem,
    setLinkPopoverOpen: target.asyncComposerState.setLinkPopoverOpen,
    setLinkQuery: target.asyncComposerState.setLinkQuery,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setName: target.sourceContextState.setName,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setReuseEligibleBranch: target.workspaceIdentityState.setReuseEligibleBranch,
    setReuseSelectedBranch: target.workspaceIdentityState.setReuseSelectedBranch,
    smartGitHubPrStartPointSelectionRef:
      target.asyncComposerState.smartGitHubPrStartPointSelectionRef
  })
  const attachmentDropState = useAttachmentDropState({
    agentPromptRef: target.asyncComposerState.agentPromptRef,
    cancelPromptCaretFrame: target.providerRuntimeSync.cancelPromptCaretFrame,
    connectionId: target.workspaceIdentityState.connectionId,
    promptCaretFrameRef: target.asyncComposerState.promptCaretFrameRef,
    promptTextareaRef: target.asyncComposerState.promptTextareaRef,
    selectedRepoPath: target.asyncComposerState.selectedRepoPath,
    selectedRepoSettings: target.runtimeTargetSelection.selectedRepoSettings,
    setAgentPrompt: target.sourceContextState.setAgentPrompt,
    setAttachmentPaths: target.sourceContextState.setAttachmentPaths
  })
  const targetChangeActions = useTargetChangeActions({
    baseBranch: target.workspaceIdentityState.baseBranch,
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    decisions: target.composerTargetStore.decisions,
    folderSourceRepos: target.runtimeTargetSelection.folderSourceRepos,
    hostOptions: target.composerTargetStore.hostOptions,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    projectHostSetupOptions: target.runtimeTargetSelection.projectHostSetupOptions,
    repoId: target.initialTargetState.repoId,
    selectedRepoProjectId: target.runtimeTargetSelection.selectedRepoProjectId,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setProjectError: target.initialTargetState.setProjectError,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setRepoId: target.sourceContextState.setRepoId,
    setReuseEligibleBranch: target.workspaceIdentityState.setReuseEligibleBranch,
    setReuseSelectedBranch: target.workspaceIdentityState.setReuseSelectedBranch,
    setSelectedProjectHostSetupOverrideId:
      target.initialTargetState.setSelectedProjectHostSetupOverrideId,
    setSparseDirectories: target.asyncComposerState.setSparseDirectories,
    setSparseEnabled: target.asyncComposerState.setSparseEnabled,
    setSparseSelectedPresetId: target.asyncComposerState.setSparseSelectedPresetId,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint,
    smartGitHubPrStartPointSelectionRef:
      target.asyncComposerState.smartGitHubPrStartPointSelectionRef
  })
  const projectTargetActions = useProjectTargetActions({
    actionableHostIds: target.composerTargetStore.actionableHostIds,
    eligibleRepos: target.composerTargetStore.eligibleRepos,
    handleRepoChange: targetChangeActions.handleRepoChange,
    initialProjectGroupAppliedRef: target.initialTargetState.initialProjectGroupAppliedRef,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    projectGroups: target.composerTargetStore.projectGroups,
    projectHostSetups: target.composerTargetStore.projectHostSetups,
    projects: target.composerTargetStore.projects,
    repos: target.composerTargetStore.repos,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setProjectError: target.initialTargetState.setProjectError,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setRepoId: target.sourceContextState.setRepoId,
    setReuseEligibleBranch: target.workspaceIdentityState.setReuseEligibleBranch,
    setReuseSelectedBranch: target.workspaceIdentityState.setReuseSelectedBranch,
    setSelectedProjectGroupId: target.initialTargetState.setSelectedProjectGroupId,
    setSparseDirectories: target.asyncComposerState.setSparseDirectories,
    setSparseEnabled: target.asyncComposerState.setSparseEnabled,
    setSparseSelectedPresetId: target.asyncComposerState.setSparseSelectedPresetId,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint,
    selectedWorkspaceTarget: target.runtimeTargetSelection.selectedWorkspaceTarget,
    workspaceHostScope: target.composerTargetStore.workspaceHostScope
  })
  const branchStartPointActions = useBranchStartPointActions({
    applyLinkedGitLabWorkItem: sourceIdentityActions.applyLinkedGitLabWorkItem,
    applyLinkedWorkItem: external.githubSourceApplication.applyLinkedWorkItem,
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    handleRepoChange: targetChangeActions.handleRepoChange,
    initialProjectGroupAppliedRef: target.initialTargetState.initialProjectGroupAppliedRef,
    lastAutoNoteRef: target.asyncComposerState.lastAutoNoteRef,
    noteRef: target.asyncComposerState.noteRef,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setNote: target.sourceContextState.setNote,
    setProjectError: target.initialTargetState.setProjectError,
    setSelectedProjectGroupId: target.initialTargetState.setSelectedProjectGroupId,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setReuseEligibleBranch: target.workspaceIdentityState.setReuseEligibleBranch,
    setReuseSelectedBranch: target.workspaceIdentityState.setReuseSelectedBranch,
    setSparseDirectories: target.asyncComposerState.setSparseDirectories,
    setSparseEnabled: target.asyncComposerState.setSparseEnabled,
    setSparseSelectedPresetId: target.asyncComposerState.setSparseSelectedPresetId,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint,
    smartGitHubPrStartPointSelectionRef:
      target.asyncComposerState.smartGitHubPrStartPointSelectionRef
  })
  const githubProviderSelection = useGitHubProviderSelection({
    applyLinkedWorkItem: external.githubSourceApplication.applyLinkedWorkItem,
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    eligibleRepos: target.composerTargetStore.eligibleRepos,
    handleBaseBranchPrSelect: branchStartPointActions.handleBaseBranchPrSelect,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    name: target.sourceContextState.name,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoGitHubSourceContext: target.sourceContextState.selectedRepoGitHubSourceContext,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setName: target.sourceContextState.setName,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint,
    settings: target.composerTargetStore.settings,
    smartGitHubPrStartPointSelectionRef:
      target.asyncComposerState.smartGitHubPrStartPointSelectionRef
  })
  const gitlabProviderSelection = useGitLabProviderSelection({
    applyLinkedGitLabWorkItem: sourceIdentityActions.applyLinkedGitLabWorkItem,
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    eligibleRepos: target.composerTargetStore.eligibleRepos,
    handleBaseBranchMrSelect: branchStartPointActions.handleBaseBranchMrSelect,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    name: target.sourceContextState.name,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setName: target.sourceContextState.setName,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint,
    settings: target.composerTargetStore.settings
  })
  const workItemSourceActions = useWorkItemSourceActions({
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    name: target.sourceContextState.name,
    repoId: target.initialTargetState.repoId,
    reuseEligibleBranch: target.workspaceIdentityState.reuseEligibleBranch,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setName: target.sourceContextState.setName,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setReuseEligibleBranch: target.workspaceIdentityState.setReuseEligibleBranch,
    setReuseSelectedBranch: target.workspaceIdentityState.setReuseSelectedBranch,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint,
    smartGitHubPrStartPointSelectionRef:
      target.asyncComposerState.smartGitHubPrStartPointSelectionRef,
    worktreesByRepo: target.composerTargetStore.worktreesByRepo
  })
  const issueSourceActions = useIssueSourceActions({
    baseBranch: target.workspaceIdentityState.baseBranch,
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    lastAutoNoteRef: target.asyncComposerState.lastAutoNoteRef,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    noteRef: target.asyncComposerState.noteRef,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
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
    setReuseEligibleBranch: target.workspaceIdentityState.setReuseEligibleBranch,
    setReuseSelectedBranch: target.workspaceIdentityState.setReuseSelectedBranch,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint,
    smartGitHubPrStartPointSelectionRef:
      target.asyncComposerState.smartGitHubPrStartPointSelectionRef
  })
  const composerNavigationActions = useComposerNavigationActions({
    closeModal: target.composerTargetStore.closeModal,
    creating: target.asyncComposerState.creating,
    folderPathStatusBlocksCreate: target.runtimeTargetSelection.folderPathStatusBlocksCreate,
    folderTargetRequiresConnection: target.runtimeTargetSelection.folderTargetRequiresConnection,
    openSettingsPage: target.composerTargetStore.openSettingsPage,
    openSettingsTarget: target.composerTargetStore.openSettingsTarget,
    selectedProjectGroup: target.initialTargetState.selectedProjectGroup,
    setActiveRuntimeEnvironmentPreference:
      target.composerTargetStore.setActiveRuntimeEnvironmentPreference,
    smartNameJiraSourceContext: target.sourceContextState.smartNameJiraSourceContext,
    sourceIntentBlocksCreate: target.workspaceIdentityState.sourceIntentBlocksCreate,
    updateWorktreeMeta: target.composerTargetStore.updateWorktreeMeta
  })
  return {
    sourceIdentityActions,
    attachmentDropState,
    targetChangeActions,
    projectTargetActions,
    branchStartPointActions,
    githubProviderSelection,
    gitlabProviderSelection,
    workItemSourceActions,
    issueSourceActions,
    composerNavigationActions
  }
}

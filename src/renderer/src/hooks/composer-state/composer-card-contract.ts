import type { ComposerModel } from './composer-model'

export type ComposerCardSourceProps = Pick<
  ComposerModel,
  | 'eligibleRepos'
  | 'repoId'
  | 'projectOptions'
  | 'selectedProjectId'
  | 'selectedRepoIsGit'
  | 'projectHostSetupOptions'
  | 'selectedProjectHostSetupId'
  | 'ephemeralVmRecipes'
  | 'selectedEphemeralVmRecipeId'
  | 'ephemeralVmRecipeError'
  | 'name'
  | 'branchNameOverride'
  | 'smartNameSelection'
  | 'reuseSelectedBranch'
  | 'createMultiple'
  | 'agentPrompt'
  | 'attachmentPaths'
  | 'linkedWorkItem'
  | 'linkPopoverOpen'
  | 'linkQuery'
  | 'filteredLinkItems'
  | 'linkItemsLoading'
  | 'linkDirectLoading'
  | 'normalizedLinkQuery'
  | 'tuiAgent'
  | 'detectedAgentIds'
  | 'advancedOpen'
  | 'projectError'
  | 'creating'
  | 'note'
  | 'baseBranch'
  | 'selectedRepoIsRemote'
  | 'selectedRepoConnectionId'
  | 'selectedRepoSshStatus'
  | 'selectedRepoRequiresConnection'
  | 'selectedRepoConnectInProgress'
  | 'onConnectSelectedRepo'
  | 'startFromResetHint'
  | 'forkPushWarning'
  | 'setupConfig'
  | 'requiresExplicitSetupChoice'
  | 'setupDecision'
  | 'setupAgentStartupPolicy'
  | 'shouldWaitForSetupCheck'
  | 'resolvedSetupDecision'
  | 'createError'
  | 'sparsePresets'
  | 'sparseSelectedPresetId'
>

export type ComposerCardActionProps = {
  onRepoChange: ComposerModel['handleRepoChange']
  onProjectChange: ComposerModel['handleProjectChange']
  onProjectHostSetupChange: ComposerModel['handleProjectHostSetupChange']
  onEphemeralVmRecipeChange: ComposerModel['setSelectedEphemeralVmRecipeId']
  repoBackedSearchRepos?: ComposerModel['eligibleRepos']
  repoBackedSourcesDisabled?: boolean
  allowSmartNameAddProject?: boolean
  smartNameRepoSwitchTarget?: 'project' | 'task-source'
  onNameValueChange: ComposerModel['handleNameValueChange']
  onBranchNameOverrideChange: ComposerModel['handleBranchNameOverrideChange']
  onSmartGitHubItemSelect: ComposerModel['handleSmartGitHubItemSelect']
  onSmartGitLabItemSelect: ComposerModel['handleSmartGitLabItemSelect']
  onSmartBranchSelect: ComposerModel['handleSmartBranchSelect']
  onSmartNameModeChange?: ComposerModel['setSmartNameMode']
  onSmartLinearIssueSelect: ComposerModel['handleSmartLinearIssueSelect']
  onSmartJiraIssueSelect: ComposerModel['handleSmartJiraIssueSelect']
  onOpenJiraSettings: ComposerModel['handleOpenJiraSettings']
  smartNameGitHubSourceContext?: ComposerModel['selectedRepoGitHubSourceContext']
  smartNameJiraSourceContext?: ComposerModel['smartNameJiraSourceContext']
  onBaseBranchMrSelect?: ComposerModel['handleBaseBranchMrSelect']
  onClearSmartNameSelection: ComposerModel['handleClearSmartNameSelection']
  canReuseSelectedBranch: boolean
  onReuseSelectedBranchChange: ComposerModel['handleReuseSelectedBranchChange']
  showCreateMultiple: boolean
  onCreateMultipleChange: ComposerModel['setCreateMultiple']
  onAgentPromptChange: ComposerModel['setAgentPrompt']
  linkedOnlyTemplatePreview: string | null
  getAttachmentLabel: (pathValue: string) => string
  onAddAttachment: () => void
  onRemoveAttachment: (pathValue: string) => void
  onRemoveLinkedWorkItem: ComposerModel['handleRemoveLinkedWorkItem']
  onLinkPopoverOpenChange: ComposerModel['handleLinkPopoverChange']
  onLinkQueryChange: ComposerModel['setLinkQuery']
  onSelectLinkedItem: ComposerModel['handleSelectLinkedItem']
  onTuiAgentChange: ComposerModel['setTuiAgent']
  onOpenAgentSettings: ComposerModel['handleOpenAgentSettings']
  onToggleAdvanced: () => void
  createDisabled: boolean
  onCreate: () => void
  onNoteChange: ComposerModel['setNote']
  onBaseBranchChange: ComposerModel['handleBaseBranchChange']
  onBaseBranchPrSelect: ComposerModel['handleBaseBranchPrSelect']
  baseBranchLinkedPrNumber: number | null
  branchesEnabled?: boolean
  setupControlsEnabled?: boolean
  onSetupDecisionChange: ComposerModel['setSetupDecision']
  onSetupAgentStartupPolicyChange: ComposerModel['handleSetupAgentStartupPolicyChange']
  canUseSparseCheckout: boolean
  selectedRepoPath: string | null
  onSparseSelectPreset: ComposerModel['handleSparseSelectPreset']
  sparseControlsEnabled?: boolean
}

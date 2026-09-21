import type { ComposerModel } from './composer-model'
export type ComposerSourceState = {
  sourceIdentityActions: Pick<
    ComposerModel,
    | 'applyLinkedGitLabWorkItem'
    | 'handleSelectLinkedItem'
    | 'handleLinkPopoverChange'
    | 'handleRemoveLinkedWorkItem'
    | 'handleNameValueChange'
    | 'handleBranchNameOverrideChange'
  >
  attachmentDropState: Pick<
    ComposerModel,
    | 'addComposerAttachments'
    | 'insertComposerFolderPaths'
    | 'uploadComposerPaths'
    | 'handleAddAttachment'
    | 'applyLocalComposerDrop'
  >
  targetChangeActions: Pick<
    ComposerModel,
    'handleRepoChange' | 'handleFolderSourceRepoChange' | 'handleProjectHostSetupChange'
  >
  projectTargetActions: Pick<ComposerModel, 'handleProjectChange'>
  branchStartPointActions: Pick<
    ComposerModel,
    | 'showProjectRequiredError'
    | 'handleSparseSelectPreset'
    | 'handleBaseBranchChange'
    | 'handleBaseBranchPrSelect'
    | 'handleBaseBranchMrSelect'
    | 'selectAddedProjectRepo'
  >
  githubProviderSelection: Pick<ComposerModel, 'handleSmartGitHubItemSelect'>
  gitlabProviderSelection: Pick<ComposerModel, 'handleSmartGitLabItemSelect'>
  workItemSourceActions: Pick<
    ComposerModel,
    'handleSmartBranchSelect' | 'handleReuseSelectedBranchChange'
  >
  issueSourceActions: Pick<
    ComposerModel,
    | 'handleSmartLinearIssueSelect'
    | 'handleSmartJiraIssueSelect'
    | 'handleClearSmartNameSelection'
    | 'smartNameSelection'
  >
  composerNavigationActions: Pick<
    ComposerModel,
    | 'handleOpenAgentSettings'
    | 'handleOpenJiraSettings'
    | 'applyWorktreeMeta'
    | 'folderCreateDisabled'
  >
}

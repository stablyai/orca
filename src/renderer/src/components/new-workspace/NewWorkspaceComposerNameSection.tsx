import React from 'react'
import { AlertTriangle } from 'lucide-react'
import SmartWorkspaceNameField from '@/components/new-workspace/SmartWorkspaceNameField'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { shouldShowComposerBaseRefPicker } from './base-ref-picker-visibility'
import { ComposerBaseRefPicker } from './ComposerBaseRefPicker'
import { ComposerBranchChoice } from './ComposerBranchChoice'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerNameSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'nameInputRef'
  | 'eligibleRepos'
  | 'selectedRepo'
  | 'repoId'
  | 'onRepoChange'
  | 'name'
  | 'onNameValueChange'
  | 'onSmartGitHubItemSelect'
  | 'onSmartGitLabItemSelect'
  | 'onSmartBranchSelect'
  | 'onSmartLinearIssueSelect'
  | 'onSmartJiraIssueSelect'
  | 'onOpenJiraSettings'
  | 'smartNameSelection'
  | 'onClearSmartNameSelection'
  | 'smartNameGitHubSourceContext'
  | 'smartNameJiraSourceContext'
  | 'selectedRepoRequiresConnection'
  | 'selectedRepoIsGit'
  | 'branchesEnabled'
  | 'repoBackedSourcesDisabled'
  | 'repoBackedSearchRepos'
  | 'allowSmartNameAddProject'
  | 'smartNameRepoSwitchTarget'
  | 'onSmartNameModeChange'
  | 'smartNameMode'
  | 'forkPushWarning'
  | 'canReuseSelectedBranch'
  | 'reuseSelectedBranch'
  | 'reuseEligibleBranch'
  | 'branchNameOverride'
  | 'onBranchNameOverrideChange'
  | 'onReuseSelectedBranchChange'
  | 'onOpenSelectedBranchWorkspace'
  | 'baseBranch'
  | 'onBaseBranchChange'
  | 'startFromResetHint'
> & {
  onNamePlainEnter: () => void
}

export function NewWorkspaceComposerNameSection({
  nameInputRef,
  eligibleRepos,
  selectedRepo,
  repoId,
  onRepoChange,
  name,
  onNameValueChange,
  onSmartGitHubItemSelect,
  onSmartGitLabItemSelect,
  onSmartBranchSelect,
  onSmartLinearIssueSelect,
  onSmartJiraIssueSelect,
  onOpenJiraSettings,
  smartNameSelection,
  onClearSmartNameSelection,
  smartNameGitHubSourceContext,
  smartNameJiraSourceContext,
  selectedRepoRequiresConnection,
  selectedRepoIsGit,
  branchesEnabled = true,
  repoBackedSourcesDisabled = false,
  repoBackedSearchRepos,
  allowSmartNameAddProject = true,
  smartNameRepoSwitchTarget = 'project',
  onSmartNameModeChange,
  smartNameMode,
  onNamePlainEnter,
  forkPushWarning,
  canReuseSelectedBranch,
  reuseSelectedBranch,
  reuseEligibleBranch,
  branchNameOverride,
  onBranchNameOverrideChange,
  onReuseSelectedBranchChange,
  onOpenSelectedBranchWorkspace,
  baseBranch,
  onBaseBranchChange,
  startFromResetHint
}: NewWorkspaceComposerNameSectionProps): React.JSX.Element {
  const showBaseRefPicker =
    Boolean(onBaseBranchChange) &&
    shouldShowComposerBaseRefPicker({
      selectedRepoIsGit,
      branchesEnabled,
      smartNameMode: smartNameMode ?? 'smart',
      smartNameSelectionKind: smartNameSelection?.kind ?? null
    })
  return (
    <div className="min-w-0 space-y-1" data-contextual-tour-target="workspace-creation-name">
      <div className="flex items-center justify-between gap-2">
        <label className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {selectedRepoIsGit
            ? translate('auto.components.NewWorkspaceComposerCard.ac3748dcda', 'Create From')
            : translate(
                'auto.components.NewWorkspaceComposerCard.0ee17638fe',
                'Workspace name'
              )}{' '}
          <span className="text-muted-foreground/70">
            {translate('auto.components.NewWorkspaceComposerCard.0c5d6a479c', '[Optional]')}
          </span>
        </label>
        {showBaseRefPicker && onBaseBranchChange ? (
          <ComposerBaseRefPicker
            repoId={repoId}
            baseBranch={baseBranch}
            onBaseBranchChange={onBaseBranchChange}
            resetHint={startFromResetHint}
            readOnly={selectedRepoRequiresConnection}
          />
        ) : null}
      </div>
      <SmartWorkspaceNameField
        inputRef={nameInputRef}
        repos={eligibleRepos}
        selectedRepo={selectedRepo}
        repoId={repoId}
        onRepoChange={onRepoChange}
        value={name}
        onValueChange={onNameValueChange}
        onGitHubItemSelect={onSmartGitHubItemSelect}
        onGitLabItemSelect={onSmartGitLabItemSelect}
        onBranchSelect={onSmartBranchSelect}
        onLinearIssueSelect={onSmartLinearIssueSelect}
        onJiraIssueSelect={onSmartJiraIssueSelect}
        onOpenJiraSettings={onOpenJiraSettings}
        selectedSource={smartNameSelection}
        onClearSelectedSource={onClearSmartNameSelection}
        githubSourceContext={smartNameGitHubSourceContext}
        jiraSourceContext={smartNameJiraSourceContext}
        disabled={selectedRepoRequiresConnection}
        disabledPlaceholder={translate(
          'auto.components.NewWorkspaceComposerCard.connectProjectFirst',
          'Connect this project first'
        )}
        textOnly={!selectedRepoIsGit}
        branchesEnabled={branchesEnabled}
        repoBackedSourcesDisabled={repoBackedSourcesDisabled}
        repoBackedSearchRepos={repoBackedSearchRepos}
        allowCrossRepoProjectAdd={allowSmartNameAddProject}
        crossRepoSwitchTarget={smartNameRepoSwitchTarget}
        onActiveSourceModeChange={onSmartNameModeChange}
        onPlainEnter={onNamePlainEnter}
      />
      {forkPushWarning ? (
        <p className="flex items-start gap-1.5 text-[11px] text-yellow-600 dark:text-yellow-500">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{forkPushWarning}</span>
        </p>
      ) : null}
      <div
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          canReuseSelectedBranch ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        aria-hidden={!canReuseSelectedBranch}
        inert={!canReuseSelectedBranch}
      >
        <div className="min-h-0">
          <div className="pt-3">
            <ComposerBranchChoice
              existingBranchName={reuseEligibleBranch ?? smartNameSelection?.label}
              reuseSelectedBranch={reuseSelectedBranch}
              onReuseSelectedBranchChange={onReuseSelectedBranchChange}
              branchNameOverride={branchNameOverride}
              onBranchNameOverrideChange={onBranchNameOverrideChange}
              onOpenSelectedBranchWorkspace={onOpenSelectedBranchWorkspace}
              disabled={!canReuseSelectedBranch}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

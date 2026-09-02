import React from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import SmartWorkspaceNameField from '@/components/new-workspace/SmartWorkspaceNameField'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerNameSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'nameInputRef'
  | 'eligibleRepos'
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
  | 'forkPushWarning'
  | 'canReuseSelectedBranch'
  | 'reuseSelectedBranch'
  | 'onReuseSelectedBranchChange'
> & {
  onNamePlainEnter: () => void
}

export function NewWorkspaceComposerNameSection({
  nameInputRef,
  eligibleRepos,
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
  onNamePlainEnter,
  forkPushWarning,
  canReuseSelectedBranch,
  reuseSelectedBranch,
  onReuseSelectedBranchChange
}: NewWorkspaceComposerNameSectionProps): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-1" data-contextual-tour-target="workspace-creation-name">
      <label className="block min-w-0 truncate text-xs font-medium text-muted-foreground">
        {selectedRepoIsGit
          ? translate(
              'auto.components.NewWorkspaceComposerCard.ac3748dcda',
              "Name or 'Create From'"
            )
          : translate('auto.components.NewWorkspaceComposerCard.0ee17638fe', 'Workspace name')}{' '}
        <span className="text-muted-foreground/70">
          {translate('auto.components.NewWorkspaceComposerCard.0c5d6a479c', '[Optional]')}
        </span>
      </label>
      <SmartWorkspaceNameField
        inputRef={nameInputRef}
        repos={eligibleRepos}
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
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
          canReuseSelectedBranch ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        aria-hidden={!canReuseSelectedBranch}
      >
        <div className="min-h-0">
          <div className="space-y-1 pt-1">
            <label className="group flex w-fit items-center gap-2 text-xs text-foreground">
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-[3px] border shadow-sm transition',
                  reuseSelectedBranch
                    ? 'border-emerald-500/60 bg-emerald-500 text-white'
                    : 'border-foreground/20 bg-background dark:border-white/20 dark:bg-muted/10'
                )}
              >
                <Check
                  className={cn(
                    'size-3 transition-opacity',
                    reuseSelectedBranch ? 'opacity-100' : 'opacity-0'
                  )}
                />
              </span>
              <input
                type="checkbox"
                checked={reuseSelectedBranch}
                onChange={(event) => onReuseSelectedBranchChange(event.target.checked)}
                disabled={!canReuseSelectedBranch}
                className="sr-only"
              />
              <span>
                {translate(
                  'auto.components.NewWorkspaceComposerCard.reuseExistingBranch',
                  'Reuse branch'
                )}
              </span>
            </label>
            <p className="pl-6 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.NewWorkspaceComposerCard.reuseExistingBranchHint',
                'Check out the existing branch instead of creating a new one from it.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

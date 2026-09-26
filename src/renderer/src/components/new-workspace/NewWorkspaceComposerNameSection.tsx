import React from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import SmartWorkspaceNameField from '@/components/new-workspace/SmartWorkspaceNameField'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { shouldShowComposerBaseRefPicker } from './base-ref-picker-visibility'
import { ComposerBaseRefPicker } from './ComposerBaseRefPicker'
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
  | 'onSmartBusinessmapCardSelect'
  | 'onOpenJiraSettings'
  | 'smartNameSelection'
  | 'onClearSmartNameSelection'
  | 'smartNameGitHubSourceContext'
  | 'smartNameJiraSourceContext'
  | 'smartNameBusinessmapSourceContext'
  | 'selectedRepoRequiresConnection'
  | 'selectedRepoIsGit'
  | 'branchesEnabled'
  | 'repoBackedSourcesDisabled'
  | 'repoBackedSearchRepos'
  | 'allowSmartNameAddProject'
  | 'smartNameRepoSwitchTarget'
  | 'forkPushWarning'
  | 'canReuseSelectedBranch'
  | 'reuseSelectedBranch'
  | 'onReuseSelectedBranchChange'
  | 'baseBranch'
  | 'onBaseBranchChange'
  | 'startFromResetHint'
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
  onSmartBusinessmapCardSelect,
  onOpenJiraSettings,
  smartNameSelection,
  onClearSmartNameSelection,
  smartNameGitHubSourceContext,
  smartNameJiraSourceContext,
  smartNameBusinessmapSourceContext,
  selectedRepoRequiresConnection,
  selectedRepoIsGit,
  branchesEnabled = true,
  repoBackedSourcesDisabled = false,
  repoBackedSearchRepos,
  allowSmartNameAddProject = true,
  smartNameRepoSwitchTarget = 'project',
  onNamePlainEnter,
  forkPushWarning,
  canReuseSelectedBranch,
  reuseSelectedBranch,
  onReuseSelectedBranchChange,
  baseBranch,
  onBaseBranchChange,
  startFromResetHint
}: NewWorkspaceComposerNameSectionProps): React.JSX.Element {
  const showBaseRefPicker =
    Boolean(onBaseBranchChange) &&
    shouldShowComposerBaseRefPicker({
      selectedRepoIsGit,
      branchesEnabled,
      smartNameMode: 'smart',
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
        repoId={repoId}
        onRepoChange={onRepoChange}
        value={name}
        onValueChange={onNameValueChange}
        onGitHubItemSelect={onSmartGitHubItemSelect}
        onGitLabItemSelect={onSmartGitLabItemSelect}
        onBranchSelect={onSmartBranchSelect}
        onLinearIssueSelect={onSmartLinearIssueSelect}
        onJiraIssueSelect={onSmartJiraIssueSelect}
        onBusinessmapCardSelect={onSmartBusinessmapCardSelect}
        onOpenJiraSettings={onOpenJiraSettings}
        selectedSource={smartNameSelection}
        onClearSelectedSource={onClearSmartNameSelection}
        githubSourceContext={smartNameGitHubSourceContext}
        jiraSourceContext={smartNameJiraSourceContext}
        businessmapSourceContext={smartNameBusinessmapSourceContext}
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

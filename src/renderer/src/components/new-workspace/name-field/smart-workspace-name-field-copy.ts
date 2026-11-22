import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SmartNameMode } from '../../../../../shared/new-workspace/smart-workspace-source-results'

export function getSmartWorkspaceNameFieldCopy(
  {
    repoBackedSourcesDisabled,
    linearAvailable,
    branchesEnabled,
    crossRepoSwitchTarget,
    disabled,
    disabledPlaceholder,
    mode
  }: {
    repoBackedSourcesDisabled: boolean
    linearAvailable: boolean
    branchesEnabled: boolean
    crossRepoSwitchTarget: 'project' | 'task-source'
    disabled: boolean
    disabledPlaceholder?: string
    mode: SmartNameMode
  },
  t: Translate = translate
) {
  const smartPlaceholder = repoBackedSourcesDisabled
    ? linearAvailable
      ? t(
          'auto.components.new.workspace.SmartWorkspaceNameField.placeholderNameOrLinearUrl',
          'Type a name, Linear URL, or Jira URL'
        )
      : t(
          'auto.components.new.workspace.SmartWorkspaceNameField.placeholderWorkspaceName',
          'Type a workspace name'
        )
    : linearAvailable
      ? branchesEnabled
        ? t(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartWithBranchGitLabLinear',
            'Type a name, #1234, branch, GitHub/GitLab, Linear, or Jira URL'
          )
        : t(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartGitLabLinear',
            'Type a name, #1234, GitHub/GitLab, Linear, or Jira URL'
          )
      : branchesEnabled
        ? t(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartWithBranchGitLab',
            'Type a name, #1234, branch, GitHub, GitLab, or Jira URL'
          )
        : t(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartGitLab',
            'Type a name, #1234, GitHub, GitLab, or Jira URL'
          )
  const crossRepoSwitchIsTaskSource = crossRepoSwitchTarget === 'task-source'
  const crossRepoSwitchTitle = crossRepoSwitchIsTaskSource
    ? t(
        'auto.components.new.workspace.SmartWorkspaceNameField.switchTaskSourceTitle',
        'Switch task source?'
      )
    : t('auto.components.new.workspace.SmartWorkspaceNameField.4bd98f1091', 'Switch project?')
  const formatCrossRepoSwitchDescription = (repoSlug: string): string =>
    crossRepoSwitchIsTaskSource
      ? t(
          'auto.components.new.workspace.SmartWorkspaceNameField.crossRepoDifferentTaskSource',
          'The GitHub URL points to {{repo}}, which is different from the selected task source.',
          { repo: repoSlug }
        )
      : t(
          'auto.components.new.workspace.SmartWorkspaceNameField.crossRepoDifferentProject',
          'The GitHub URL points to {{repo}}, which is different from the selected project.',
          { repo: repoSlug }
        )
  const crossRepoSwitchFallbackLabel = crossRepoSwitchIsTaskSource
    ? t(
        'auto.components.new.workspace.SmartWorkspaceNameField.currentTaskSource',
        'current task source'
      )
    : t('auto.components.new.workspace.SmartWorkspaceNameField.fda67f0b61', 'current project')
  const placeholder = disabled
    ? (disabledPlaceholder ??
      t('auto.components.new.workspace.SmartWorkspaceNameField.unavailable', 'Unavailable'))
    : mode === 'smart'
      ? smartPlaceholder
      : mode === 'github'
        ? t(
            'auto.components.new.workspace.SmartWorkspaceNameField.searchGitHub',
            'Search GitHub PRs and issues'
          )
        : mode === 'gitlab'
          ? t(
              'auto.components.new.workspace.SmartWorkspaceNameField.searchGitLab',
              'Search GitLab MRs and issues'
            )
          : mode === 'branches'
            ? t(
                'auto.components.new.workspace.SmartWorkspaceNameField.searchBranches',
                'Search branches'
              )
            : mode === 'linear'
              ? t(
                  'auto.components.new.workspace.SmartWorkspaceNameField.searchLinear',
                  'Search Linear issues'
                )
              : mode === 'jira'
                ? t(
                    'auto.components.new.workspace.SmartWorkspaceNameField.searchJira',
                    'Search Jira issues or paste an issue URL'
                  )
                : t(
                    'auto.components.new.workspace.SmartWorkspaceNameField.workspaceName',
                    'Workspace name'
                  )

  return {
    crossRepoSwitchTitle,
    formatCrossRepoSwitchDescription,
    crossRepoSwitchFallbackLabel,
    placeholder
  }
}

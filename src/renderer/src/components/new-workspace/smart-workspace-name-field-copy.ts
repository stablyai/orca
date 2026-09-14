import { translate } from '@/i18n/i18n'
import type { SmartNameMode } from './smart-workspace-source-results'

export function getSmartWorkspaceNameFieldCopy({
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
}) {
  const smartPlaceholder = repoBackedSourcesDisabled
    ? linearAvailable
      ? translate(
          'auto.components.new.workspace.SmartWorkspaceNameField.placeholderNameOrLinearUrl',
          'Type a name, Linear URL, or Jira URL'
        )
      : translate(
          'auto.components.new.workspace.SmartWorkspaceNameField.placeholderWorkspaceName',
          'Type a workspace name'
        )
    : linearAvailable
      ? branchesEnabled
        ? translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartWithBranchGitLabLinear',
            'Type a name, #1234, branch, GitHub/GitLab, Linear, or Jira URL'
          )
        : translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartGitLabLinear',
            'Type a name, #1234, GitHub/GitLab, Linear, or Jira URL'
          )
      : branchesEnabled
        ? translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartWithBranchGitLab',
            'Type a name, #1234, branch, GitHub, GitLab, or Jira URL'
          )
        : translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartGitLab',
            'Type a name, #1234, GitHub, GitLab, or Jira URL'
          )
  const crossRepoSwitchIsTaskSource = crossRepoSwitchTarget === 'task-source'
  const crossRepoSwitchTitle = crossRepoSwitchIsTaskSource
    ? translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.switchTaskSourceTitle',
        'Switch task source?'
      )
    : translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.4bd98f1091',
        'Switch project?'
      )
  const crossRepoSwitchDescriptionSuffix = crossRepoSwitchIsTaskSource
    ? translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.differentTaskSource',
        ', which is different from the selected task source.'
      )
    : translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.9ef1a7c4b0',
        ', which is different from the selected project.'
      )
  const crossRepoSwitchFallbackLabel = crossRepoSwitchIsTaskSource
    ? translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.currentTaskSource',
        'current task source'
      )
    : translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.fda67f0b61',
        'current project'
      )
  const placeholder = disabled
    ? (disabledPlaceholder ??
      translate('auto.components.new.workspace.SmartWorkspaceNameField.unavailable', 'Unavailable'))
    : mode === 'smart'
      ? smartPlaceholder
      : mode === 'github'
        ? translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.searchGitHub',
            'Search GitHub PRs and issues'
          )
        : mode === 'gitlab'
          ? translate(
              'auto.components.new.workspace.SmartWorkspaceNameField.searchGitLab',
              'Search GitLab MRs and issues'
            )
          : mode === 'branches'
            ? translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.searchBranches',
                'Search branches'
              )
            : mode === 'linear'
              ? translate(
                  'auto.components.new.workspace.SmartWorkspaceNameField.searchLinear',
                  'Search Linear issues'
                )
              : mode === 'jira'
                ? translate(
                    'auto.components.new.workspace.SmartWorkspaceNameField.searchJira',
                    'Search Jira issues or paste an issue URL'
                  )
                : translate(
                    'auto.components.new.workspace.SmartWorkspaceNameField.workspaceName',
                    'Workspace name'
                  )

  return {
    crossRepoSwitchTitle,
    crossRepoSwitchDescriptionSuffix,
    crossRepoSwitchFallbackLabel,
    placeholder
  }
}

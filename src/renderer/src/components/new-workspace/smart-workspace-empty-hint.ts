import { translate } from '@/i18n/i18n'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'

export function translateSmartWorkspaceEmptyHint(mode: SmartNameMode): string {
  switch (mode) {
    case 'smart':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.emptyHintSmart',
        'Start typing to create a name or find a source.'
      )
    case 'github':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.emptyHintGithub',
        'Start typing to search GitHub PRs and issues.'
      )
    case 'gitlab':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.emptyHintGitlab',
        'Start typing to search GitLab MRs and issues.'
      )
    case 'branches':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.emptyHintBranches',
        'No matching branches.'
      )
    case 'linear':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.emptyHintLinear',
        'Start typing to search Linear issues.'
      )
    case 'jira':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.emptyHintJira',
        'Start typing to search Jira issues, or paste an issue URL.'
      )
    case 'text':
      return ''
  }
}

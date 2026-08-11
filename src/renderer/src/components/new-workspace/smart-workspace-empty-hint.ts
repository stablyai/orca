import { translate } from '@/i18n/i18n'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'

export function translateSmartWorkspaceEmptyHint(mode: SmartNameMode): string {
  switch (mode) {
    case 'smart':
      return translate(
        'auto.components.new.workspace.smart.workspace.empty.hint.42997fb707',
        'Start typing to create a name or find a source.'
      )
    case 'github':
      return translate(
        'auto.components.new.workspace.smart.workspace.empty.hint.b2bc38e7d7',
        'Start typing to search GitHub PRs and issues.'
      )
    case 'gitlab':
      return translate(
        'auto.components.new.workspace.smart.workspace.empty.hint.b1418294ea',
        'Start typing to search GitLab MRs and issues.'
      )
    case 'branches':
      return translate(
        'auto.components.new.workspace.smart.workspace.empty.hint.80e7791c93',
        'No matching branches.'
      )
    case 'linear':
      return translate(
        'auto.components.new.workspace.smart.workspace.empty.hint.b4e65d98a6',
        'Start typing to search Linear issues.'
      )
    case 'jira':
      return translate(
        'auto.components.new.workspace.smart.workspace.empty.hint.5ba5d3e516',
        'Start typing to search Jira issues, or paste an issue URL.'
      )
    case 'text':
      return ''
  }
}

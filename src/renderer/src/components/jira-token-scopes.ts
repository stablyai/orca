import { translate } from '@/i18n/i18n'
import type { AtlassianTokenScopeGroup } from './atlassian-token-scope-list'

// Why: the classic scopes cover every Jira platform endpoint Orca calls; the
// board API behind column order accepts only the granular Jira Software scopes.
export function jiraTokenScopeGroups(): AtlassianTokenScopeGroup[] {
  return [
    {
      id: 'required',
      label: translate('auto.components.jira.token.scopes.required', 'Required'),
      scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user']
    },
    {
      id: 'board',
      label: translate(
        'auto.components.jira.token.scopes.boardOptional',
        'Board column order (optional)'
      ),
      scopes: [
        'read:board-scope:jira-software',
        'read:board-scope.admin:jira-software',
        'read:project:jira'
      ]
    }
  ]
}

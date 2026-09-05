import type React from 'react'
import {
  AI_VAULT_SEARCH_SCOPES,
  type AiVaultSearchScope
} from '../../../../shared/ai-vault-session-search-scope'
import { translate } from '@/i18n/i18n'

export function aiVaultSearchScopeLabel(searchScope: AiVaultSearchScope): string {
  switch (searchScope) {
    case 'full':
      return translate('auto.components.right.sidebar.AiVaultPanel.searchScopeFull', 'Full text')
    case 'title':
      return translate('auto.components.right.sidebar.AiVaultPanel.searchScopeTitle', 'Title')
    case 'summary':
      return translate('auto.components.right.sidebar.AiVaultPanel.searchScopeSummary', 'Summary')
    case 'fullWithoutTools':
      return translate(
        'auto.components.right.sidebar.AiVaultPanel.searchScopeWithoutTools',
        'Without tools'
      )
    case 'user':
      return translate('auto.components.right.sidebar.AiVaultPanel.searchScopeUser', 'User')
    case 'assistant':
      return translate(
        'auto.components.right.sidebar.AiVaultPanel.searchScopeAssistant',
        'Assistant'
      )
    case 'errors':
      return translate('auto.components.right.sidebar.AiVaultPanel.searchScopeErrors', 'Errors')
  }
}

export function AiVaultSearchScopeControl({
  searchScope,
  onSearchScopeChange
}: {
  searchScope: AiVaultSearchScope
  onSearchScopeChange: (searchScope: AiVaultSearchScope) => void
}): React.JSX.Element {
  return (
    <select
      value={searchScope}
      aria-label={translate('auto.components.right.sidebar.AiVaultPanel.searchIn', 'Search in')}
      onChange={(event) => {
        onSearchScopeChange(event.target.value as AiVaultSearchScope)
      }}
      className="h-7 w-full rounded-md border border-sidebar-border bg-input/50 px-2 text-[11px] text-foreground outline-none focus-visible:border-sidebar-ring focus-visible:ring-[2px] focus-visible:ring-sidebar-ring/30"
    >
      {AI_VAULT_SEARCH_SCOPES.map((scope) => (
        <option key={scope} value={scope}>
          {aiVaultSearchScopeLabel(scope)}
        </option>
      ))}
    </select>
  )
}

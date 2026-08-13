import type { Repo } from '../../../../shared/types'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getRepositoryAgentSessionRulesSearchEntries(repo: Repo): SettingsSearchEntry[] {
  return [
    {
      title: translate(
        'auto.components.settings.repository.search.agentSessionRules',
        'Agent Session Rules'
      ),
      description: translate(
        'auto.components.settings.repository.search.agentSessionRulesDescription',
        'Project-specific overrides for the rules injected into agent sessions.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.agentSessionRulesKeyword',
          'rules'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.systemPrompt',
          'system prompt'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.graphify',
          'graphify'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.claude', 'claude'),
        ...translateSearchKeyword('auto.components.settings.repository.search.codex', 'codex')
      ]
    }
  ]
}

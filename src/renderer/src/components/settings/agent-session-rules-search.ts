import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAgentSessionRulesPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.agentSessionRules.search.title',
      'Agent Session Rules'
    ),
    description: translate(
      'auto.components.settings.agentSessionRules.search.description',
      'Custom rules for supported agent launches, plus per-repo overrides.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agentSessionRules.search.rules', 'rules'),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionRules.search.systemPrompt',
        'system prompt'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionRules.search.instructions',
        'instructions'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionRules.search.graphify',
        'graphify'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionRules.search.claude',
        'claude'
      ),
      ...translateSearchKeyword('auto.components.settings.agentSessionRules.search.codex', 'codex'),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionRules.search.agentsMd',
        'AGENTS.md'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionRules.search.custom',
        'custom'
      )
    ]
  }
])

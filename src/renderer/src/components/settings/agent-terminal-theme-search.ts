import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAgentTerminalThemeSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.agent_themes.title',
      'Agent terminal themes'
    ),
    description: translate(
      'auto.components.settings.terminal.search.agent_themes.description',
      'Override the global terminal theme for a specific agent.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.0ce176909a', 'theme'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.agent_themes.keyword_agent',
        'agent'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.agent_themes.keyword_inherit',
        'inherit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.agent_themes.keyword_per_agent',
        'per-agent',
        {
          aliases: ['agent theme', 'claude', 'codex', 'cursor', 'grok']
        }
      )
    ]
  }
])

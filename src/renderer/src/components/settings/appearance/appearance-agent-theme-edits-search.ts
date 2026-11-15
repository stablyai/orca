import type { SettingsSearchEntry } from '../search/settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getAgentThemeEditsEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.agentThemeEdits.title', 'Let agents edit the theme'),
    description: translate(
      'settings.appearance.agentThemeEdits.description',
      'Agents in your terminals can preview theme changes with `orca theme`. Nothing is kept until you press Keep.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.appearance.agentThemeEdits.keywords.agent', 'agent'),
      ...translateSearchKeyword('settings.appearance.agentThemeEdits.keywords.theme', 'theme'),
      ...translateSearchKeyword('settings.appearance.agentThemeEdits.keywords.colors', 'colors')
    ]
  }
])

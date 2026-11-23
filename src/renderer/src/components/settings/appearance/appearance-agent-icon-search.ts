import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getAgentIconInTabsEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.agentIconInTabs.title', 'Show agent icon in tabs'),
    description: translate(
      'settings.appearance.agentIconInTabs.description',
      'Show the agent logo on agent tabs. The activity status glyph is always kept.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.appearance.agentIconInTabs.keyword.agent', 'agent', {
        englishOnly: true
      }),
      ...translateSearchKeyword('settings.appearance.agentIconInTabs.keyword.icon', 'icon', {
        englishOnly: true
      }),
      ...translateSearchKeyword('settings.appearance.agentIconInTabs.keyword.tab', 'tab', {
        englishOnly: true
      }),
      ...translateSearchKeyword('settings.appearance.agentIconInTabs.keyword.logo', 'logo', {
        englishOnly: true
      })
    ]
  }
])

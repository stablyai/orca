import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getEmptyWorkspaceSurfaceSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    {
      title: translate('settings.terminal.emptyWorkspace.title', 'When a workspace has no tabs'),
      description: translate(
        'settings.terminal.emptyWorkspace.description',
        'What opens when you open or wake a workspace and nothing is restored.'
      ),
      keywords: [
        ...translateSearchKeyword('settings.terminal.emptyWorkspace.keywordEmpty', 'empty'),
        ...translateSearchKeyword('settings.terminal.emptyWorkspace.keywordWake', 'wake'),
        ...translateSearchKeyword('settings.terminal.emptyWorkspace.keywordSleep', 'sleep'),
        ...translateSearchKeyword('settings.terminal.emptyWorkspace.keywordWorkspace', 'workspace'),
        ...translateSearchKeyword('settings.terminal.emptyWorkspace.keywordTabs', 'tabs')
      ]
    }
  ]
)

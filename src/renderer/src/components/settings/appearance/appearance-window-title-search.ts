import type { SettingsSearchEntry } from '../search/settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getWindowTitleEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.windowTitle.title', 'Show Workspace in Window Title'),
    description: translate(
      'settings.appearance.windowTitle.description',
      'Puts the project, workspace and linked issue in the window title so time trackers can tell them apart. Screen shares and window switchers show it too.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.appearance.search.e5bc35d59e', 'window'),
      ...translateSearchKeyword('settings.appearance.windowTitle.keyword.title', 'title'),
      ...translateSearchKeyword(
        'settings.appearance.windowTitle.keyword.timeTracking',
        'time tracking'
      ),
      ...translateSearchKeyword('settings.appearance.windowTitle.keyword.template', 'template')
    ]
  }
])

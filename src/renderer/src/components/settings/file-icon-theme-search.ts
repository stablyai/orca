import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

/** Build entries on access so settings search reflects runtime locale changes. */
export const getFileIconThemeEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.fileIconTheme.search.title', 'File Icons'),
    description: translate(
      'auto.components.settings.fileIconTheme.search.description',
      'Choose how file type icons appear in the file explorer, search results, and editor tabs.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.fileIconTheme.search.icons',
        'file icons'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.fileIconTheme.search.explorer',
        'file explorer'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.fileIconTheme.search.material',
        'material'
      ),
      ...translateSearchKeyword('auto.components.settings.fileIconTheme.search.classic', 'classic')
    ]
  }
])

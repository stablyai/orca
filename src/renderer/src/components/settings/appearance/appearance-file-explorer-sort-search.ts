import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getFileExplorerSortModeEntry = (t: Translate = translate): SettingsSearchEntry => ({
  title: t('settings.fileExplorerSortMode.title', 'Sort order'),
  description: t(
    'settings.fileExplorerSortMode.description',
    'Show folders before files, after files, or mixed in by name.'
  ),
  keywords: [
    ...translateSearchKeyword('settings.fileExplorerSortMode.keywords.sort', 'sort', undefined, t),
    ...translateSearchKeyword(
      'settings.fileExplorerSortMode.keywords.foldersFirst',
      'folders first',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.fileExplorerSortMode.keywords.filesFirst',
      'files first',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.fileExplorerSortMode.keywords.fileExplorer',
      'file explorer',
      undefined,
      t
    )
  ]
})

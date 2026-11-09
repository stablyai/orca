import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getFileExplorerCompactFoldersEntry = (
  t: Translate = translate
): SettingsSearchEntry => ({
  title: t('settings.fileExplorerCompactFolders', 'Compact Folders'),
  description: t(
    'settings.fileExplorerCompactFoldersDescription',
    'Show nested folders that each contain only one folder on a single row, like com/example/app.'
  ),
  keywords: [
    ...translateSearchKeyword(
      'settings.fileExplorerCompactFoldersKeywords.compact',
      'compact',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.fileExplorerCompactFoldersKeywords.nestedFolders',
      'nested folders',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.fileExplorerCompactFoldersKeywords.packages',
      'packages',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.fileExplorerCompactFoldersKeywords.fileExplorer',
      'file explorer',
      undefined,
      t
    )
  ]
})

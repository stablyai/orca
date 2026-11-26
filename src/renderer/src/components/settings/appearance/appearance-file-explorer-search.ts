import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getExplorerRevealActiveFileEntry = (
  t: Translate = translate
): SettingsSearchEntry => ({
  title: t('settings.explorerRevealActiveFile', 'Reveal active file'),
  description: t(
    'settings.explorerRevealActiveFileDescription',
    'When the active editor file changes, select it in the file explorer and scroll it into view.'
  ),
  keywords: [
    ...translateSearchKeyword(
      'settings.explorerRevealActiveFileKeywords.reveal',
      'reveal',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.explorerRevealActiveFileKeywords.autoReveal',
      'auto reveal',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.explorerRevealActiveFileKeywords.activeFile',
      'active file',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.explorerRevealActiveFileKeywords.follow',
      'follow',
      undefined,
      t
    ),
    ...translateSearchKeyword(
      'settings.followSymlinkedDirectoriesKeywords.fileExplorer',
      'file explorer',
      undefined,
      t
    )
  ]
})

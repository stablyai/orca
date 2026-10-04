import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getLineBlameStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'line-blame',
    title: translate('auto.components.settings.appearance.search.lineBlameTitle', 'Line Author'),
    description: translate(
      'auto.components.settings.appearance.search.lineBlameDescription',
      'Show who last changed the current line in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.bce3ac317a', 'git'),
      // Why: `blame` is the literal git subcommand, typed in English whatever the
      // UI language, so there is no localized variant worth indexing.
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.lineBlameKeywordBlame',
        'blame',
        { englishOnly: true }
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.lineBlameKeywordAuthor',
        'author'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.lineBlameKeywordLine',
        'line'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.lineBlameToggleDescription',
      'Show the author and date of the last commit that changed the line at your cursor.'
    )
  }
}

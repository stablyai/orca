import type { StatusBarItem } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getGitBlameStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'git-blame',
    title: translate('settings.appearance.statusBar.gitBlameTitle', 'Git blame'),
    description: translate(
      'settings.appearance.statusBar.gitBlameDescription',
      'Show who last changed the cursor line in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('settings.appearance.statusBar.gitBlameKeywordBlame', 'blame'),
      ...translateSearchKeyword('settings.appearance.statusBar.gitBlameKeywordAuthor', 'author'),
      ...translateSearchKeyword('settings.appearance.statusBar.gitBlameKeywordCommit', 'commit')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.gitBlameToggleDescription',
      'Show the author and age of the cursor line. Click it to open the commit.'
    )
  }
}

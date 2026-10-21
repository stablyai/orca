import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getCursorStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'cursor',
    title: translate('auto.components.settings.appearance.search.cursor.title', 'Cursor Usage'),
    description: translate(
      'auto.components.settings.appearance.search.cursor.description',
      'Show monthly Cursor plan usage from the Cursor sign-in on this computer.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.cursor.kw.cursor',
        'cursor'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.cursorToggleDescription',
      'Show Cursor plan usage when signed in through cursor-agent or Cursor IDE.'
    )
  }
}

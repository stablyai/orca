import type { StatusBarItem } from '../../../../shared/types'
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
    title: translate('auto.components.settings.appearance.search.cursorUsageTitle', 'Cursor Usage'),
    description: translate(
      'auto.components.settings.appearance.search.cursorUsageDescription',
      'Show Cursor included usage from the signed-in Cursor IDE account.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.cursorUsageKeyword',
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
      'Show Cursor included usage when signed in via the Cursor IDE.'
    )
  }
}

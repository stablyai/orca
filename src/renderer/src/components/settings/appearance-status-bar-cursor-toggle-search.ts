import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
/** Settings search entry for the Cursor status-bar usage toggle. */
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
      'Show Cursor monthly plan usage from cursor-agent or Cursor IDE sign-in.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.cursorKeyword',
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
      'Show Cursor monthly plan usage from cursor-agent or Cursor IDE sign-in.'
    )
  }
}

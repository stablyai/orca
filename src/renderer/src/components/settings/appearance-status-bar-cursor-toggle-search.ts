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
    title: translate(
      'auto.components.settings.appearance.status.bar.cursor.toggle.search.title',
      'Cursor Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.status.bar.cursor.toggle.search.description',
      'Show Cursor Models, Other Models, and Grok Bot usage from the signed-in Cursor session.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.cursor.toggle.search.keywordStatusBar',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.cursor.toggle.search.keywordCursor',
        'cursor'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.cursor.toggle.search.keywordUsage',
        'usage'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.cursor.toggle.search.keywordSubscription',
        'subscription'
      )
    ],
    toggleDescription: translate(
      'auto.components.settings.appearance.status.bar.cursor.toggle.search.toggleDescription',
      'Show Cursor subscription usage when signed in with Cursor or cursor-agent.'
    )
  }
}

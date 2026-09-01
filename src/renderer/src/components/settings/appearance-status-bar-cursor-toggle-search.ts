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
      'auto.components.settings.appearance.status.bar.cursor.toggle.search.b7d8e5d878',
      'Cursor Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.status.bar.cursor.toggle.search.5e2a8cfb86',
      'Show Cursor Models, Other Models, and Grok Bot usage from the signed-in Cursor session.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.cursor.toggle.search.c34d783d64',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.cursor.toggle.search.c9cd9fe8d2',
        'cursor'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.cursor.toggle.search.fbb8436949',
        'usage'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.cursor.toggle.search.6843b85f37',
        'subscription'
      )
    ],
    toggleDescription: translate(
      'auto.components.settings.appearance.status.bar.cursor.toggle.search.4036697d97',
      'Show Cursor subscription usage when signed in with Cursor or cursor-agent.'
    )
  }
}

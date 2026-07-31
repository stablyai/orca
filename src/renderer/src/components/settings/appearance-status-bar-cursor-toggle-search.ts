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
    title: translate('auto.components.settings.appearance.search.c8f3e2a1b5', 'Cursor Usage'),
    description: translate(
      'auto.components.settings.appearance.search.b7d1c0f4a6',
      'Show Cursor plan usage from Cursor IDE sign-in.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.a6b9f8e3d4', 'cursor'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.cursorToggleDescription',
      'Show Cursor subscription plan usage when signed in via Cursor IDE.'
    )
  }
}

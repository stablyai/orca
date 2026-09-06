import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getMinimaxStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'minimax',
    title: translate('auto.components.settings.appearance.search.0f08f6b483', 'MiniMax Usage'),
    description: translate(
      'auto.components.settings.appearance.search.e46178eb1b',
      'Show MiniMax subscription usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.d16378a88f', 'minimax'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.d9e7cef86f', 'cookie'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.25e51b62ee',
        'rate limit'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.minimaxToggleDescription',
      'Show MiniMax subscription usage for the active workspace.'
    )
  }
}

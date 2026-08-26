import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getNousStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'nous',
    title: translate('settings.appearance.statusBar.nousToggleTitle', 'Nous Usage'),
    description: translate(
      'settings.appearance.statusBar.nousToggleSearchDescription',
      'Show Nous Portal subscription usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'settings.appearance.statusBar.nousToggleSearchKeywordNous',
        'nous'
      ),
      ...translateSearchKeyword(
        'settings.appearance.statusBar.nousToggleSearchKeywordHermes',
        'hermes'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      ),
      ...translateSearchKeyword(
        'settings.appearance.statusBar.nousToggleSearchKeywordCredits',
        'credits'
      ),
      ...translateSearchKeyword(
        'settings.appearance.statusBar.nousToggleSearchKeywordBalance',
        'balance'
      ),
      ...translateSearchKeyword(
        'settings.appearance.statusBar.nousToggleSearchKeywordPortal',
        'portal'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.nousToggleDescription',
      'Show Nous Portal subscription credit usage when signed in via Hermes.'
    )
  }
}

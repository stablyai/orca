import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

/**
 * The Appearance search entry for the Kiro usage status item.
 * @returns The toggle's title, description, and search keywords.
 */
export function getKiroStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'kiro',
    title: translate('auto.components.settings.appearance.search.kiroUsageTitle', 'Kiro Usage'),
    description: translate(
      'auto.components.settings.appearance.search.kiroUsageDescription',
      'Show Kiro monthly credit usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.kiro', 'kiro'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.credits', 'credits')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.kiroToggleDescription',
      'Show Kiro monthly credit usage when signed in via kiro-cli.'
    )
  }
}

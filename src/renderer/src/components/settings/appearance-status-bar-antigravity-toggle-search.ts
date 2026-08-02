import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getAntigravityStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'antigravity',
    title: translate(
      'auto.components.settings.appearance.search.antigravityUsageTitle',
      'Antigravity Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.search.antigravityUsageDescription',
      'Show Antigravity subscription usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.antigravityKeyword',
        'antigravity'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.51b0ccd6a2', 'google')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.antigravityToggleDescription',
      'Show Antigravity subscription usage for the active workspace.'
    )
  }
}

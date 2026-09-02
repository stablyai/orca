import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getKimiStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'kimi',
    title: translate('auto.components.settings.appearance.search.3a6c028ea8', 'Kimi Usage'),
    description: translate(
      'auto.components.settings.appearance.search.c927a155d5',
      'Show Kimi subscription usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.40e5c3c285', 'kimi'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.35565867cb', 'moonshot')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.kimiToggleDescription',
      'Show Kimi subscription usage for the active workspace.'
    )
  }
}
